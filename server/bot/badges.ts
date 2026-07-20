import { redis } from "./redis.js";
import { L } from "./logger.js";
import { storage } from "../storage.js";
import { getStreakState } from "./streak.js";

// ══════════════════════════════════════════════
// BADGES — شارات الإنجاز
//
// التخزين: Redis SET واحد لكل مستخدم
//   badges:{userId}  →  Set<badgeId>
//
// لما SADD ترجع 1 = أول مرة المستخدم يكسب البادج → نُرسل رسالة التهنئة.
// لما ترجع 0 = موجودة قبل كده → silent (atomic، لا race conditions).
//
// النظام مغلق-للقياس (closed-for-measurement): لا data-collection من
// مصدر خارجي، كل شرط يُحسب من بيانات موجودة فعلاً (totalDownloads،
// streak، إلخ). ده بيخلّي الفحص cheap (~3 redis ops في أسوأ حالة).
// ══════════════════════════════════════════════

const BADGES_KEY = (uid: string) => `badges:${uid}`;

export interface BadgeDef {
  id:          string;
  emoji:       string;
  name:        string;
  description: string;
  /** الترتيب في صفحة /profile (الأقل = الأول) */
  order:       number;
}

/**
 * قائمة الشارات الكاملة.
 *
 * ملاحظات على الـ thresholds:
 *   - 5/20/50/100/250 — تتدرج جذرياً عشان حد جديد محسوس كل مرة
 *   - streak 3/7/30 — مع milestones الـ streak عشان double-reward
 *   - summary10 — يكافئ استخدام الـ AI feature (التزام أعمق بالقراءة)
 *   - early — اللي عمل /start قبل تاريخ معيّن (loyalty)
 */
export const BADGES: BadgeDef[] = [
  { id: "first_dl",  emoji: "🌱", name: "الخطوة الأولى",   description: "حمّلت أول كتاب",                 order: 5 },
  { id: "dl5",       emoji: "📚", name: "قارئ مبتدئ",      description: "حمّلت أوّل ٥ كتب",            order: 10 },
  { id: "dl10",      emoji: "📗", name: "عشرة كاملة",      description: "١٠ كتب — بداية قوية",           order: 15 },
  { id: "dl20",      emoji: "📖", name: "قارئ منتظم",      description: "٢٠ كتاباً — العادة ثبتت",       order: 20 },
  { id: "dl50",      emoji: "🏆", name: "قارئ شغوف",       description: "٥٠ كتاباً — مستوى نادر",       order: 30 },
  { id: "dl100",     emoji: "🎓", name: "موسوعة مشت",      description: "١٠٠ كتاب — أنت مكتبة بحالك",  order: 40 },
  { id: "dl250",     emoji: "👑", name: "سيد المكتبة",     description: "٢٥٠ كتاباً — الأسطورة الحيّة",  order: 50 },
  { id: "streak3",   emoji: "🔥", name: "ثلاثة أيام",      description: "ثلاثة أيام متتالية من القراءة", order: 60 },
  { id: "streak7",   emoji: "🔥🔥", name: "أسبوع كامل",     description: "سبعة أيام متتالية",            order: 70 },
  { id: "streak14",  emoji: "🔥🔥🔥", name: "أسبوعان",      description: "أربعة عشر يوماً متتالية",      order: 75 },
  { id: "streak30",  emoji: "🌟", name: "شهر كامل",        description: "ثلاثون يوماً من الانضباط",     order: 80 },
  { id: "summary10", emoji: "📘", name: "ملخّصاتي",        description: "استخدمت ميزة الملخص ١٠ مرات",  order: 90 },
  { id: "quest7",    emoji: "🎯", name: "مهامّي أسبوع",    description: "٧ أيام أنهيت فيها المهمة اليومية", order: 95 },
  { id: "comeback",  emoji: "👋", name: "العائد",          description: "عدت بعد غياب ٣ أيام فأكثر",     order: 98 },
  { id: "social3",   emoji: "👥", name: "اجتماعي",         description: "دعوت ٣ أصدقاء انضمّوا للبوت", order: 100 },
  { id: "level5",    emoji: "⭐", name: "نجم صاعد",        description: "وصلت للمستوى ٥",               order: 110 },
];

const BADGES_BY_ID = new Map(BADGES.map(b => [b.id, b]));

// ── Thresholds (يجب أن تطابق دلالة الـ description) ──
const DOWNLOAD_THRESHOLDS = [
  { count: 1,   id: "first_dl" },
  { count: 5,   id: "dl5"   },
  { count: 10,  id: "dl10"  },
  { count: 20,  id: "dl20"  },
  { count: 50,  id: "dl50"  },
  { count: 100, id: "dl100" },
  { count: 250, id: "dl250" },
];

const STREAK_THRESHOLDS = [
  { count: 3,  id: "streak3"  },
  { count: 7,  id: "streak7"  },
  { count: 14, id: "streak14" },
  { count: 30, id: "streak30" },
];

const SUMMARY_THRESHOLD     = 10;
const SOCIAL_THRESHOLD      = 3;

