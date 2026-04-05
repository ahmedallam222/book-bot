import TelegramBot from "node-telegram-bot-api";
import { createHash } from "crypto";
import { redis } from "./redis.js";
import { ADMIN_IDS, BLACKLIST_THRESHOLD, BLACKLIST_TTL } from "./config.js";
import { L } from "./logger.js";

// ══════════════════════════════════════════════
// URL BLACKLIST — Redis
// رابط يفشل 3 مرات → يُحجب 2 ساعة تلقائياً
// ══════════════════════════════════════════════

interface BlacklistEntry { fails: number }

/** مفتاح Redis للرابط — SHA-256 يضمن uniqueness كاملاً لأي URL
 *
 * BUG FIX (BUG-NEW-1): base64url.slice(0,90) كانت تُنتج تصادمات:
 *   url1 = "https://site.com/books/long-path-AAAAAA...pdf"
 *   url2 = "https://site.com/books/long-path-BBBBBB...pdf"
 *   كلاهما ينتجان نفس الـ base64 prefix → نفس Redis key.
 *   نتيجة: URL صالح يُحظر بسبب URL فاشل يشارك نفس الـ key.
 *
 *   SHA-256 يحل المشكلة نهائياً — احتمال التصادم = 1/2^256 (معدوم عملياً).
 */
function urlKey(url: string): string {
  return `bl:${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
}

function domainKey(domain: string, date: string): string {
  return `dfl:${domain}:${date}`;
}

function getDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url.slice(0, 30); }
}

export async function isBlacklisted(url: string): Promise<boolean> {
  const val = await redis.get(urlKey(url));
  if (!val) return false;
  const entry: BlacklistEntry = JSON.parse(val);
  return entry.fails >= BLACKLIST_THRESHOLD;
}

export async function recordUrlSuccess(url: string): Promise<void> {
  await redis.del(urlKey(url));
}

// Lua script ذري لزيادة عداد الفشل — يمنع race condition بين workers متزامنين
const LUA_INCR_FAILS = `
  local key    = KEYS[1]
  local ttl    = tonumber(ARGV[1])
  local raw    = redis.call('GET', key)
  local fails  = 0
  if raw then
    local ok, obj = pcall(cjson.decode, raw)
    if ok and obj and obj.fails then fails = tonumber(obj.fails) end
  end
  fails = fails + 1
  redis.call('SETEX', key, ttl, cjson.encode({fails=fails}))
  return fails
`;

export async function recordUrlFailure(url: string): Promise<void> {
  const key    = urlKey(url);
  const ttlSec = Math.ceil(BLACKLIST_TTL / 1000);

  // H2 FIX: عملية ذرية واحدة بدل GET ثم SET — يمنع race condition
  const fails = await redis.eval(LUA_INCR_FAILS, 1, key, String(ttlSec)) as number;

  if (fails >= BLACKLIST_THRESHOLD) {
    L.blacklist(url, fails);
  }

  // ── Domain fail tracking ─────────────────────
  const domain = getDomain(url);
  const today  = new Date().toISOString().slice(0, 10);
  const dKey   = domainKey(domain, today);

  const count = await redis.incr(dKey);
  await redis.expire(dKey, 90_000); // 25 ساعة

  // أشعر الأدمن عند أول ضربة للحد (مرة واحدة فقط/يوم)
  if (count === 10 && _alertBot && ADMIN_IDS.size > 0) {
    const msg =
      `⚠️ *تحذير مصدر فاشل*\n\n` +
      `🔴 \`${domain}\` فشل *${count} مرة* اليوم\n\n` +
      `قد يكون المصدر معطلاً.`;
    for (const adminId of ADMIN_IDS) {
      _alertBot.sendMessage(Number(adminId), msg, { parse_mode: "Markdown" }).catch(() => {});
    }
    L.warn("system", `Admin alerted: ${domain} failed ${count}x today`);
  }
}

export async function clearBlacklist(): Promise<number> {
  let count = 0;
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "bl:*", "COUNT", 100);
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
      count += keys.length;
    }
  } while (cursor !== "0");
  return count;
}

export async function blacklistStats(): Promise<{ total: number; active: number }> {
  let total = 0, active = 0;
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "bl:*", "COUNT", 100);
    cursor = next;
    if (keys.length === 0) continue;
    const vals = await redis.mget(...keys);
    for (const v of vals) {
      if (!v) continue;
      total++;
      const e: BlacklistEntry = JSON.parse(v);
      if (e.fails >= BLACKLIST_THRESHOLD) active++;
    }
  } while (cursor !== "0");
  return { total, active };
}


// Lua script ذري لضبط failCount بـ max(current, newFails) — يمنع race condition
// semantic مختلف عن LUA_INCR_FAILS: هذا يضبط حداً أدنى، لا يُضيف
const LUA_MAX_FAILS = `
  local key      = KEYS[1]
  local ttl      = tonumber(ARGV[1])
  local newFails = tonumber(ARGV[2])
  local raw      = redis.call('GET', key)
  local fails    = 0
  if raw then
    local ok, obj = pcall(cjson.decode, raw)
    if ok and obj and obj.fails then fails = tonumber(obj.fails) end
  end
  if newFails > fails then fails = newFails end
  redis.call('SETEX', key, ttl, cjson.encode({fails=fails}))
  return fails
`;

/**
 * تضبط fails على max(current, failCount) بعملية ذرية واحدة.
 * تُستخدم من callbacks.ts لإبلاغ رابط سيئ فوراً بدون loop.
 * H2 FIX: استبدال GET+SET بـ Lua ذري لمنع race condition.
 */
export async function blacklistUrlDirect(url: string, failCount: number): Promise<void> {
  const key    = urlKey(url);
  const ttlSec = Math.ceil(BLACKLIST_TTL / 1000);
  const fails  = await redis.eval(LUA_MAX_FAILS, 1, key, String(ttlSec), String(failCount)) as number;
  L.blacklist(url, fails);
}

// Redis TTLs تتولى التنظيف تلقائياً — لا حاجة لـ cleanup يدوي

// ── Alert bot instance ────────────────────────
let _alertBot: TelegramBot | null = null;

export function setAlertBot(bot: TelegramBot): void {
  _alertBot = bot;
}
