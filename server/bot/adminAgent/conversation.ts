// ══════════════════════════════════════════════════════════
// Admin Agent — conversation memory (Redis-backed)
// ══════════════════════════════════════════════════════════
// Stores the last MAX_TURNS turns per admin user so the LLM has
// context across messages. Survives container restarts (Redis).
// TTL on the key auto-expires stale conversations.

import { redis } from "../redis.js";
import type { LLMMessage } from "./llm.js";

const KEY_PREFIX     = "admin:agent:conv:";
const MAX_TURNS      = 40;          // messages (not pairs)
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
    const trimmed = messages.slice(-MAX_TURNS);
    await redis.set(convKey(userId), JSON.stringify(trimmed), "EX", TTL_SECS);
  } catch { /* non-fatal */ }
}

export async function clearConversation(userId: string): Promise<void> {
  try {
    await redis.del(convKey(userId));
  } catch { /* non-fatal */ }
}
