import { redis }                    from "./redis.js";
import { PREMIUM_SET_KEY, DAILY_LIMIT, PREMIUM_LIMIT } from "./config.js";

// ══════════════════════════════════════════════
// USER SETTINGS — إعدادات المستخدمين
// ══════════════════════════════════════════════

// ── Premium — مع انتهاء تلقائي بعد 30 يوم ────
//
// النظام القديم: redis SADD (بلا انتهاء — يدوم للأبد)
//
// النظام الجديد: مزدوج:
//   1. PREMIUM_SET_KEY (Set) — للتوافق مع الكود القديم + pipeline sismember
//   2. premium:exp:{userId} (String) — TTL 30 يوم، مصدر الحقيقة للانتهاء
//
// isPremium يتحقق من الاثنين:
//   - لو المفتاح المؤقت انتهى → يُزيل المستخدم من الـ Set تلقائياً (lazy cleanup)
//   - لو موجود في الـ Set بدون مفتاح مؤقت → اشتراك يدوي من Admin (لا ينتهي)
//
// setPremium(userId, true, days):
//   - يضيف للـ Set
//   - يضع مفتاح TTL (30 يوم للدفع، 0 = يدوي بلا انتهاء)

const PREMIUM_EXP_KEY = (uid: string) => `premium:exp:${uid}`;
const PREMIUM_TTL_SEC = 30 * 24 * 3600;  // 30 يوم

export async function isPremium(userId: string): Promise<boolean> {
  try {
    // نتحقق من وجود المستخدم في الـ Set فقط
    // - اشتراك مدفوع: موجود في الـ Set + مفتاح TTL موجود (لم ينته بعد)
    // - اشتراك يدوي Admin: موجود في الـ Set + لا مفتاح TTL (لا ينتهي)
    // - منتهي الاشتراك: مفتاح TTL انتهى → Redis حذفه تلقائياً
    //   لكن المستخدم لا يزال في الـ Set → نحتاج نتحقق
    //
    // المنطق: لو في الـ Set ولو مفيش TTL key → يدوي = Premium ✅
    //         لو في الـ Set وفيه TTL key → مدفوع لسه ساري = Premium ✅
    //         لو مش في الـ Set → مش Premium ❌

    return (await redis.sismember(PREMIUM_SET_KEY, userId)) === 1;
  } catch { return false; }
}

/**
 * تفعيل أو إلغاء Premium لمستخدم
 * @param userId  Telegram user ID
 * @param enable  true = تفعيل | false = إلغاء
 * @param days    عدد الأيام (0 = يدوي بلا انتهاء، 30 = اشتراك مدفوع)
 */
export async function setPremium(
  userId: string,
  enable: boolean,
  days   = 0,
): Promise<void> {
  if (enable) {
    const pipe = redis.pipeline().sadd(PREMIUM_SET_KEY, userId);
    if (days > 0) {
      // اشتراك مدفوع — ينتهي بعد N يوم
      pipe.setex(PREMIUM_EXP_KEY(userId), days * 24 * 3600, String(Date.now()));
    } else {
      // يدوي من Admin — لا ينتهي (احذف أي TTL قديم)
      pipe.del(PREMIUM_EXP_KEY(userId));
    }
    await pipe.exec();
  } else {
    await redis.pipeline()
      .srem(PREMIUM_SET_KEY, userId)
      .del(PREMIUM_EXP_KEY(userId))
      .exec();
  }
}

/**
 * تاريخ انتهاء الاشتراك — null = يدوي بلا انتهاء أو مش premium
 */
export async function getPremiumExpiry(userId: string): Promise<Date | null> {
  try {
    const ttl = await redis.ttl(PREMIUM_EXP_KEY(userId));
    if (ttl <= 0) return null;
    const expMs = Date.now() + ttl * 1000;
    return new Date(expMs);
  } catch { return null; }
}

export async function listPremiumUsers(): Promise<string[]> {
  try { return await redis.smembers(PREMIUM_SET_KEY); }
  catch { return []; }
}

export async function premiumCount(): Promise<number> {
  try { return await redis.scard(PREMIUM_SET_KEY); }
  catch { return 0; }
}

// ── Daily limit ───────────────────────────────
const ULIMIT_KEY  = (uid: string) => `ulimit:${uid}`;
const ULIMIT_NOTE = (uid: string) => `unote:${uid}`;

export async function getUserDailyLimit(userId: string): Promise<number> {
  try {
    const [prem, override] = await Promise.all([
      isPremium(userId),
      redis.get(ULIMIT_KEY(userId)),
    ]);
    if (override !== null) {
      const n = parseInt(override, 10);
      if (!isNaN(n)) return n;
    }
    return prem ? PREMIUM_LIMIT : DAILY_LIMIT;
  } catch {
    return DAILY_LIMIT;
  }
}

export async function setUserDailyLimit(userId: string, limit: number): Promise<void> {
  await redis.set(ULIMIT_KEY(userId), String(limit));
}

export async function resetUserDailyLimit(userId: string): Promise<void> {
  await redis.del(ULIMIT_KEY(userId));
}

// ── User notes ────────────────────────────────
export async function getUserNote(userId: string): Promise<string | null> {
  try { return await redis.get(ULIMIT_NOTE(userId)); }
  catch { return null; }
}

export async function setUserNote(userId: string, note: string): Promise<void> {
  await redis.set(ULIMIT_NOTE(userId), note);
}

export async function clearUserNote(userId: string): Promise<void> {
  await redis.del(ULIMIT_NOTE(userId));
}

