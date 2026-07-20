// ══════════════════════════════════════════════════════════
// Admin Agent — entry point
// ══════════════════════════════════════════════════════════
// Boots a second Telegram bot (polling) on ADMIN_BOT_TOKEN. Only
// ADMIN_IDS may interact with it. Runs in-process (shares Redis,
// Postgres, log buffer, analytics) — no IPC overhead.
//
// Message flow:
//   user msg → load conv → runLLM (with tools) → if tool_call:
//     → read tool → run immediately, append result, loop LLM again
//     → write tool → store pending, ask confirm
//     → confirm msg → execute pending write, append result, loop LLM
//   → LLM final text → send to user, save conv.

import TelegramBot from "node-telegram-bot-api";
import { L }       from "../logger.js";
import { ADMIN_IDS } from "../config.js";
import { SYSTEM_PROMPT, CONFIRM_PHRASES_RE, CANCEL_PHRASES_RE } from "./prompt.js";
import { runLLM, runLLMStream, type LLMMessage, type LLMToolCall } from "./llm.js";
import { getToolDefinitions, getToolDefinitionsForNames, findTool, type ToolRunCtx } from "./tools.js";
import { inferSkill, toolsForSkill, skillLabelAr, type AgentSkill } from "./skills.js";
import { loadConversation, saveConversation, clearConversation } from "./conversation.js";
import { seedDefaultsIfEmpty, ensureCloudflarePrimary, ensureAgentRouterProviders } from "./llmProviders.js";
import {
  createBurstGuard, inspectCall, recordExecution, recordRefusal,
  refusalToolContent, callSignature, isOverTokenBudget,
  MAX_REFUSALS_BEFORE_BAIL,
} from "./loopGuards.js";
import { buildMemoryContext } from "./memory.js";
import { startProactiveMonitoring, stopProactiveMonitoring } from "./proactive.js";
import { startScheduleRunner, stopScheduleRunner } from "./tools.js";
import { recordAdminAudit } from "../adminAudit.js";
import { canWrite, assertCanRunTool, getAdminRole, isAdminAny } from "../adminRoles.js";
import { recordLatency, incrObs, withLatency } from "../observability.js";

// ── config ────────────────────────────────────────────────
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "";

// MAX_LLM_LOOPS: hard ceiling on tool-call iterations per admin
// message. Bumped from 12 → 24 alongside the loopGuards (duplicate
// detector + token-budget guard) which short-circuit pathological
// loops far earlier; the higher ceiling is now only there to let
// legitimate long admin workflows (audit chains, multi-tool reports)
// run to completion.
const MAX_LLM_LOOPS   = 32; // v4: longer diagnostic chains
const MAX_TOOL_OUTPUT  = 7000; // v4 playbooks can be denser

// ── pending writes (one per admin) ────────────────────────
interface PendingWrite {
  toolName:  string;
  args:      Record<string, unknown>;
  summary:   string; // LLM's description shown to admin
  ts:        number;
}
const pendingWrites = new Map<string, PendingWrite>();

// ── helpers ───────────────────────────────────────────────
function truncate(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length > max ? s.slice(0, max) + "\n…[truncated]" : s;
}

