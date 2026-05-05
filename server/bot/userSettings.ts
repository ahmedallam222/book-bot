import { redis }                    from "./redis.js";
import { L }                        from "./logger.js";
import { PREMIUM_SET_KEY, DAILY_LIMIT, PREMIUM_LIMIT } from "./config.js";

// ══════════════════════════════════════════════
// USER SETTINGS — إعدادات المستخدمين
// ══════════════════════════════════════════════

// ── Premium — TTL-based expiration with lazy cleanup ──
//
// التخزين في Redis (3 مفاتيح):
//   1. PREMIUM_SET_KEY (Set)              — للتوافق مع pipeline sismember في hot path
//   2. premium:exp:{userId}     (String)  — اشتراك مدفوع. TTL = صلاحية الاشتراك
//   3. premium:manual:{userId}  (String)  — منحة Admin. بدون TTL = للأبد
//
// المستخدم يُعتبر Premium لو:
//   - موجود في PREMIUM_SET_KEY  AND
//   - (premium:exp موجود  OR  premium:manual موجود)
//
// لو موجود في الـ Set بدون أي من الاتنين → اشتراك انتهى (Redis مسح exp تلقائياً)
//   → نعمل lazy cleanup: SREM من الـ Set ونرجع false.
//
// التجديد (setPremium مدفوع): يُمدّد الـ TTL القائم بدل ما يستبدله.
//   مثال: عميل عنده 10 أيام باقية يجدد → الـ TTL يصبح 10 + 30 = 40 يوم.
//   هذا هو السلوك الموثّق في README ("التجديد يمدّد الصلاحية القائمة").
//
// قبل هذا الإصلاح: setex كان بيـ replace الـ TTL → العميل يخسر الأيام الباقية.
// وقبل ذلك: مفيش lazy cleanup أصلاً → العميل يدفع مرة → premium للأبد.

const PREMIUM_EXP_KEY    = (uid: string) => `premium:exp:${uid}`;
const PREMIUM_MANUAL_KEY = (uid: string) => `premium:manual:${uid}`;
// audit log — قائمة مرتبة (أحدث أولاً) من JSON entries لكل مستخدم
// المحتوى: { ts, action, days, by, source, reason }
// نحتفظ بآخر 50 لكل مستخدم — كافية للمراجعة وما بتأكلش ذاكرة
const PREMIUM_AUDIT_KEY  = (uid: string) => `premium:audit:${uid}`;
const PREMIUM_AUDIT_MAX  = 50;

export async function isPremium(userId: string): Promise<boolean> {
  try {
    // pipeline واحد بدل 3 round-trips
    const res = await redis.pipeline()
      .sismember(PREMIUM_SET_KEY, userId)
      .exists(PREMIUM_EXP_KEY(userId))
      .exists(PREMIUM_MANUAL_KEY(userId))
      .exec();
    if (!res) return false;

    const inSet     = (res[0]?.[1] as number) === 1;
    const hasExp    = (res[1]?.[1] as number) === 1;
    const hasManual = (res[2]?.[1] as number) === 1;

    if (!inSet) return false;
    if (hasExp || hasManual) return true;

    // Stale entry: في الـ Set بدون exp ولا manual → اشتراك انتهى.
    // Lazy cleanup — fire-and-forget عشان ما نأخّرش الـ caller
    redis.srem(PREMIUM_SET_KEY, userId).catch(() => {});
    L.info("premium", "Lazy cleanup: removed expired user from set", { userId });
    return false;
  } catch { return false; }
}

/**
 * source للتتبّع الإداري — من فين جت الحركة (audit trail)
 *   - "telegram-cmd" = /grantpremium أو /revokepremium
 *   - "telegram-callback" = زر prem:toggle: في الـ admin UI
 *   - "dashboard" = POST /api/admin/users/:id/premium
 *   - "stars-payment" = اشتراك مدفوع via Telegram Stars
 *   - "system" = إصلاح/تنظيف تلقائي
 */
export type PremiumGrantSource =
  | "telegram-cmd"
  | "telegram-callback"
  | "dashboard"
  | "stars-payment"
  | "system";

export interface PremiumGrantContext {
  /** Admin Telegram ID اللي عمل الحركة، أو "system" للحركات التلقائية */
  by: string;
  /** من أي واجهة جت الحركة */
  source: PremiumGrantSource;
  /** سبب اختياري — مفيد بشكل خاص للمنح اليدوية */
  reason?: string;
}

interface PremiumAuditEntry {
  ts:     number;            // ms epoch
  action: "grant" | "revoke";
  days:   number;            // 0 = manual grant بدون انتهاء
  by:     string;
  source: PremiumGrantSource;
  reason?: string;
}

/**
 * تفعيل أو إلغاء Premium لمستخدم
 * @param userId  Telegram user ID
 * @param enable  true = تفعيل | false = إلغاء
 * @param days    عدد الأيام:
 *                  > 0 = اشتراك مدفوع (يُمدّد TTL القائم بهذه الأيام)
 *                  = 0 = منحة Admin يدوية بلا انتهاء
 * @param ctx     سياق التتبع — من قام بالحركة، من أي واجهة، ولماذا. اختياري
 *                للتوافق الخلفي لكن يُكتب صراحةً في audit log.
 *
 * Renewal semantics (days > 0):
 *   - لو فيه TTL باقي → الجديد = القديم + days*86400 (تمديد)
 *   - لو منتهي/غير موجود → الجديد = days*86400 (اشتراك جديد)
 *   - لو كان admin grant (manual) → نحذف الـ manual ونحوّل لاشتراك مدفوع
 */
