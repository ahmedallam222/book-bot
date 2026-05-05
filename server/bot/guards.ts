import { redis }      from "./redis.js";
import { ADMIN_IDS }  from "./config.js";
import { L }          from "./logger.js";

// ══════════════════════════════════════════════
// GUARDS — حماية وصلاحيات
// ══════════════════════════════════════════════

// ── Admin check ───────────────────────────────
export function isAdmin(userId: string): boolean {
  return ADMIN_IDS.has(userId);
}

// ── Ban helpers ───────────────────────────────
export async function isBanned(userId: string): Promise<boolean> {
  try {
    return (await redis.sismember("bans", userId)) === 1;
  } catch {
    return false;
  }
}

export async function banUser(userId: string): Promise<void> {
  await redis.sadd("bans", userId);
  L.adminAction("system", `ban ${userId}`);
}

export async function unbanUser(userId: string): Promise<void> {
  await redis.srem("bans", userId);
  L.adminAction("system", `unban ${userId}`);
}

export async function bannedList(): Promise<string[]> {
  try {
    return await redis.smembers("bans");
  } catch {
    return [];
  }
}

export async function bannedCount(): Promise<number> {
  try {
    return await redis.scard("bans");
  } catch {
    return 0;
  }
}

// ── Last book (Redis with TTL) ──────────────
// كان Map داخل الـ process — مشكلتان:
//   1. تسرّب ذاكرة بطيء (لا eviction، لا TTL)
//   2. لا يعمل بين عدّة workers/instances ويُفقد بعد restart
// الحل: Redis مع TTL ٧ أيام — كافٍ لـ /last typical use case.
const LAST_BOOK_KEY = (userId: string) => `lastbook:${userId}`;
const LAST_BOOK_TTL_SEC = 7 * 24 * 60 * 60; // 7 أيام

export async function setLastBook(userId: string, bookName: string): Promise<void> {
  try {
    await redis.set(LAST_BOOK_KEY(userId), bookName, "EX", LAST_BOOK_TTL_SEC);
  } catch (e) {
    L.warn("guards", "setLastBook redis error", { err: String(e).slice(0, 80) });
  }
}

export async function getLastBook(userId: string): Promise<string | null> {
  try {
    return await redis.get(LAST_BOOK_KEY(userId));
  } catch {
    return null;
  }
}
