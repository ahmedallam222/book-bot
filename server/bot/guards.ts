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

// ── Last book (in-memory per worker) ─────────
const _lastBook = new Map<string, string>();

export function setLastBook(userId: string, bookName: string): void {
  _lastBook.set(userId, bookName);
}

export function getLastBook(userId: string): string | null {
  return _lastBook.get(userId) ?? null;
}
