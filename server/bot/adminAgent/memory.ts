// ══════════════════════════════════════════════════════════
// Admin Agent — Smart Memory System
// ══════════════════════════════════════════════════════════
// Three layers of memory beyond simple conversation history:
//
//   1. **Knowledge Base**: persistent key-value facts in Redis
//      (e.g. "welib was down on Thursday", "user X is a heavy user").
//      Survives conversation resets.  TTL 90 days.
//
//   2. **Conversation Summarization**: when the conversation context
//      exceeds SUMMARY_THRESHOLD messages, older messages are
//      compressed into a summary via a cheap LLM call. This keeps
//      context tight without losing important decisions/findings.
//
//   3. **Context Injection**: on each new turn the agent gets a
//      small "memory preamble" with recent knowledge entries and
//      any persisted conversation summary — so it remembers context
//      even after /reset or container restarts.
//
// Storage:
//   admin:agent:kb               — Hash (field=key, value=JSON{value,updatedAt})
//   admin:agent:summary:{uid}    — String (compressed conversation summary)

import { redis } from "../redis.js";
import { runLLM, type LLMMessage } from "./llm.js";
import { L } from "../logger.js";

const KB_KEY               = "admin:agent:kb";
const KB_TTL_SECS          = 90 * 24 * 3600; // 90 days
const SUMMARY_KEY_PREFIX   = "admin:agent:summary:";
const SUMMARY_TTL_SECS     = 30 * 24 * 3600; // 30 days
const SUMMARY_THRESHOLD    = 24; // start summarizing after this many messages
const MAX_KB_ENTRIES        = 100;
const MAX_KB_RETURN         = 20;

// ── Knowledge Base ────────────────────────────────────────

export interface KBEntry {
  key:       string;
  value:     string;
  updatedAt: number;
}

export async function saveKnowledge(key: string, value: string): Promise<void> {
  const sanitized = key.replace(/\s+/g, "_").slice(0, 80);
  const entry = JSON.stringify({ value: value.slice(0, 1000), updatedAt: Date.now() });
  await redis.hset(KB_KEY, sanitized, entry);
  await redis.expire(KB_KEY, KB_TTL_SECS);
  // Enforce max entries — drop oldest if over limit.
  const count = await redis.hlen(KB_KEY);
  if (count > MAX_KB_ENTRIES) {
    const all = await loadAllKB();
    const sorted = all.sort((a, b) => a.updatedAt - b.updatedAt);
    const toDrop = sorted.slice(0, count - MAX_KB_ENTRIES);
    if (toDrop.length > 0) {
      await redis.hdel(KB_KEY, ...toDrop.map(e => e.key));
    }
  }
}

export async function recallKnowledge(query?: string): Promise<KBEntry[]> {
  const all = await loadAllKB();
  if (!query) return all.slice(0, MAX_KB_RETURN);
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  return all
    .filter(e =>
      keywords.some(kw =>
        e.key.toLowerCase().includes(kw) ||
        e.value.toLowerCase().includes(kw),
      ),
    )
    .slice(0, MAX_KB_RETURN);
}

export async function deleteKnowledge(key: string): Promise<boolean> {
  return (await redis.hdel(KB_KEY, key)) > 0;
}

export async function knowledgeCount(): Promise<number> {
  return redis.hlen(KB_KEY);
}

async function loadAllKB(): Promise<KBEntry[]> {
  try {
    const raw = await redis.hgetall(KB_KEY);
    return Object.entries(raw).map(([k, v]) => {
      try {
        const parsed = JSON.parse(v) as { value: string; updatedAt: number };
        return { key: k, value: parsed.value, updatedAt: parsed.updatedAt };
      } catch {
        return { key: k, value: v, updatedAt: 0 };
      }
    });
  } catch {
    return [];
  }
}

// ── Conversation Summarization ────────────────────────────

export async function loadSummary(userId: string): Promise<string | null> {
  try {
    return await redis.get(`${SUMMARY_KEY_PREFIX}${userId}`);
  } catch {
    return null;
  }
}

export async function saveSummary(userId: string, summary: string): Promise<void> {
  try {
    await redis.set(
      `${SUMMARY_KEY_PREFIX}${userId}`,
      summary.slice(0, 3000),
      "EX",
      SUMMARY_TTL_SECS,
    );
  } catch { /* non-fatal */ }
}

/**
 * If the conversation is long enough, summarize the older half and
 * return { summary, trimmedMessages }. Otherwise returns null.
 */
export async function maybeSummarize(
  userId: string,
  messages: LLMMessage[],
): Promise<{ summary: string; trimmedMessages: LLMMessage[] } | null> {
  if (messages.length < SUMMARY_THRESHOLD) return null;

  // Summarize the older half, keep the recent half as-is.
  const splitPoint    = Math.floor(messages.length / 2);
  const olderMessages = messages.slice(0, splitPoint);
  const recentMessages = messages.slice(splitPoint);

  const existingSummary = await loadSummary(userId);
  const toSummarize = olderMessages
    .filter(m => m.role === "user" || (m.role === "assistant" && m.content))
    .map(m => `${m.role}: ${(m.content ?? "").slice(0, 300)}`)
    .join("\n");

  if (!toSummarize.trim()) return null;

  const summaryPrompt: LLMMessage[] = [
    {
      role: "system",
      content:
        "أنت مُلخِّص محادثات admin agent. لخّص المحادثة في 4-6 نقاط بالعربية.\n" +
        "ركّز على: القرارات، المشاكل المحلولة، الأوامر المنفّذة، معلومات مهمة.\n" +
        "اكتب بشكل مختصر بدون مقدمة.",
    },
    {
      role: "user",
      content:
        (existingSummary ? `ملخص سابق:\n${existingSummary}\n\n` : "") +
        `محادثة جديدة للتلخيص:\n${toSummarize}`,
    },
  ];

  try {
    const res = await runLLM(summaryPrompt, [], { forceText: true });
    const summary = res.content || "";
    if (summary.length < 20) return null; // too short to be useful

    await saveSummary(userId, summary);
    L.info("memory", `Summarized ${olderMessages.length} messages for ${userId} (${summary.length} chars)`);
    return { summary, trimmedMessages: recentMessages };
  } catch (e) {
    L.warn("memory", `Summarization failed: ${String(e).slice(0, 100)}`);
    return null;
  }
}

// ── Context Injection ─────────────────────────────────────

/**
 * Build a short memory preamble to inject into the system prompt.
 * Includes recent knowledge entries and any conversation summary.
 */
export async function buildMemoryContext(userId: string): Promise<string> {
  const parts: string[] = [];

  // 1. Knowledge base entries (latest 10)
  try {
    const entries = await loadAllKB();
    if (entries.length > 0) {
      const sorted = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
      const lines = sorted.map(e =>
        `• ${e.key}: ${e.value.slice(0, 150)}`,
      );
      parts.push(`📋 ذاكرة المعرفة (${entries.length} عنصر):\n${lines.join("\n")}`);
    }
  } catch { /* non-fatal */ }

  // 2. Conversation summary
  try {
    const summary = await loadSummary(userId);
    if (summary) {
      parts.push(`📝 ملخص المحادثات السابقة:\n${summary}`);
    }
  } catch { /* non-fatal */ }

  return parts.length > 0 ? "\n\n# ذاكرتك\n" + parts.join("\n\n") : "";
}
