import { redis } from "./redis.js";
import {
  RATE_LIMIT_MAX,    RATE_LIMIT_WINDOW,
  SEARCH_RATE_MAX,   SEARCH_RATE_WINDOW,
} from "./config.js";
import { L } from "./logger.js";

export { RATE_LIMIT_MAX, SEARCH_RATE_MAX };

// ══════════════════════════════════════════════
// RATE LIMITING — Redis Sliding Window (Atomic via Lua)
// ══════════════════════════════════════════════

// Lua script: كل العملية ذرية — لا race condition
// 1. احذف الأحداث القديمة خارج النافذة
// 2. اعدّ الأحداث الحالية  
// 3. لو تجاوز الحد → ارجع -1 (محجوب)
// 4. وإلا → أضف الحدث الجديد وارجع العدد الحالي
const SLIDING_WINDOW_LUA = `
  local key         = KEYS[1]
  local now         = tonumber(ARGV[1])
  local windowStart = tonumber(ARGV[2])
  local max         = tonumber(ARGV[3])
  local ttlSec      = tonumber(ARGV[4])
  local member      = ARGV[5]

  redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)
  local count = redis.call('ZCARD', key)
  if count >= max then
    return -1
  end
  redis.call('ZADD', key, now, member)
  redis.call('EXPIRE', key, ttlSec)
  return count
`;

async function checkSlidingWindow(
  prefix: string,
  userId: string,
  max: number,
  windowMs: number
): Promise<boolean> {
  const key         = `${prefix}:${userId}`;
  const now         = Date.now();
  const windowStart = now - windowMs;
  const ttlSec      = Math.ceil(windowMs / 1000) + 10;
  const member      = `${now}:${Math.random().toString(36).slice(2)}`;

  const result = await redis.eval(
    SLIDING_WINDOW_LUA, 1,
    key,
    String(now),
    String(windowStart),
    String(max),
    String(ttlSec),
    member
  ) as number;

  return result === -1;
}

/** فحص الـ rate limit العام للطلبات */
export async function isRateLimited(userId: string): Promise<boolean> {
  const limited = await checkSlidingWindow("rl", userId, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);
  if (limited) L.rateLimit(userId);
  return limited;
}

/** فحص الـ rate limit الخاص بالبحث (منع spam البحث) */
export async function isSearchRateLimited(userId: string): Promise<boolean> {
  const limited = await checkSlidingWindow("srl", userId, SEARCH_RATE_MAX, SEARCH_RATE_WINDOW);
  if (limited) L.rateLimitSearch(userId);
  return limited;
}

/** عدد الطلبات المتبقية في النافذة الحالية */
export async function getRemainingRequests(userId: string): Promise<number> {
  const key         = `rl:${userId}`;
  const windowStart = Date.now() - RATE_LIMIT_WINDOW;
  await redis.zremrangebyscore(key, 0, windowStart).catch(() => {});
  const count = await redis.zcard(key).catch(() => 0);
  return Math.max(0, RATE_LIMIT_MAX - count);
}

// Redis sliding window يتولى التنظيف تلقائياً عبر TTL
