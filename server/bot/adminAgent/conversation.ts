// ══════════════════════════════════════════════════════════
// Admin Agent — conversation memory (Redis-backed, v2)
// ══════════════════════════════════════════════════════════
// v2: integrates smart memory summarization. When the
// conversation exceeds SUMMARY_THRESHOLD, older messages are
// compressed into a summary that persists across resets.
// The summary is injected as a system message at the start of
// the conversation so the agent retains context.

import { redis }                from "../redis.js";
import type { LLMMessage }      from "./llm.js";
import { maybeSummarize }       from "./memory.js";
import { L }                    from "../logger.js";

const KEY_PREFIX     = "admin:agent:conv:";
const MAX_TURNS      = 40;           // messages (not pairs)
const TTL_SECS       = 30 * 24 * 3600; // 30 days

function convKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export async function loadConversation(userId: string): Promise<LLMMessage[]> {
  try {
    const raw = await redis.get(convKey(userId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as LLMMessage[];
    return Array.isArray(arr) ? arr.slice(-MAX_TURNS) : [];
  } catch {
    return [];
  }
}

export async function saveConversation(
  userId: string,
  messages: LLMMessage[],
): Promise<void> {
  try {
    let toSave = messages;

    // Auto-summarize if the conversation is getting long.
    const result = await maybeSummarize(userId, messages);
    if (result) {
      toSave = result.trimmedMessages;
      L.info(
        "conversation",
        `auto-summarized ${messages.length - toSave.length} messages for ${userId}`,
      );
    }

    const trimmed = toSave.slice(-MAX_TURNS);
    await redis.set(convKey(userId), JSON.stringify(trimmed), "EX", TTL_SECS);
  } catch { /* non-fatal */ }
}

export async function clearConversation(userId: string): Promise<void> {
  try {
    await redis.del(convKey(userId));
  } catch { /* non-fatal */ }
}
