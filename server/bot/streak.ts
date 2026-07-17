import { redis } from "./redis.js";
import { cairoDateString } from "./text.js";
import { L } from "./logger.js";

// ══════════════════════════════════════════════
// STREAK — سلسلة القراءة اليومية
//
// كل يوم Cairo فيه تحميل ناجح واحد على الأقل = +1 للسلسلة.
// لو فات يوم كامل بدون تحميل → الـ streak يرجع 1 (مش 0 — اليوم
// الحالي يحتسب ابتداءً من التحميل اللي شغّل الـ check).
//
// التخزين كله في Redis (لا migration، لا تغيير schema):
//   streak:cur:{userId}    int — السلسلة الحالية
//   streak:last:{userId}   string YYYY-MM-DD — آخر يوم تَزايَدَت فيه
//   streak:max:{userId}    int — أعلى رقم وصلت إليه (للعرض في /profile)
//
// المفتاح الأساسي = telegramUserId (نفس مفتاح daily_limits / premium).
// آمن من تغيير اليوزرنيم، الخروج من المجموعة، مسح المحادثة.
// ══════════════════════════════════════════════

const STREAK_CUR_KEY  = (uid: string) => `streak:cur:${uid}`;
const STREAK_LAST_KEY = (uid: string) => `streak:last:${uid}`;
const STREAK_MAX_KEY  = (uid: string) => `streak:max:${uid}`;

// Milestones تستحق رسالة فرحة منفصلة بعد رسالة النجاح.
// أرقام مختارة ليبقى الـ feedback متكرر للأسبوع الأول
// (3, 7) ثم يخفّ ليحافظ على معناها (14, 30, 60, 100).
export const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100] as const;

// Threshold الـ "خسرت سلسلة" — لا نُزعج المستخدم برسالة فقد
// لو السلسلة كانت قصيرة جداً (1-2 يوم). يبدأ التذكير من 3.
const STREAK_BREAK_NOTIFY_MIN = 3;

// ── Lua script: atomic update ────────────────
//
// Race conditions: لو user عمل تحميلين متتاليين في نفس الثانية،
// ممكن ينقرأ نفس الـ "last" وينعمل INCR مرتين → السلسلة تقفز +2
// في يوم واحد. الـ Lua script يضمن read-modify-write ذرّي.
//
// Returns: { current:int, max:int, transitioned:int, broken:int }
//   - transitioned = 1 لو اليوم اتغير (سواء +1 أو reset)
//   - broken = previous-streak لو كان ≥ STREAK_BREAK_NOTIFY_MIN واتكسر
//             0 خلاف ذلك
const streakUpdateLua = `
local kCur  = KEYS[1]
local kLast = KEYS[2]
local kMax  = KEYS[3]
local today = ARGV[1]
local yesterday = ARGV[2]

local last = redis.call('GET', kLast)
local prevStreak = tonumber(redis.call('GET', kCur)) or 0
local cur
local transitioned = 0
local broken = 0

if last == today then
  cur = prevStreak > 0 and prevStreak or 1
  if prevStreak == 0 then
    redis.call('SET', kCur, '1')
    transitioned = 1
  end
elseif last == yesterday then
  cur = redis.call('INCR', kCur)
  redis.call('SET', kLast, today)
  transitioned = 1
else
  cur = 1
  redis.call('SET', kCur, '1')
  redis.call('SET', kLast, today)
  transitioned = 1
  if prevStreak >= ${STREAK_BREAK_NOTIFY_MIN} then
    broken = prevStreak
  end
end

local maxNum = tonumber(redis.call('GET', kMax)) or 0
if cur > maxNum then
  redis.call('SET', kMax, cur)
  maxNum = cur
end

return {cur, maxNum, transitioned, broken}
`;

