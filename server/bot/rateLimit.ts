import { redis } from "./redis.js";

// ══════════════════════════════════════════════
// RATE LIMIT — نافذة منزلقة atomic بـ Lua
// ══════════════════════════════════════════════

export const RATE_LIMIT_MAX   = 10;  // طلبات/دقيقة (download)
export const SEARCH_RATE_MAX  = 20;  // طلبات/دقيقة (search)

const WINDOW_MS = 60_000;

/**
 * Lua script: sliding window counter — atomic، لا race conditions
 * يُضيف timestamp الحالي، يُزيل القديمة، ويُعيد العدد الحالي
 */
const slidingWindowLua = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local min    = now - window
redis.call("ZREMRANGEBYSCORE", key, "-inf", min)
redis.call("ZADD", key, now, now)
redis.call("EXPIRE", key, math.ceil(window / 1000))
local count = redis.call("ZCARD", key)
return count
`;

async function checkLimit(userId: string, prefix: string, max: number): Promise<boolean> {
  try {
    const key = `rl:${prefix}:${userId}`;
    const count = await (redis as any).eval(
      slidingWindowLua, 1, key,
      String(Date.now()), String(WINDOW_MS), String(max)
    ) as number;
    return count > max;
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
