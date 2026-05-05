import type { Request, Response, NextFunction } from "express";
import { redis } from "./redis.js";
import { L } from "./logger.js";

// ══════════════════════════════════════════════
// IP RATE LIMIT — حماية للـ APIs العامة
//
// نفس نمط server/bot/rateLimit.ts (Lua sliding window) لكن مفتاحه IP بدل
// userId. الفرق المهم: هنا نفحص أولاً ولا نُضيف لو تجاوز الحد، عشان
// المستخدم المُسيء ما يطيلش فترة الحظر بنفسه (انظر H3 fix).
// ══════════════════════════════════════════════

const slidingWindowGuardLua = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local min    = now - window
redis.call("ZREMRANGEBYSCORE", key, "-inf", min)
local count = redis.call("ZCARD", key)
if count >= limit then
  return -1
end
redis.call("ZADD", key, now, tostring(now) .. "-" .. tostring(math.random(1, 1000000)))
redis.call("PEXPIRE", key, window)
return count + 1
`;

interface IpLimitOpts {
  /** مفتاح route للتمييز بين endpoints مختلفة */
  prefix: string;
  /** أقصى عدد طلبات في النافذة */
  max: number;
  /** عرض النافذة بالميلي ثانية */
  windowMs: number;
}

function clientIp(req: Request): string {
  // Express يضبط req.ip من x-forwarded-for لو trust proxy مفعّل
  // وإلا يأخذ socket.remoteAddress مباشرة. كلاهما يكفي كمفتاح limiter.
  return (req.ip || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

export function ipRateLimit(opts: IpLimitOpts) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    const key = `rl:ip:${opts.prefix}:${ip}`;
    let result: number;
    try {
      result = await (redis as any).eval(
        slidingWindowGuardLua, 1, key,
        String(Date.now()), String(opts.windowMs), String(opts.max),
      ) as number;
    } catch (e) {
      // fail-open على فشل Redis كي لا نقطع الخدمة بسبب مشكلة اتصال
      L.warn("ipRateLimit", "redis error — failing open", { err: String(e).slice(0, 80) });
      return next();
    }
    if (result === -1) {
      res.status(429).json({
        ok: false,
        error: `Too many requests — max ${opts.max} per ${Math.round(opts.windowMs / 1000)}s`,
      });
      return;
    }
    next();
  };
}