// ── Pure date arithmetic ─────────────────────
//
// نعتمد parsing string بدل subtractMs(24h) عشان نتجنب
// الكوارث المحتملة في يوم تحويل الـ DST. صحيح إن مصر مش
// بتتبع DST دلوقتي، لكن لو غيّروا في 2027 السلسلة لازم تفضل صح.
function yesterdayOf(todayCairo: string): string {
  const m = todayCairo.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return todayCairo;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ──────────────────────────────────────────────

export interface StreakUpdate {
  /** السلسلة الحالية بعد التحديث */
  current: number;
  /** أعلى سلسلة وصلها هذا المستخدم في تاريخه */
  max: number;
  /** هل اليوم تَجدّد للتو (مفيد لإظهار رسالة milestone) */
  transitioned: boolean;
  /** لو > 0: كانت سلسلة طويلة وانكسرت، نُظهر رسالة "خسرت" مرة واحدة */
  brokenStreak: number;
  /** هل وصل اليوم لـ milestone جديد (3/7/14/30/60/100) */
  milestoneReached: number | null;
}

/**
 * يُستدعى بعد كل تحميل ناجح. atomic، fail-open.
 * يُعيد {current, max, transitioned, brokenStreak, milestoneReached}.
 *
 * ملاحظة على الـ failure mode:
 *   - لو Redis مات → نُعيد {0, 0, false, 0, null} (الـ caller يتجاهل الـ streak ولا يُعطّل التحميل).
 *   - الـ Lua atomic، فلو شغّال بيدّي نتيجة مضمونة.
 */
export async function updateStreakOnDownload(userId: string): Promise<StreakUpdate> {
  const today = cairoDateString();
  const yest  = yesterdayOf(today);

  try {
    const result = await (redis as any).eval(
      streakUpdateLua,
      3,
      STREAK_CUR_KEY(userId),
      STREAK_LAST_KEY(userId),
      STREAK_MAX_KEY(userId),
      today,
      yest,
    ) as [number, number, number, number];

    const [cur, max, trans, broken] = result;

    let milestoneReached: number | null = null;
    if (trans === 1) {
      // milestone فقط لو وصلنا للقيمة بالظبط اليوم (مش لما بنعدّيها)
      for (const m of STREAK_MILESTONES) {
        if (cur === m) {
          milestoneReached = m;
          break;
        }
      }
    }

    return {
      current: cur,
      max,
      transitioned: trans === 1,
      brokenStreak: broken,
      milestoneReached,
    };
  } catch (e) {
    L.warn("streak", "update failed", { userId, err: String(e).slice(0, 100) });
    return { current: 0, max: 0, transitioned: false, brokenStreak: 0, milestoneReached: null };
  }
}

// ──────────────────────────────────────────────

export interface StreakState {
  /** السلسلة "النشطة" اليوم (لو الـ last ليس today/yesterday → 0) */
  active: number;
  /** آخر قيمة مسجلة (حتى لو انكسرت) */
  raw: number;
  /** أعلى قيمة وصل إليها */
  max: number;
}

/**
 * قراءة بدون تعديل — لـ /profile.
 *
 * "active" تختلف عن "raw":
 *   raw   = streak:cur:{uid} مباشرة (آخر قيمة كُتبت)
 *   active = raw لو last ∈ {today, yesterday}، 0 لو أقدم
 *
 * المعنى: "active=4" تعني "السلسلة الحالية 4 أيام، استمر اليوم"
 * بينما "raw=4 + active=0" تعني "كان عندك سلسلة 4 لكن انكسرت"
 */
export async function getStreakState(userId: string): Promise<StreakState> {
  try {
    const today = cairoDateString();
    const yest  = yesterdayOf(today);
    const res = await redis.pipeline()
      .get(STREAK_CUR_KEY(userId))
      .get(STREAK_LAST_KEY(userId))
      .get(STREAK_MAX_KEY(userId))
      .exec();
    if (!res) return { active: 0, raw: 0, max: 0 };

    const raw  = parseInt((res[0]?.[1] as string) || "0", 10) || 0;
    const last = (res[1]?.[1] as string) || "";
    const max  = parseInt((res[2]?.[1] as string) || "0", 10) || 0;

    const active = (last === today || last === yest) ? raw : 0;
    return { active, raw, max };
  } catch {
    return { active: 0, raw: 0, max: 0 };
  }
}

// ──────────────────────────────────────────────

/**
 * نص قصير للعرض في رسالة النجاح. بياخد الـ result من updateStreakOnDownload.
 * نُظهر السلسلة فقط لو ≥ 2 يوم — اليوم الأول مش مثير.
 */
export function formatStreakLine(s: StreakUpdate): string | null {
  if (s.current < 2) return null;
  const fire =
    s.current >= 30 ? "🌟" :
    s.current >= 14 ? "🔥🔥🔥" :
    s.current >= 7  ? "🔥🔥" :
    "🔥";
  const maxPart = s.max > s.current ? ` · أعلى: ${s.max}` : "";
  return `${fire} سلسلة ${s.current} يوم${maxPart}`;
}

/**
 * الرسالة المنفصلة للـ milestone — تُرسل بعد رسالة النجاح بثانية
 * عشان يبقى لها وقع بصري.
 */
export function buildMilestoneMessage(milestone: number): string {
  switch (milestone) {
    case 3:
      return `🔥 *ثلاثة أيام متتالية!*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n_عادة لطيفة قد بدأت… من دون أن نثقّل عليك._ ✨`;
    case 7:
      return `🔥🔥 *أسبوع كامل!*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n_شغف القراءة هنا حقيقي — أنت في الـ 5% الأعلى_ 🌟`;
    case 14:
      return `🔥🔥🔥 *أسبوعين!*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n_مستوى استثنائي — حتى القرّاء المحترفون يعتبرونك مرجع_ 🏆`;
    case 30:
      return `🌟 *شهر كامل!*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n_شهر كامل مع رفيق — إن أحببت، ادعُ صديقاً بلطف_ 👑`;
    case 60:
      return `🌟🌟 *شهرين متتاليين!*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n_مستوى نادر جداً — أنت في الـ 0.1% الأعلى_ 💎`;
    case 100:
      return `💎 *مائة يوم!*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n_أسطوري بكل المقاييس — هل تحب أن نوثّق تجربتك؟_ ✨`;
    default:
      return `🔥 *سلسلة ${milestone} يوم!*\n_استمر — أنت في طريق صعب يسلكه القلائل_ 🚀`;
  }
}

/**
 * رسالة كسر السلسلة — تُرسل مرة واحدة بعد التحميل اللي بدأ سلسلة جديدة.
 * Threshold: نُظهرها فقط لو الـ broken ≥ 3 (لا نُزعج بسلاسل صغيرة).
 */
export function buildBrokenStreakMessage(broken: number): string {
  return `🌿 *انقطعت سلسلة ${broken} يوم*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n_أمر طبيعي. ابدأ من جديد بهدوء… ورفيق ما زال معك._ ✨`;
}
