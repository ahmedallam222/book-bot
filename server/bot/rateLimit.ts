import { redis } from "./redis.js";

// ══════════════════════════════════════════════
// RATE LIMIT — نافذة منزلقة atomic بـ Lua
// ══════════════════════════════════════════════

export const RATE_LIMIT_MAX   = 10;  // طلبات/دقيقة (download)
export const SEARCH_RATE_MAX  = 20;  // طلبات/دقيقة (search)

const WINDOW_MS = 60_000;

/**
 * Lua script: sliding window counter — atomic، لا race conditions
 *
 * H3 FIX: السكربت السابق كان يُضيف timestamp ثم يفحص العدد. هذا يعني أن
 * المستخدم المُسيء يطيل فترة حظره بنفسه: كل طلب مرفوض يضيف entry جديد
 * فيمنع الـ window من الانكماش حتى يتوقف عن المحاولة.
 *
 * الآن: نفحص أولاً، ولا نُضيف إلا إذا كان تحت الحد. بعد فترة الـ window
 * بدون طلبات مقبولة، الـ ZSET يفرغ والمستخدم يستعيد كل سعته.
 *
 * نضيف عضوًا فريدًا (now-rand) لتفادي تصادم نفس الـ score+member في
 * نفس الميلي ثانية الذي كان Redis يدمجه إلى عنصر واحد.
 */
const slidingWindowLua = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local rand   = ARGV[4]
local min    = now - window
redis.call("ZREMRANGEBYSCORE", key, "-inf", min)
local count = redis.call("ZCARD", key)
if count >= limit then
  return -1
end
redis.call("ZADD", key, now, tostring(now) .. "-" .. rand)
redis.call("PEXPIRE", key, window)
return count + 1
`;

async function checkLimit(userId: string, prefix: string, max: number): Promise<boolean> {
  try {
    const key = `rl:${prefix}:${userId}`;
    const result = await (redis as any).eval(
      slidingWindowLua, 1, key,
      String(Date.now()), String(WINDOW_MS), String(max),
      String(Math.floor(Math.random() * 1_000_000)),
    ) as number;
    return result === -1;
  } catch {
    return false; // fail-open
  }
}

export function isRateLimited(userId: string): Promise<boolean> {
  return checkLimit(userId, "dl", RATE_LIMIT_MAX);
}

export function isSearchRateLimited(userId: string): Promise<boolean> {
  return checkLimit(userId, "sr", SEARCH_RATE_MAX);
}