function escMd(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ── LiveStatus — real-time Telegram message updates ───────
// Manages a single "status" message that gets edited as the agent
// thinks and works. Shows tool activity, think-tool output, and
// finally streams the response text progressively.

const EDIT_INTERVAL_MS = 1200;  // min gap between Telegram edits (rate-limit safety)
const STREAM_EDIT_MS   = 800;   // slightly faster for final response streaming

class LiveStatus {
  private msgId: number | null = null;
  private chatId: number;
  private bot: TelegramBot;
  private lastEdit = 0;
  private sections: string[] = [];

  constructor(bot: TelegramBot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  /** Send the initial status message. */
  async init(): Promise<void> {
    try {
      const msg = await this.bot.sendMessage(
        this.chatId,
        "🧠 *بفكر\\.\\.\\.*",
        { parse_mode: "MarkdownV2" },
      );
      this.msgId = msg.message_id;
    } catch {
      // Fallback without formatting
      const msg = await this.bot.sendMessage(this.chatId, "🧠 بفكر...");
      this.msgId = msg.message_id;
    }
  }

  /** Show a think-tool thought. */
  async showThought(thought: string): Promise<void> {
    this.sections.push(`💭 ${thought}`);
    await this.flush();
  }

  /** Show a tool being executed. */
  async showToolCall(toolName: string): Promise<void> {
    this.sections.push(`🔧 ${toolName}...`);
    await this.flush();
  }

  /** Update the tool line with a brief result. */
  async showToolResult(toolName: string, ok: boolean): Promise<void> {
    // Replace the last "🔧 toolName..." with result indicator
    let idx = -1;
    for (let i = this.sections.length - 1; i >= 0; i--) {
      if (this.sections[i].startsWith(`🔧 ${toolName}`)) { idx = i; break; }
    }
    if (idx >= 0) {
      this.sections[idx] = ok
        ? `✅ ${toolName}`
        : `⚠️ ${toolName}`;
    }
    await this.flush();
  }

  /** Flush accumulated sections to the Telegram message. */
  private async flush(): Promise<void> {
    if (!this.msgId) return;
    const now = Date.now();
    if (now - this.lastEdit < EDIT_INTERVAL_MS) return;
    const text = this.sections.join("\n") || "🧠 بفكر...";
    try {
      await this.bot.editMessageText(text, {
        chat_id:    this.chatId,
        message_id: this.msgId,
      });
      this.lastEdit = Date.now();
    } catch { /* Telegram rejects edits with unchanged text — safe to ignore */ }
  }

  /** Force-flush regardless of rate-limit timer. */
  async forceFlush(): Promise<void> {
    if (!this.msgId) return;
    const text = this.sections.join("\n") || "🧠 بفكر...";
    try {
      await this.bot.editMessageText(text, {
        chat_id:    this.chatId,
        message_id: this.msgId,
      });
      this.lastEdit = Date.now();
    } catch {}
  }

  /**
   * Stream a final response into the status message, editing it
   * progressively as text arrives.
   */
  async streamFinalResponse(
    messages: LLMMessage[],
  ): Promise<{ fullText: string; providerUsed: string; ms: number }> {
    // Clear previous sections and set a "typing" header
    this.sections = [];
    let accumulated = "";
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    const msgId = this.msgId;

    const doEdit = async () => {
      if (!msgId || !accumulated) return;
      try {
        // Try Markdown first, fall back to plain text
        await this.bot.editMessageText(accumulated, {
          chat_id:    this.chatId,
          message_id: msgId,
          parse_mode: "Markdown",
        });
      } catch {
        try {
          await this.bot.editMessageText(accumulated, {
            chat_id:    this.chatId,
            message_id: msgId,
          });
        } catch {}
      }
    };

    const result = await runLLMStream(messages, (chunk) => {
      accumulated += chunk;
      // Debounce edits to respect Telegram rate limits
      if (!editTimer) {
        editTimer = setTimeout(async () => {
          editTimer = null;
          await doEdit();
        }, STREAM_EDIT_MS);
      }
    });

    // Final edit with the complete text
    if (editTimer) clearTimeout(editTimer);
    accumulated = result.fullText;
    await doEdit();

    return result;
  }

  /** Delete the status message (e.g. if we want to send a new one). */
  async delete(): Promise<void> {
    if (!this.msgId) return;
    try {
      await this.bot.deleteMessage(this.chatId, this.msgId);
    } catch {}
    this.msgId = null;
  }

  getMsgId(): number | null { return this.msgId; }
}

// ── typewriterSend — progressively reveal text ────────────
// Splits already-fetched text into ~5 chunks and edits the Telegram
// message in place so the admin sees it appear piece by piece.
// Short texts (< 80 chars) are sent at once (no animation overhead).

const TW_CHUNKS     = 5;     // number of progressive reveals
const TW_DELAY_MS   = 600;   // gap between edits

async function typewriterSend(
  bot: TelegramBot,
  chatId: number,
  text: string,
): Promise<void> {
  if (text.length < 80) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch {
      await bot.sendMessage(chatId, text);
    }
    return;
  }

  // Send the first chunk immediately
  const chunkSize = Math.ceil(text.length / TW_CHUNKS);
  let shown = text.slice(0, chunkSize) + " ▍";
  let sentMsg: TelegramBot.Message;
  try {
    sentMsg = await bot.sendMessage(chatId, shown);
  } catch {
    // If even the first send fails, just send full text
    await bot.sendMessage(chatId, text);
    return;
  }
  const msgId = sentMsg.message_id;

  // Progressively reveal more text
  for (let i = 2; i <= TW_CHUNKS; i++) {
    await new Promise(r => setTimeout(r, TW_DELAY_MS));
    const end = Math.min(i * chunkSize, text.length);
    const cursor = end < text.length ? " ▍" : "";
    shown = text.slice(0, end) + cursor;
    try {
      await bot.editMessageText(shown, {
        chat_id:    chatId,
        message_id: msgId,
      });
    } catch { /* same text or rate limit — skip */ }
  }

  // Final edit with the complete text + Markdown
  try {
    await bot.editMessageText(text, {
      chat_id:    chatId,
      message_id: msgId,
      parse_mode: "Markdown",
    });
  } catch {
    try {
      await bot.editMessageText(text, {
        chat_id:    chatId,
        message_id: msgId,
      });
    } catch {}
  }
}

// ── startAdminAgent ───────────────────────────────────────

let _started = false;

export async function startAdminAgent(): Promise<void> {
  if (_started) return;
  _started = true;

  if (!ADMIN_BOT_TOKEN) {
    L.info("adminAgent", "ADMIN_BOT_TOKEN not set — admin agent disabled");
    return;
  }
  if (ADMIN_IDS.size === 0) {
    L.warn("adminAgent", "ADMIN_IDS empty — admin agent disabled (no allowed users)");
    return;
  }

  const bot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });

  // Seed the dynamic LLM provider registry from env vars on first boot.
  // After this, the admin can manage providers via add/update/remove
  // tools from Telegram — env vars become a fallback for the table.
  try {
    const r = await seedDefaultsIfEmpty();
    if (r.seeded > 0) L.info("adminAgent", `Seeded ${r.seeded} default LLM providers from env`);
  } catch (e) {
    L.warn("adminAgent", `seedDefaultsIfEmpty failed: ${String(e).slice(0, 80)}`);
  }

  // Idempotent: upsert Cloudflare provider as primary if keys are
  // present and admin hasn't manually configured one. Lets prod
  // installs that were seeded before Cloudflare was a default still
  // pick it up on next boot.
  try {
    const cf = await ensureCloudflarePrimary();
    if (cf.added) L.info("adminAgent", `Cloudflare provider added at priority ${cf.priority}`);
  } catch (e) {
    L.warn("adminAgent", `ensureCloudflarePrimary failed: ${String(e).slice(0, 80)}`);
  }

  // Idempotent: upsert AgentRouter (agentrouter.org) provider rows for any
  // model in AGENTROUTER_MODELS that the admin doesn't already have. Skipped
  // when AGENTROUTER_API_KEY is missing.
  try {
    const ar = await ensureAgentRouterProviders();
    if (ar.added.length > 0) L.info("adminAgent", `AgentRouter providers added: ${ar.added.join(", ")}`);
  } catch (e) {
    L.warn("adminAgent", `ensureAgentRouterProviders failed: ${String(e).slice(0, 80)}`);
  }

  try {
    const me = await bot.getMe();
    L.info("adminAgent", `Admin agent started: @${me.username} (${me.id})`);
  } catch (e) {
    L.error("adminAgent", `getMe failed: ${String(e).slice(0, 80)}`);
  }

  // ── Phase 3: Start proactive monitoring ──
  startProactiveMonitoring(bot);

  // ── Phase 5: Start schedule runner ──
  startScheduleRunner();

  // ── /start ──────────────────────────────────
  bot.onText(/^\/start$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) {
      await bot.sendMessage(msg.chat.id, "هذه الواجهة للإدارة فقط.");
      return;
    }
    await bot.sendMessage(msg.chat.id,
      "🤖 *وكيل إدارة رفيق* — v4\n\n" +
      "وكيل عمليات v4: playbooks · مهارات · حوادث · مقارنة · تنفيذ بعد التأكيد.\n\n" +
      "أمثلة:\n" +
      "• إيه حال رفيق؟\n" +
      "• ليه التسليم بطيء؟\n" +
      "• عطّل الصور / ارفع الحد اليومي\n" +
      "• احظر user X · backup الآن\n\n" +
      "أوامر:\n" +
      "/reset — امسح المحادثة\n" +
      "/status — لقطة سريعة\n" +
      "/plan — الخطة الحالية\n" +
      "/help — قائمة الأدوات",
      { parse_mode: "Markdown" },
    );
  });

  // ── /reset ──────────────────────────────────
  bot.onText(/^\/reset$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) return;
    await clearConversation(uid);
    pendingWrites.delete(uid);
    await bot.sendMessage(msg.chat.id, "🗑 تم مسح المحادثة. ابدأ من جديد.");
  });

  // ── /status — quick health overview ─────────
  bot.onText(/^\/status$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) return;
    await handleMessage(bot, msg, "ايه حال البوت دلوقتي؟ (ملخص سريع)");
  });

  bot.onText(/^\/brief$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) return;
    await handleMessage(bot, msg, "أعطني موجز عمليات كامل الآن: استخدم auto_ops_brief ثم لخّص بالعربية.");
  });
  bot.onText(/^\/diagnose$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) return;
    await handleMessage(bot, msg, "شغّل playbook health_full ثم source_outage إن لزم وشخص المشاكل الجذرية.");
  });
  bot.onText(/^\/ops$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) return;
    await handleMessage(bot, msg, "حالة العمليات: طابور + DLQ + تسليم + مصادر ضعيفة + صيانة.");
  });
  bot.onText(/^\/report$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) return;
    await handleMessage(bot, msg, "أنشئ تقرير يومي مقارن: daily_brief + compare_periods ثم insights.");
  });


  // ── /help ───────────────────────────────────
  bot.onText(/^\/help$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) return;
    const defs = getToolDefinitions();
    const readTools  = defs.filter(d => !findTool(d.function.name)?.isWrite).map(d => `• \`${d.function.name}\` — ${d.function.description}`);
    const writeTools = defs.filter(d => findTool(d.function.name)?.isWrite).map(d => `• \`${d.function.name}\` — ${d.function.description}`);
    const text =
      `🔍 *Read tools* (${readTools.length}):\n${readTools.join("\n")}\n\n` +
      `✏️ *Write tools* (${writeTools.length}) — بتأكيد:\n${writeTools.join("\n")}\n\n` +
      `أوامر:\n/reset — امسح المحادثة\n/status — لقطة سريعة`;
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  });

  // ── catch-all message handler ───────────────
  bot.on("message", async (msg) => {
    // Skip command messages (already handled above)
    if (msg.text && msg.text.startsWith("/")) return;
    const uid = String(msg.from?.id ?? "");
    if (!isAdminAny(uid) && !ADMIN_IDS.has(uid)) {
      await bot.sendMessage(msg.chat.id, "هذه الواجهة للإدارة فقط.");
      return;
    }
    const text = msg.text?.trim();
    if (!text) return;
    await handleMessage(bot, msg, text);
  });
}


