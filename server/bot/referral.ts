import { redis } from "./redis.js";
import { L } from "./logger.js";
import { setPremium, isPremium } from "./userSettings.js";
import { checkSocialBadge, buildNewBadgeMessage } from "./badges.js";
import { storage } from "../storage.js";
import { BANNED_USERS } from "./config.js";
import type TelegramBot from "node-telegram-bot-api";

// ══════════════════════════════════════════════
// REFERRAL SYSTEM — نظام الإحالة
//
// كيف يعمل:
//   1. كل user له رابط شخصي:  t.me/<bot>?start=ref_<userId>
//   2. لما حد جديد يضغط الرابط، Telegram يبعت /start ref_<userId>.
//   3. trackReferralOnStart() بتسجّل الإحالة لكن المكافأة لا تُمنح إلا بعد
//      ما المدعو يعمل أول تحميل ناجح (يحمي من الإحالات الميتة/الـ bots).
//   4. عند الـ activation، نَزيد ref:count للـ referrer ونفحص المستويات.
//
// Tiered rewards (مش دائم — كل مكافأة TTL extension عبر setPremium):
//   3 إحالات نشطة  →  +٧ أيام
//   5 إحالات      →  +١٤ يوم
//  10 إحالات      →  +٣٠ يوم
//  20 إحالات      →  +٦٠ يوم
//  50 إحالات      →  +٩٠ يوم
//   كل +٢٥ بعدها  →  +٩٠ يوم إضافية
//
// Welcome gift للمدعو نفسه: +٣ أيام Premium بعد أول تحميل ناجح
// (يخلّيه يجرّب الـ Premium → conversion rate أعلى).
//
// التخزين (Redis only):
//   ref:by:{newUid}        → string referrerUid (مرة واحدة، لا TTL)
//   ref:count:{uid}        → int عدد الإحالات النشطة (لا TTL)
//   ref:list:{uid}         → SET<uid> اللي دعاهم (للـ dedup + audit)
//   ref:activated:{uid}    → SET<uid> الإحالات اللي أكملت أول تحميل
//   ref:tiers:{uid}        → SET<int> مستويات اللي صرفناها (3, 5, 10, ...)
//   ref:welcome:{uid}      → "1" لو المدعو حصل على welcome gift (للـ idempotency)
// ══════════════════════════════════════════════

const REF_BY_KEY        = (uid: string) => `ref:by:${uid}`;
const REF_COUNT_KEY     = (uid: string) => `ref:count:${uid}`;
const REF_LIST_KEY      = (uid: string) => `ref:list:${uid}`;
const REF_ACTIVATED_KEY = (uid: string) => `ref:activated:${uid}`;
const REF_TIERS_KEY     = (uid: string) => `ref:tiers:${uid}`;
const REF_WELCOME_KEY   = (uid: string) => `ref:welcome:${uid}`;

// ── Tier table — مرتّبة من الأعلى للأقل عشان الفحص ──
//
// لما العدد يوصل قيمة معيّنة، نمنح المكافأة "مرة واحدة" (SADD).
// السقف الـ 50 ثم تكرار كل 25 = نمو خطّي يكافئ المستخدمين النشطين
// بدون permanent unlock.
interface TierReward {
  count: number;  // الحد الأدنى
  days:  number;  // أيام Premium المُضافة
}

const REFERRAL_TIERS: TierReward[] = [
  { count: 3,  days: 7  },
  { count: 5,  days: 14 },
  { count: 10, days: 30 },
  { count: 20, days: 60 },
  { count: 50, days: 90 },
];

const POST_50_INCREMENT     = 25;
const POST_50_REWARD_DAYS   = 90;

const WELCOME_GIFT_DAYS     = 3;

// ──────────────────────────────────────────────

export interface ReferralState {
  /** عدد الإحالات النشطة (counted-after-activation) */
  count:        number;
  /** قائمة مستويات صرفناها فعلاً */
  tiersClaimed: number[];
  /** المُكافأة التالية في الأفق + المتبقّي للوصول إليها */
  nextTier:     { count: number; days: number; remaining: number } | null;
}

/**
 * حساب الـ tier التالي بعد عدد معيّن.
 * Returns null لو ما فيش tiers تالية ضمن الجدول.
 */
function nextTierAfter(count: number): { count: number; days: number } | null {
  for (const t of REFERRAL_TIERS) {
    if (count < t.count) return { count: t.count, days: t.days };
  }
  // بعد الـ 50: كل 25 يضيف 90 يوم
  const last = REFERRAL_TIERS[REFERRAL_TIERS.length - 1].count;
  if (count < last) return null;
  const next = last + POST_50_INCREMENT * Math.floor((count - last) / POST_50_INCREMENT + 1);
  return { count: next, days: POST_50_REWARD_DAYS };
}

