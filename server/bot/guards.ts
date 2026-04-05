import { redis } from "./redis.js";
import { ADMIN_IDS, BANNED_USERS } from "./config.js";

// ══════════════════════════════════════════════
// BAN GUARD — Redis SET  (يبقى بعد الـ restart)
// ══════════════════════════════════════════════

const BANS_KEY = "bans";

/** يحمّل BANNED_USERS من الـ env إلى Redis عند أول تشغيل */
export async function seedBansFromEnv(): Promise<void> {
  if (BANNED_USERS.size === 0) return;
  await redis.sadd(BANS_KEY, ...[...BANNED_USERS]);
}

export async function isBanned(userId: string): Promise<boolean> {
  if (BANNED_USERS.has(userId)) return true;          // فحص سريع من الـ env
  return (await redis.sismember(BANS_KEY, userId)) === 1;
}

export async function banUser(userId: string): Promise<void> {
  await redis.sadd(BANS_KEY, userId);
}

export async function unbanUser(userId: string): Promise<void> {
  await redis.srem(BANS_KEY, userId);
}

export async function bannedList(): Promise<string[]> {
  const redisBanned = await redis.smembers(BANS_KEY);
  return [...new Set([...redisBanned, ...[...BANNED_USERS]])];
}

export async function bannedCount(): Promise<number> {
  const redisCount = await redis.scard(BANS_KEY);
  return Math.max(redisCount, BANNED_USERS.size);
}

// ══════════════════════════════════════════════
// ADMIN CHECK — بيانات ثابتة من env (sync)
// ══════════════════════════════════════════════

export function isAdmin(userId: string): boolean {
  return ADMIN_IDS.size > 0 && ADMIN_IDS.has(userId);
}

// ══════════════════════════════════════════════
// LAST BOOK PER USER — in-memory bounded Map
// ليست حيوية → لا تحتاج Redis
// ══════════════════════════════════════════════

const LAST_BOOK_MAX = 2000;
const lastBookPerUser = new Map<string, string>();

export function setLastBook(userId: string, book: string): void {
  lastBookPerUser.set(userId, book);
  if (lastBookPerUser.size > LAST_BOOK_MAX) {
    let evicted = 0;
    for (const k of lastBookPerUser.keys()) {
      if (evicted++ >= 200) break;
      lastBookPerUser.delete(k);
    }
  }
}

export function getLastBook(userId: string): string | undefined {
  return lastBookPerUser.get(userId);
}

// ══════════════════════════════════════════════
// CONCURRENT LOCK — مُدار بالـ Queue (queue.ts)
// acquireLock/releaseLock حُذفت — الـ queue يضمن
// عدم معالجة أكثر من job واحد لنفس المستخدم
// ══════════════════════════════════════════════