// ── Parallel read-tool batch (v3) ─────────────────────────
// OpenClaw-style: when the model emits multiple independent
// read tools in one turn, execute them concurrently (except
// think/reflect which update LiveStatus first).
async function executeReadTool(
  tool: NonNullable<ReturnType<typeof findTool>>,
  args: Record<string, unknown>,
  ctx: ToolRunCtx,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const result = await tool.run(args, ctx);
    return { ok: true, result };
  } catch (e1) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const result = await tool.run(args, ctx);
      return { ok: true, result };
    } catch (e2) {
      return {
        ok: false,
        error: String(e2 instanceof Error ? e2.message : e2).slice(0, 300),
      };
    }
  }
}

// ══════════════════════════════════════════════════════════
// Core message handler — orchestrates LLM + tool loop
// ══════════════════════════════════════════════════════════
// PARALLEL_TOOL_BATCH_V3

async function handleMessage(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  userText: string,
): Promise<void> {
  const chatId = msg.chat.id;
  const uid    = String(msg.from?.id ?? "");
  const ctx: ToolRunCtx = { userId: uid };

  // ── confirm/cancel flow for pending writes ──
  const pending = pendingWrites.get(uid);
  if (pending) {
    if (CONFIRM_PHRASES_RE.test(userText)) {
      pendingWrites.delete(uid);
      await bot.sendChatAction(chatId, "typing");
      const tool = findTool(pending.toolName);
      if (!tool) {
        await bot.sendMessage(chatId, "⚠ Tool غير موجود.");
        return;
      }
      try {
        const result = await tool.run(pending.args, ctx);
        try {
          await recordAdminAudit(uid, `agent:confirm ${pending.toolName}`);
        } catch { /* non-fatal */ }
        const resultStr = truncate(JSON.stringify(result, null, 2));
        await bot.sendMessage(
          chatId,
          `✅ تم تنفيذ *${escMd(pending.toolName)}* — أُكمل التحليل…`,
          { parse_mode: "Markdown" },
        ).catch(async () => {
          await bot.sendMessage(chatId, `✅ تم تنفيذ ${pending.toolName} — أُكمل التحليل…`);
        });
        // v4: re-enter agent loop so model verifies + explains (not raw JSON dump)
        const history = await loadConversation(uid);
        history.push(
          { role: "assistant", content: pending.summary },
          {
            role: "user",
            content:
              `تم التأكيد ونُفّذ ${pending.toolName} بنجاح.
` +
              `النتيجة:
${resultStr}

` +
              `لخّص ما تم، تحقّق إن لزم بأدوات قراءة، واقترح الخطوة التالية.`,
          },
        );
        await saveConversation(uid, history);
        await handleMessage(
          bot,
          msg,
          `تم تنفيذ ${pending.toolName}. حلّل النتيجة وقدّم ملخصاً تنفيذياً. لا تطلب تأكيداً مجدداً لنفس العملية.`,
        );
        return;
      } catch (e) {
        await bot.sendMessage(chatId, `❌ فشل: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
      }
      return;
    }
    if (CANCEL_PHRASES_RE.test(userText)) {
      pendingWrites.delete(uid);
      await bot.sendMessage(chatId, "↩ تم الإلغاء.");
      return;
    }
    // Neither confirm nor cancel — clear pending and process as new message
    pendingWrites.delete(uid);
  }

  // ── LiveStatus: show agent activity in real-time ──
  const status = new LiveStatus(bot, chatId);
  await status.init();

  // ── build messages array (with memory + skill routing v4) ──
  const history = await loadConversation(uid);
  const memoryCtx = await buildMemoryContext(uid);
  const skill: AgentSkill = inferSkill(userText);
  const skillHint =
    `\n\n# مهارة هذه الرسالة\n` +
    `المهارة النشطة: *${skillLabelAr(skill)}* (\`${skill}\`). ` +
    `فضّل أدوات هذه المهارة و playbooks. لا تخرج عنها بلا داعٍ.`;
  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + memoryCtx + skillHint },
    ...history,
    { role: "user", content: userText },
  ];

  // Skill-scoped tools (core always included). Fall back to full set if too small.
  const allowed = toolsForSkill(skill);
  let toolDefs = getToolDefinitionsForNames(allowed);
  if (toolDefs.length < 12) toolDefs = getToolDefinitions();

  // ── per-turn loop guards ────────────────────
  const burstGuard = createBurstGuard();
  let abortedReason: "loop_budget" | "token_budget" | "refusal_storm" | null = null;

  L.info("adminAgent", `turn skill=${skill} tools=${toolDefs.length} role=${getAdminRole(uid)}`);
  incrObs("agent_turns").catch(() => {});
  const turnT0 = Date.now();
  // ── tool loop ───────────────────────────────
  let loops = 0;
  while (loops < MAX_LLM_LOOPS) {
    loops++;

    if (isOverTokenBudget(messages)) {
      abortedReason = "token_budget";
      L.warn(
        "adminAgent",
        `token budget exceeded at iter ${loops}; bailing to forced-final-answer`,
      );
      break;
    }
    let res;
    try {
      res = await runLLM(messages, toolDefs);
    } catch (e) {
      const errMsg = String(e instanceof Error ? e.message : e).slice(0, 300);
      L.error("adminAgent", "LLM call failed", { err: errMsg });
      await status.delete();
      await bot.sendMessage(chatId, `⚠ خطأ من الـ AI: ${errMsg}`);
      return;
    }

    // If no tool calls → progressively reveal the final response
    if (res.toolCalls.length === 0) {
      const reply = res.content || "(لا رد)";
      await status.forceFlush();
      await status.delete();
      await typewriterSend(bot, chatId, reply);
      // Save conversation
      history.push({ role: "user", content: userText });
      history.push({ role: "assistant", content: reply });
      await saveConversation(uid, history);
      recordLatency("agent_turn", Date.now() - turnT0).catch(() => {});
      return;
    }

    // Process tool calls
    messages.push({
      role:       "assistant",
      content:    res.content,
      tool_calls: res.toolCalls,
    });

    // PARALLEL_TOOL_BATCH_V3 — partition write vs read tool calls
    const writeCalls: typeof res.toolCalls = [];
    const readCalls: typeof res.toolCalls = [];
    for (const tc of res.toolCalls) {
      const tool = findTool(tc.function.name);
      if (tool?.isWrite) writeCalls.push(tc);
      else readCalls.push(tc);
    }

    // Read path first (parallel): gather context before any write confirm
    type Prepared = {
      tc: (typeof res.toolCalls)[0];
      tool: NonNullable<ReturnType<typeof findTool>>;
      args: Record<string, unknown>;
      sig: string;
    };
    const prepared: Prepared[] = [];
    for (const tc of readCalls) {
      const tool = findTool(tc.function.name);
      let args: Record<string, unknown>;
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }
      if (!tool) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `unknown tool: ${tc.function.name}` }),
        });
        continue;
      }
      const sig = callSignature(tool.name, args);
      const decision = inspectCall(burstGuard, sig);
      if (!decision.allow) {
        recordRefusal(burstGuard, sig);
        L.info(
          "adminAgent",
          `duplicate tool call refused: ${tool.name} (${decision.reason}, count=${decision.count})`,
        );
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: refusalToolContent(tool.name, decision),
        });
        continue;
      }
      prepared.push({ tc, tool, args, sig });
    }

    for (const item of prepared) {
      if (item.tool.name === "think") {
        const thought = typeof item.args.thought === "string" ? item.args.thought : "";
        await status.showThought(thought);
      } else if (item.tool.name === "reflect") {
        await status.showToolCall("reflect");
      } else {
        await status.showToolCall(item.tool.name);
      }
    }

    const results = await Promise.all(
      prepared.map(async (item) => {
        const outcome = await executeReadTool(item.tool, item.args, ctx);
        incrObs("agent_tools").catch(() => {});
        recordExecution(burstGuard, item.sig);
        return { item, outcome };
      }),
    );

    for (const { item, outcome } of results) {
      if (!outcome.ok) {
        messages.push({
          role: "tool",
          tool_call_id: item.tc.id,
          content: JSON.stringify({
            error: outcome.error,
            hint: "الأداة فشلت بعد محاولتين. جرّب أداة بديلة أو صيغة مختلفة.",
          }),
        });
        if (item.tool.name !== "think") await status.showToolResult(item.tool.name, false);
      } else {
        messages.push({
          role: "tool",
          tool_call_id: item.tc.id,
          content: truncate(JSON.stringify(outcome.result)),
        });
        if (item.tool.name !== "think") await status.showToolResult(item.tool.name, true);
      }
    }

    // Write tools require confirm — first write only (after reads in same turn)
    if (writeCalls.length > 0) {
      const tc = writeCalls[0];
      const tool = findTool(tc.function.name);
      if (!tool) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `unknown tool: ${tc.function.name}` }),
        });
      } else {
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }
        try {
          assertCanRunTool(uid, tool.name, true);
        } catch (e) {
          await status.delete();
          await bot.sendMessage(chatId, `🚫 ${String(e instanceof Error ? e.message : e)}`);
          return;
        }
        const summary = res.content || `تنفيذ ${tool.name}(${JSON.stringify(args)})`;
        pendingWrites.set(uid, { toolName: tool.name, args, summary, ts: Date.now() });
        for (const extra of writeCalls.slice(1)) {
          messages.push({
            role: "tool",
            tool_call_id: extra.id,
            content: JSON.stringify({ deferred: true, note: "انتظر تأكيد العملية الأولى أولاً" }),
          });
        }
        await status.forceFlush();
        await status.delete();
        const confirmMsg = (res.content || `هل تريد تنفيذ *${escMd(tool.name)}*؟`) +
          "\n\n_رد بـ «نعم» للتنفيذ أو «لا» للإلغاء._";
        try {
          await bot.sendMessage(chatId, confirmMsg, { parse_mode: "Markdown" });
        } catch {
          await bot.sendMessage(chatId, confirmMsg);
        }
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: summary + "\n[⏳ في انتظار التأكيد]" });
        await saveConversation(uid, history);
        return;
      }
    }

    // ── Refusal-storm bail-out    // ── Refusal-storm bail-out ──
    if (burstGuard.refusedCount >= MAX_REFUSALS_BEFORE_BAIL) {
      abortedReason = "refusal_storm";
      L.warn(
        "adminAgent",
        `refusal storm at iter ${loops} (refused=${burstGuard.refusedCount}); bailing to forced-final-answer`,
      );
      break;
    }

    // Keep typing indicator for next loop
    await bot.sendChatAction(chatId, "typing");
  }

  // ── Loop terminated without a final text answer → force one ─
  // Stream the forced final answer so admin sees it progressively.
  const reason: "loop_budget" | "token_budget" | "refusal_storm" =
    abortedReason ?? "loop_budget";
  const reasonAr =
    reason === "token_budget"
      ? `تجاوزت سعة المحادثة (${burstGuard.refusedCount} استدعاء مكرّر مرفوض، loops=${loops}).`
      : reason === "refusal_storm"
        ? `كرّرت نفس استدعاء الأداة ${burstGuard.refusedCount} مرة بنفس المعطيات. ` +
          "غالباً الأداة المختارة ليست هي الصحيحة للسؤال — جرّب أداة مختلفة أو راجع تعريفات الأدوات."
        : `وصلت للحد الأقصى من استدعاءات الأدوات (${MAX_LLM_LOOPS} دورة، ${burstGuard.refusedCount} استدعاء مكرّر مرفوض).`;
  try {
    const finalMessages: LLMMessage[] = [
      ...messages,
      {
        role: "system",
        content:
          `${reasonAr} ` +
          "بناءً على ما لديك من نتائج الأدوات أعلاه، أجِب المستخدم الآن بشكل مباشر ومختصر بدون أي استدعاءات أدوات إضافية. " +
          "لو ما لديك ما يكفي من معلومات، اعتذر بأدب واقترح صياغة بديلة للسؤال.",
      },
    ];

    // Show final status snapshot then stream the response
    await status.forceFlush();

    const streamResult = await status.streamFinalResponse(finalMessages);
    const finalReply = streamResult.fullText;

    history.push({ role: "user", content: userText });
    history.push({ role: "assistant", content: finalReply });
    await saveConversation(uid, history);
    L.info(
      "adminAgent",
      `${reason}_exhausted forced final answer via ${streamResult.providerUsed} in ${streamResult.ms}ms (refused=${burstGuard.refusedCount}, loops=${loops})`,
    );
  } catch (e) {
    const errMsg = String(e instanceof Error ? e.message : e).slice(0, 200);
    L.warn("adminAgent", "forced-text fallback failed", { err: errMsg, reason });
    await status.delete();
    await bot.sendMessage(chatId, `⚠ ${reasonAr} جرّب سؤالاً أبسط.`);
  }
}

// ── graceful shutdown ─────────────────────────────────────
export async function stopAdminAgent(): Promise<void> {
  stopProactiveMonitoring();
  stopScheduleRunner();
}