// ──────────────────────────────────────────────

/**
 * يُستدعى من /start handler إذا الـ payload فيه ref_<id>.
 *
 * خطوات:
 *   - تحقق إن newUid != referrerUid (no self-ref)
 *   - تحقق إن newUid لم يُسجَّل كـ referee قبل كده (ref:by موجود → ignore)
 *   - تحقق إن المستخدم الجديد فعلاً جديد:
 *       لو users.created_at قبل أكتر من ساعة → suspicious، ignore
 *       (المُحال يجب أن يدخل البوت لأول مرة من الرابط)
 *   - تحقق إن المُحيل غير محظور
 *
 * الـ activation (counted-after-first-download) بيحصل في
 * activateReferralOnFirstDownload() مش هنا. ده عشان الـ bots اللي
 * تـ /start من غير ما تكمّل لا تحتسب.
 *
 * Returns: true لو الإحالة اتسجّلت بنجاح (للـ logging فقط).
 */
export async function trackReferralOnStart(
  newUid: string,
  referrerUid: string,
): Promise<boolean> {
  try {
    if (!newUid || !referrerUid) return false;
    if (newUid === referrerUid) {
      L.debug("referral", "self-referral ignored", { newUid });
      return false;
    }
    if (BANNED_USERS.has(referrerUid)) {
      L.debug("referral", "banned referrer ignored", { referrerUid });
      return false;
    }
    if (BANNED_USERS.has(newUid)) {
      L.debug("referral", "banned referee ignored", { newUid });
      return false;
    }

    // SET NX — atomic: ينجح فقط لو الـ key مش موجود
    const set = await redis.set(REF_BY_KEY(newUid), referrerUid, "NX");
    if (set !== "OK") {
      // المستخدم اتسجّل قبل كده مع referrer مختلف (أو نفس ده) → ignore
      return false;
    }

    // تحقق من الـ user حقيقي جديد: لو موجود في DB قبل أكتر من ساعة
    // فالأرجح إنه استخدم البوت من قبل → نلغي الإحالة عشان ما يستغلش
    // الـ system بحساب قديم تلاعب بيه.
    const user = await storage.getOrCreateUser(newUid).catch(() => null);
    if (user?.createdAt) {
      const ageMs = Date.now() - user.createdAt.getTime();
      if (ageMs > 60 * 60 * 1000) {
        L.info("referral", "referee too old — rejecting", { newUid, referrerUid, ageMs });
        await redis.del(REF_BY_KEY(newUid)).catch(() => {});
        return false;
      }
    }

    L.info("referral", "tracked (pending activation)", { newUid, referrerUid });
    return true;
  } catch (e) {
    L.warn("referral", "trackReferralOnStart failed", { err: String(e).slice(0, 100) });
    return false;
  }
}

// ──────────────────────────────────────────────

/**
 * يُستدعى بعد كل تحميل ناجح. لو ده أول تحميل للمدعو ولّى ref:by موجود
 * → نُفعِّل الإحالة (ref:activated SADD، increment ref:count) ونُرجع
 * رسائل النوتيفيكيشن.
 *
 * idempotent: SADD ترجع 1 فقط مرة واحدة (أول activation).
 */
export interface ReferralActivation {
  /** رسالة للمُحال (referrer) — مرة واحدة عند الـ activation */
  notifyReferrer: { referrerUid: string; text: string } | null;
  /** رسالة للمدعو نفسه (welcome gift) — مرة واحدة */
  welcomeGift: { text: string } | null;
  /** هل وصل tier جديد + التفاصيل (لـ messaging مفصّل) */
  tierUnlocked: { count: number; days: number } | null;
  /** social badge جديد لو المُحيل وصل 3 إحالات */
  newBadge: string | null;
}

