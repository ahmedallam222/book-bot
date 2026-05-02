import { redis } from "./redis.js";
import { L }      from "./logger.js";
import { BLACKLIST_THRESHOLD } from "./config.js";

// ══════════════════════════════════════════════
// BLACKLIST — حجب URLs الفاشلة
// ══════════════════════════════════════════════

const BL_FAIL_KEY   = (url: string) => `bl:fail:${url}`;
const BL_SET_KEY    = "bl:blocked";
const BL_TTL_SEC    = 7 * 24 * 3600;  // 7 days

export async function isBlacklisted(url: string): Promise<boolean> {
  try {
    return (await redis.sismember(BL_SET_KEY, url)) === 1;
  } catch {
    return false;
  }
}

export async function recordUrlFailure(url: string): Promise<void> {
  try {
    const key   = BL_FAIL_KEY(url);
    const count = await redis.incr(key);
    await redis.expire(key, BL_TTL_SEC);
    if (count >= BLACKLIST_THRESHOLD) {
      await redis.sadd(BL_SET_KEY, url);
      L.warn("blacklist", `URL blacklisted after ${count} failures`, { url: url.slice(0, 80) });
    }
  } catch {}
}

// مفتاح Redis لعدد النجاحات المتتالية لـ URL مُدرَج في الـ blacklist
const BL_SUCCESS_KEY = (url: string) => `bl:success:${url}`;
const BL_SUCCESS_NEEDED = 3;  // نجاحات متتالية للإزالة من الـ blacklist

export async function recordUrlSuccess(url: string): Promise<void> {
  try {
    // FIX-BLACKLIST v30: الكود القديم كان يمسح fail counter فقط
    // v30-a: يمسح fail counter دائماً (سلوك قديم محتفظ به)
    // v30-b: لو URL في blacklist → يحتاج BL_SUCCESS_NEEDED نجاحات متتالية للإزالة
    //        نجاح واحد لا يكفي — قد يكون مؤقتاً قبل عودة الفشل
    await redis.del(BL_FAIL_KEY(url));

    const inBlacklist = await redis.sismember(BL_SET_KEY, url);
    if (!inBlacklist) return; // ليس في blacklist → لا شيء إضافي

    const successKey   = BL_SUCCESS_KEY(url);
    const successCount = await redis.incr(successKey);
    await redis.expire(successKey, BL_TTL_SEC);

    if (successCount >= BL_SUCCESS_NEEDED) {
      await redis.pipeline()
        .srem(BL_SET_KEY, url)
        .del(successKey)
        .exec();
      L.info("blacklist", `URL removed from blacklist after ${successCount} successes`, { url: url.slice(0, 80) });
    }
  } catch {}
}

export async function blacklistUrlDirect(url: string, _threshold = 3): Promise<void> {
  try {
    await redis.sadd(BL_SET_KEY, url);
    L.warn("blacklist", `URL manually blacklisted`, { url: url.slice(0, 80) });
  } catch {}
}

export async function blacklistStats(): Promise<{ total: number; active: number }> {
  try {
    const total = await redis.scard(BL_SET_KEY);
    return { total, active: total };
  } catch {
    return { total: 0, active: 0 };
  }
}

export async function clearBlacklist(): Promise<void> {
  await redis.del(BL_SET_KEY);
  L.adminAction("system", "blacklist cleared");
}
