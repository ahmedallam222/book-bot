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
import { runLLM, type LLMMessage, type LLMToolCall } from "./llm.js";
import { getToolDefinitions, findTool, type ToolRunCtx } from "./tools.js";
import { loadConversation, saveConversation, clearConversation } from "./conversation.js";
import { seedDefaultsIfEmpty, ensureCloudflarePrimary } from "./llmProviders.js";

// ── config ────────────────────────────────────────────────
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "";

const MAX_LLM_LOOPS   = 12;   // guard against infinite tool loops (bumped from 8 in PR-A2)
const MAX_TOOL_OUTPUT  = 4000; // chars — keep context tight (bumped from 2500 for quick_overview)

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

  try {
    const me = await bot.getMe();
    L.info("adminAgent", `Admin agent started: @${me.username} (${me.id})`);
  } catch (e) {
    L.error("adminAgent", `getMe failed: ${String(e).slice(0, 80)}`);
  }

  // ── /start ──────────────────────────────────
  bot.onText(/^\/start$/, async (msg) => {
    const uid = String(msg.from?.id ?? "");
    if (!ADMIN_IDS.has(uid)) {
      await bot.sendMessage(msg.chat.id, "هذه الواجهة للإدارة فقط.");
      return;
    }
    await bot.sendMessage(msg.chat.id,
      "🤖 *وكيل إدارة خلاصة الكتب*\n\n" +
      "اسألني عن أي حاجة في البوت — إحصاءات، users، sources، logs.\n" +
      "أو اطلب مني أعمل حاجة — pause source، منح premium، broadcast.\n\n" +
      "أوامر سريعة:\n" +
      "/reset — امسح ذاكرة المحادثة\n" +
      "/status — لقطة سريعة\n" +
      "/help — شرح الـ tools المتاحة",
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
    if (!ADMIN_IDS.has(uid)) {
      await bot.sendMessage(msg.chat.id, "هذه الواجهة للإدارة فقط.");
      return;
    }
    const text = msg.text?.trim();
    if (!text) return;
    await handleMessage(bot, msg, text);
  });
}

// ══════════════════════════════════════════════════════════
// Core message handler — orchestrates LLM + tool loop
// ══════════════════════════════════════════════════════════

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
        const resultStr = truncate(JSON.stringify(result, null, 2));
        await bot.sendMessage(chatId, `✅ تم تنفيذ *${escMd(pending.toolName)}*\n\`\`\`json\n${resultStr}\n\`\`\``, { parse_mode: "Markdown" });
        // Feed the result back to conversation so LLM knows what happened
        const history = await loadConversation(uid);
        history.push(
          { role: "assistant", content: pending.summary },
          { role: "user", content: "تم التأكيد" },
          { role: "assistant", content: `Tool ${pending.toolName} executed:\n${resultStr}` },
        );
        await saveConversation(uid, history);
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

  await bot.sendChatAction(chatId, "typing");

  // ── build messages array ────────────────────
  const history = await loadConversation(uid);
  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  const toolDefs = getToolDefinitions();

  // ── tool loop ───────────────────────────────
  let loops = 0;
  while (loops < MAX_LLM_LOOPS) {
    loops++;
    let res;
    try {
      res = await runLLM(messages, toolDefs);
    } catch (e) {
      const errMsg = String(e instanceof Error ? e.message : e).slice(0, 300);
      L.error("adminAgent", "LLM call failed", { err: errMsg });
      await bot.sendMessage(chatId, `⚠ خطأ من الـ AI: ${errMsg}`);
      return;
    }

    // If no tool calls → final text response
    if (res.toolCalls.length === 0) {
      const reply = res.content || "(لا رد)";
      // Try Markdown first, fall back to plain text
      try {
        await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      } catch {
        await bot.sendMessage(chatId, reply);
      }
      // Save conversation
      history.push({ role: "user", content: userText });
      history.push({ role: "assistant", content: reply });
      await saveConversation(uid, history);
      return;
    }

    // Process tool calls
    // Add the assistant message with tool_calls to messages
    messages.push({
      role:       "assistant",
      content:    res.content,
      tool_calls: res.toolCalls,
    });

    for (const tc of res.toolCalls) {
      const tool = findTool(tc.function.name);
      if (!tool) {
        messages.push({
          role:         "tool",
          tool_call_id: tc.id,
          content:      JSON.stringify({ error: `unknown tool: ${tc.function.name}` }),
        });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      // ── write tool → confirm flow ──
      if (tool.isWrite) {
        const summary = res.content || `تنفيذ ${tool.name}(${JSON.stringify(args)})`;
        pendingWrites.set(uid, { toolName: tool.name, args, summary, ts: Date.now() });

        // Send the LLM's explanation + confirm prompt
        const confirmMsg = (res.content || `هل تريد تنفيذ *${escMd(tool.name)}*؟`) +
          "\n\n_رد بـ «نعم» للتنفيذ أو «لا» للإلغاء._";
        try {
          await bot.sendMessage(chatId, confirmMsg, { parse_mode: "Markdown" });
        } catch {
          await bot.sendMessage(chatId, confirmMsg);
        }

        // Save partial conversation for context
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: summary + "\n[⏳ في انتظار التأكيد]" });
        await saveConversation(uid, history);
        return; // Wait for confirm/cancel
      }

      // ── read tool → execute immediately ──
      try {
        const result = await tool.run(args, ctx);
        messages.push({
          role:         "tool",
          tool_call_id: tc.id,
          content:      truncate(JSON.stringify(result)),
        });
      } catch (e) {
        messages.push({
          role:         "tool",
          tool_call_id: tc.id,
          content:      JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 300) }),
        });
      }
    }

    // Send typing action for next loop
    await bot.sendChatAction(chatId, "typing");
  }

  // Safety: if we exhausted the loop budget
  await bot.sendMessage(chatId, "⚠ وصلت لحد الـ tool calls (8 دورات). جرّب سؤال أبسط.");
}

// ── graceful shutdown ─────────────────────────────────────
export async function stopAdminAgent(): Promise<void> {
  // No-op in this MVP; the process's SIGTERM handler covers it.
}