export async function activateReferralOnFirstDownload(
  newUid: string,
): Promise<ReferralActivation> {
  const result: ReferralActivation = {
    notifyReferrer: null,
    welcomeGift:    null,
    tierUnlocked:   null,
    newBadge:       null,
  };

  try {
    const referrerUid = await redis.get(REF_BY_KEY(newUid));
    if (!referrerUid) return result;

    // SADD — atomic: 1 لو دي أول مرة، 0 لو مفعّل قبل كده
    const added = await redis.sadd(REF_ACTIVATED_KEY(referrerUid), newUid);
    if (added !== 1) return result;

    // ✅ مفعّل أول مرة — increment counter
    const newCount = await redis.incr(REF_COUNT_KEY(referrerUid));

    // ── Welcome gift للمدعو ──
    // مرة واحدة فقط (idempotent عبر REF_WELCOME_KEY NX)
    try {
      const claimed = await redis.set(REF_WELCOME_KEY(newUid), "1", "NX");
      if (claimed === "OK") {
        await setPremium(newUid, true, WELCOME_GIFT_DAYS, {
          by:     "system",
          source: "system",
          reason: `referral_welcome_from_${referrerUid}`,
        });
        result.welcomeGift = {
          text:
            `🎁 *هدية ترحيبية!*\n` +
            `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
            `لأنك دخلت عبر دعوة صديق، حصلت على *${WELCOME_GIFT_DAYS} أيام Premium مجاني* ⭐\n\n` +
            `_جرّب الـ Premium وشوف الفرق — حد يومي أعلى وأولوية في الطابور._`,
        };
      }
    } catch (e) {
      L.warn("referral", "welcome gift failed", { newUid, err: String(e).slice(0, 80) });
    }

    // ── فحص الـ tier للـ referrer ──
    const tier = await maybeAwardTier(referrerUid, newCount);
    if (tier) {
      result.tierUnlocked = tier;
    }

    // ── Social badge ──
    const badge = await checkSocialBadge(referrerUid, newCount);
    if (badge) {
      result.newBadge = await buildNewBadgeMessage(referrerUid, badge);
    }

    // ── رسالة للـ referrer ──
    let text: string;
    if (tier) {
      text =
        `🎉 *إحالة جديدة + مكافأة!*\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `صديقك انضم وأكمل أول تحميل — وصلت لـ *${newCount} إحالة*!\n\n` +
        `🎁 مكافأتك: *+${tier.days} أيام Premium* ⭐\n` +
        `_تمت إضافتها لاشتراكك تلقائياً._`;
    } else {
      const next = nextTierAfter(newCount);
      const progress = next
        ? `\n\n📊 تقدمك: *${newCount}* إحالة — صديق ${next.count - newCount} لمكافأة *+${next.days} يوم* 🚀`
        : "";
      text =
        `🎉 *صديقك انضم وأكمل أول تحميل!*\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
        `إحالاتك النشطة: *${newCount}*${progress}`;
    }

    result.notifyReferrer = { referrerUid, text };
    return result;
  } catch (e) {
    L.warn("referral", "activateReferralOnFirstDownload failed", { newUid, err: String(e).slice(0, 100) });
    return result;
  }
}

// ──────────────────────────────────────────────

/**
 * فحص ومنح tier reward. مرّة واحدة فقط لكل tier (SADD ref:tiers).
 * يدعم tiers مفهرسة ضمن REFERRAL_TIERS + الـ post-50 increment system.
 */
async function maybeAwardTier(referrerUid: string, count: number): Promise<{ count: number; days: number } | null> {
  // اعثر على tier ينطبق "بالضبط" أو "أعلى" مما صُرف
  let target: { count: number; days: number } | null = null;

  for (const t of REFERRAL_TIERS) {
    if (count >= t.count) {
      const already = await redis.sismember(REF_TIERS_KEY(referrerUid), String(t.count));
      if (already === 0) {
        target = t;
        break;
      }
    }
  }

  // post-50: tiers ديناميكية كل 25
  if (!target && count > REFERRAL_TIERS[REFERRAL_TIERS.length - 1].count) {
    const last = REFERRAL_TIERS[REFERRAL_TIERS.length - 1].count;
    const surplus = count - last;
    const reachedTier = last + POST_50_INCREMENT * Math.floor(surplus / POST_50_INCREMENT);
    if (reachedTier > last) {
      const already = await redis.sismember(REF_TIERS_KEY(referrerUid), String(reachedTier));
      if (already === 0) {
        target = { count: reachedTier, days: POST_50_REWARD_DAYS };
      }
    }
  }

  if (!target) return null;

  // SADD — لو نجح فعلياً (مش race) نمنح الـ Premium
  const added = await redis.sadd(REF_TIERS_KEY(referrerUid), String(target.count));
  if (added !== 1) return null;

  try {
    await setPremium(referrerUid, true, target.days, {
      by:     "system",
      source: "system",
      reason: `referral_tier_${target.count}`,
    });
  } catch (e) {
    L.warn("referral", "setPremium failed at tier reward — rolling back tier flag", {
      referrerUid, tier: target.count, err: String(e).slice(0, 80),
    });
    // rollback عشان الـ user يقدر يحصل عليها مرة تانية
    await redis.srem(REF_TIERS_KEY(referrerUid), String(target.count)).catch(() => {});
    return null;
  }

  L.info("referral", "tier awarded", { referrerUid, tier: target.count, days: target.days });
  return target;
}

// ──────────────────────────────────────────────

/**
 * قراءة state الإحالات لمستخدم — لـ /invite.
 */
export async function getReferralState(userId: string): Promise<ReferralState> {
  try {
    const [count, tiers] = await Promise.all([
      redis.get(REF_COUNT_KEY(userId)),
      redis.smembers(REF_TIERS_KEY(userId)),
    ]);

    const c = parseInt(count || "0", 10) || 0;
    const t = tiers.map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

    const next = nextTierAfter(c);
    return {
      count: c,
      tiersClaimed: t,
      nextTier: next ? { ...next, remaining: next.count - c } : null,
    };
  } catch {
    return { count: 0, tiersClaimed: [], nextTier: null };
  }
}

// ──────────────────────────────────────────────

/**
 * بناء رابط الدعوة. يعتمد على getBotUsername() اللي بيتم تمريرها للـ commands.
 */
export function buildReferralLink(botUsername: string, userId: string): string {
  return `https://t.me/${botUsername}?start=ref_${userId}`;
}

/**
 * بناء رسالة /invite.
 */
export async function buildInviteMessage(
  userId: string,
  botUsername: string,
): Promise<{ text: string; link: string }> {
  const state = await getReferralState(userId);
  const link  = buildReferralLink(botUsername, userId);

  let progress = "";
  if (state.nextTier) {
    const filled = Math.max(0, state.count);
    const total  = state.nextTier.count;
    const filledBars = Math.round((filled / total) * 8);
    const bar = "🟩".repeat(Math.min(filledBars, 8)) + "⬜".repeat(Math.max(0, 8 - filledBars));
    // FIX (PR #102): old version was `_X *Y* X_` — nested italic+bold isn't
    // supported by Telegram's old Markdown parser, and an unmatched leading
    // `_` after "انضمامه." combined with this would yield
    // "can't parse entities" 400 errors on every /invite call.
    progress =
      `\n\n📊 *تقدمك:* ${state.count} من ${state.nextTier.count}\n` +
      `${bar}\n` +
      `*${state.nextTier.remaining}* إحال${state.nextTier.remaining === 1 ? "ة" : "ات"} للوصول إلى *+${state.nextTier.days} يوم Premium*`;
  } else if (state.count > 0) {
    progress = `\n\n📊 *إحالاتك:* ${state.count}\n_وصلت لكل المستويات المتاحة — استمر للحصول على +90 يوم كل 25 إحالة._`;
  }

  const tiersClaimedLine = state.tiersClaimed.length > 0
    ? `\n\n🏆 _مستويات صرفتها:_ ${state.tiersClaimed.map(t => `\`${t}\``).join(" · ")}`
    : "";

  const text =
    `🎁 *ادعُ صديقاً واحصل على Premium مجاني!*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
    `🔗 رابط الدعوة الخاص بك:\n` +
    `\`${link}\`\n\n` +
    `📋 *المكافآت:*\n` +
    `◦ ٣ إحالات → *+٧ أيام Premium*\n` +
    `◦ ٥ إحالات → *+١٤ يوم*\n` +
    `◦ ١٠ إحالات → *+٣٠ يوم*\n` +
    `◦ ٢٠ إحالات → *+٦٠ يوم*\n` +
    `◦ ٥٠ إحالة → *+٩٠ يوم*\n` +
    `◦ كل ٢٥ إحالة بعدها → *+٩٠ يوم*\n\n` +
    `🎁 صديقك يحصل على *${WELCOME_GIFT_DAYS} أيام Premium* مجاناً عند انضمامه.${progress}${tiersClaimedLine}\n\n` +
    `💡 *تنبيه:* الإحالة تُحتسب فقط بعد ما صديقك يحمّل أول كتاب — لمنع التحايل بحسابات وهمية.`;

  return { text, link };
}

// ──────────────────────────────────────────────

/**
 * يُستدعى من activateReferralOnFirstDownload لإرسال الإشعارات.
 * Wrapper بسيط على bot.sendMessage مع error swallowing.
 */
export async function sendReferralNotifications(
  bot: TelegramBot,
  activation: ReferralActivation,
  newUid: string,
  newUserChatId: number,
): Promise<void> {
  try {
    if (activation.welcomeGift) {
      await bot.sendMessage(newUserChatId, activation.welcomeGift.text, { parse_mode: "Markdown" }).catch(() => {});
    }

    if (activation.notifyReferrer) {
      const referrerUid = activation.notifyReferrer.referrerUid;
      // chatId = userId في الـ private chats. لو الـ user عمل /start قبل كده،
      // chatId هو نفسه. لو ما عملش، الإرسال هيفشل (silent).
      await bot.sendMessage(referrerUid, activation.notifyReferrer.text, { parse_mode: "Markdown" }).catch(() => {});
    }

    if (activation.newBadge && activation.notifyReferrer) {
      await bot.sendMessage(activation.notifyReferrer.referrerUid, activation.newBadge, { parse_mode: "Markdown" }).catch(() => {});
    }
  } catch (e) {
    L.warn("referral", "notify send failed", { newUid, err: String(e).slice(0, 80) });
  }
}