export async function setPremium(
  userId: string,
  enable: boolean,
  days   = 0,
  ctx?:    PremiumGrantContext,
): Promise<void> {
  if (!enable) {
    // إلغاء كامل — احذف من كل مكان
    await redis.pipeline()
      .srem(PREMIUM_SET_KEY, userId)
      .del(PREMIUM_EXP_KEY(userId))
      .del(PREMIUM_MANUAL_KEY(userId))
      .exec();
    await appendAudit(userId, { action: "revoke", days: 0, ctx });
    return;
  }

  if (days > 0) {
    // اشتراك مدفوع — مدّد الـ TTL القائم
    const currentTtl = await redis.ttl(PREMIUM_EXP_KEY(userId));
    // -2 = key missing, -1 = no TTL (لا يحدث في كودنا), >0 = ثوانٍ متبقية
    const remainingSec = currentTtl > 0 ? currentTtl : 0;
    const newTtlSec    = remainingSec + days * 24 * 3600;

    await redis.pipeline()
      .sadd(PREMIUM_SET_KEY, userId)
      .set(PREMIUM_EXP_KEY(userId), String(Date.now()), "EX", newTtlSec)
      // ترقية من admin grant لاشتراك مدفوع — احذف الـ manual flag
      .del(PREMIUM_MANUAL_KEY(userId))
      .exec();

    L.info("premium", "Paid premium activated/extended", {
      userId,
      addedDays: days,
      previousRemainingSec: remainingSec,
      newTtlSec,
    });
  } else {
    // منحة Admin — بدون TTL، تدوم للأبد. تُلغي أي paid TTL سابق لتفادي
    // ظهوره فجأة لو الأدمن ألغى الـ manual لاحقاً (audit M3).
    await redis.pipeline()
      .sadd(PREMIUM_SET_KEY, userId)
      .set(PREMIUM_MANUAL_KEY(userId), String(Date.now()))
      .del(PREMIUM_EXP_KEY(userId))
      .exec();

    L.info("premium", "Manual admin grant set", { userId });
  }

  await appendAudit(userId, { action: "grant", days, ctx });
}

/**
 * يلصق entry جديد في audit log لمستخدم. fire-and-forget — أخطاء Redis
 * لا تكسر العملية الأصلية (الـ premium grant) لأن الـ audit ثانوي.
 */
async function appendAudit(
  userId: string,
  args: { action: "grant" | "revoke"; days: number; ctx?: PremiumGrantContext },
): Promise<void> {
  const entry: PremiumAuditEntry = {
    ts:     Date.now(),
    action: args.action,
    days:   args.days,
    by:     args.ctx?.by     ?? "unknown",
    source: args.ctx?.source ?? "system",
    ...(args.ctx?.reason ? { reason: args.ctx.reason } : {}),
  };
  try {
    const key = PREMIUM_AUDIT_KEY(userId);
    await redis.pipeline()
      .lpush(key, JSON.stringify(entry))
      .ltrim(key, 0, PREMIUM_AUDIT_MAX - 1)
      .exec();
  } catch (e) {
    L.warn("premium", "audit append failed (non-fatal)", { userId, err: String(e).slice(0, 80) });
  }
}

/**
 * يجيب آخر N entries من audit log لمستخدم.
 * يُستخدم في dashboard عند فتح ملف premium المستخدم.
 */
export async function getPremiumAudit(
  userId: string,
  limit  = 20,
): Promise<PremiumAuditEntry[]> {
  try {
    const raws = await redis.lrange(PREMIUM_AUDIT_KEY(userId), 0, Math.max(0, limit - 1));
    const out: PremiumAuditEntry[] = [];
    for (const raw of raws) {
      try { out.push(JSON.parse(raw) as PremiumAuditEntry); }
      catch { /* skip malformed entries */ }
    }
    return out;
  } catch { return []; }
}

/**
 * تاريخ انتهاء الاشتراك:
 *   null = منحة Admin (بلا انتهاء)
 *        OR منتهي/مش premium
 *   Date = اشتراك مدفوع ساري — التاريخ المتوقّع للانتهاء
 */
export async function getPremiumExpiry(userId: string): Promise<Date | null> {
  try {
    // لو فيه manual flag → بلا انتهاء
    const hasManual = await redis.exists(PREMIUM_MANUAL_KEY(userId));
    if (hasManual === 1) return null;

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

/**
 * منطق احتساب الحد اليومي بدون أي round-trip.
 *   - لو فيه ULIMIT override رقمي صالح → يفوز
 *   - وإلا: PREMIUM_LIMIT لو premium، DAILY_LIMIT خلاف ذلك
 */
export function computeDailyLimit(prem: boolean, override: string | null): number {
  if (override !== null) {
    const n = parseInt(override, 10);
    if (!isNaN(n)) return n;
  }
  return prem ? PREMIUM_LIMIT : DAILY_LIMIT;
}

/**
 * @param premHint  لو الـ caller حسب isPremium بنفسه فعلاً (مثلاً من pipeline أكبر)،
 *                  يمرّره هنا عشان ما نـ recall isPremium ونعمل round-trip زائد.
 */
export async function getUserDailyLimit(userId: string, premHint?: boolean): Promise<number> {
  try {
    const [prem, override] = await Promise.all([
      premHint !== undefined ? Promise.resolve(premHint) : isPremium(userId),
      redis.get(ULIMIT_KEY(userId)),
    ]);
    return computeDailyLimit(prem, override);
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