// ──────────────────────────────────────────────

/**
 * إضافة badge لو غير موجودة. atomic.
 * ترجع true لو دي **أول مرة** المستخدم يكسبها (عشان الـ caller يُرسل رسالة).
 */
export async function tryAwardBadge(userId: string, id: string): Promise<BadgeDef | null> {
  if (await awardBadge(userId, id)) return BADGES_BY_ID.get(id) || null;
  return null;
}

async function awardBadge(userId: string, id: string): Promise<boolean> {
  try {
    const added = await redis.sadd(BADGES_KEY(userId), id);
    return added === 1;
  } catch (e) {
    L.warn("badges", "awardBadge failed", { userId, id, err: String(e).slice(0, 80) });
    return false;
  }
}

/**
 * فحص شامل بعد كل تحميل ناجح. يُعيد قائمة الـ badges المُكتسبة الآن
 * (مرتّبة بالـ order) عشان الـ caller يُرسل رسائل التهنئة.
 *
 * النية: نُستدعى من bookRequest.ts بنفس مكان incrementDailyDownload —
 * بعد ما الـ counter يتحدّث. الـ totalDownloads بقى محدث.
 *
 * Optional context (currentStreak): لو معاك القيمة من updateStreakOnDownload
 * استخدمها بدل ما نـ round-trip تاني للـ Redis.
 */
export async function checkAndAwardBadges(
  userId: string,
  currentStreak?: number,
): Promise<BadgeDef[]> {
  const newlyAwarded: BadgeDef[] = [];

  try {
    // Download badges — بناءً على totalDownloads من DB
    const user = await storage.getOrCreateUser(userId).catch(() => null);
    if (user) {
      const dl = user.totalDownloads ?? 0;
      for (const t of DOWNLOAD_THRESHOLDS) {
        if (dl >= t.count) {
          if (await awardBadge(userId, t.id)) {
            const def = BADGES_BY_ID.get(t.id);
            if (def) newlyAwarded.push(def);
          }
        }
      }
    }

    // Streak badges — بناءً على القيمة الممرّرة أو القراءة من Redis
    const streakVal = currentStreak ?? (await getStreakState(userId)).active;
    for (const t of STREAK_THRESHOLDS) {
      if (streakVal >= t.count) {
        if (await awardBadge(userId, t.id)) {
          const def = BADGES_BY_ID.get(t.id);
          if (def) newlyAwarded.push(def);
        }
      }
    }
  } catch (e) {
    L.warn("badges", "check failed", { userId, err: String(e).slice(0, 100) });
  }

  // ترتيب حسب order — عشان لو كسب اتنين سوا، نُظهر الأقل order أولاً
  newlyAwarded.sort((a, b) => a.order - b.order);
  return newlyAwarded;
}

// ──────────────────────────────────────────────

/**
 * فحص summary badge — يُستدعى من summaryHandler بعد كل ملخص ناجح.
 * Counter منفصل في Redis (sum:count:{uid}) لتجنّب الحاجة لقراءة DB.
 */
export async function trackSummaryAndAward(userId: string): Promise<BadgeDef | null> {
  try {
    const count = await redis.incr(`sum:count:${userId}`);
    if (count >= SUMMARY_THRESHOLD) {
      if (await awardBadge(userId, "summary10")) {
        return BADGES_BY_ID.get("summary10") || null;
      }
    }
  } catch {}
  return null;
}

/**
 * فحص social badge — يُستدعى من referral.ts لما referral count يوصل 3.
 */
export async function checkSocialBadge(userId: string, referralCount: number): Promise<BadgeDef | null> {
  if (referralCount < SOCIAL_THRESHOLD) return null;
  if (await awardBadge(userId, "social3")) {
    return BADGES_BY_ID.get("social3") || null;
  }
  return null;
}

// ──────────────────────────────────────────────

/**
 * قراءة badges المستخدم (لـ /profile).
 * مرتّبة بالـ order عشان العرض ثابت.
 */
export async function getUserBadges(userId: string): Promise<BadgeDef[]> {
  try {
    const ids = await redis.smembers(BADGES_KEY(userId));
    const defs: BadgeDef[] = [];
    for (const id of ids) {
      const def = BADGES_BY_ID.get(id);
      if (def) defs.push(def);
    }
    defs.sort((a, b) => a.order - b.order);
    return defs;
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────

/**
 * رسالة فردية لشارة جديدة (يُستدعى من bookRequest بعد التحميل).
 * بيظهر إجمالي الشارات اللي عند المستخدم بعد إضافة ديه.
 */
export async function buildNewBadgeMessage(userId: string, badge: BadgeDef): Promise<string> {
  let total = 0;
  try {
    total = await redis.scard(BADGES_KEY(userId));
  } catch {}
  const totalLine = total > 0 ? `\n_شارة ${total} من ${BADGES.length}_` : "";
  return (
    `🎉 *شارة جديدة!*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `${badge.emoji} *${badge.name}*\n` +
    `_${badge.description}_${totalLine}`
  );
}
