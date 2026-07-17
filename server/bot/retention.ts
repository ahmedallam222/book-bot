// ══════════════════════════════════════════════
// RETENTION — رفيق: عادة خفيفة بلا إجبار
//
// فلسفة:
//   • الحضور اليومي (/daily) هو الأساس — مش عدد التحميلات
//   • «لفتة اليوم» اختيارية (اكتشاف / ملخص / صورة) — بونص لا عقوبة
//   • التحميل يمنح XP بهدوء ولا يظهر كمهمة إجبارية
//   • إشعار صباحي دافئ + تذكير مسائي لطيف (بلا ضغط)
//   • مكافأة عودة بعد غياب · درع سلسلة أسبوعي
//
// التخزين: Redis فقط. fail-open.
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { cairoDateString, cairoHourNumber, escMd } from "./text.js";
import {
  BOT_NAME,
  WARM_DAILY_NOTES,
  WARM_EVENING_NOTES,
} from "./brand.js";
import { bookOfDayMorningBlock, kbBookOfDayAsync } from "./bookOfDay.js";
import { sendSundayWeekReports, getPersonalWeekStats } from "./personalWeek.js";
import { getTopInterests } from "./interests.js";
import { getPref } from "./notifPrefs.js";
import { isFeatureOn } from "./featureFlags.js";
import { hasAnsweredMicro, buildMicroMessage } from "./microHabit.js";
import { runGroupClubWeeklyPosts } from "./groupClub.js";

const QUEST_KEY     = (uid: string, day: string) => `ret:quest:${uid}:${day}`;
const QUEST_DONE    = (uid: string, day: string) => `ret:qdone:${uid}:${day}`;
const XP_KEY        = (uid: string) => `ret:xp:${uid}`;
const LEVEL_KEY     = (uid: string) => `ret:lvl:${uid}`;
const COMEBACK_KEY  = (uid: string) => `ret:comeback:${uid}`;
const SHIELD_KEY    = (uid: string) => `ret:shield_week:${uid}`;
const REMIND_KEY    = (day: string) => `ret:reminded:${day}`;
const MORNING_KEY   = (day: string) => `ret:morning:${day}`;
const DAILY_CLAIM   = (uid: string, day: string) => `ret:dclaim:${uid}:${day}`;
const VISIT_STREAK  = (uid: string) => `ret:vstreak:${uid}`;
const VISIT_LAST    = (uid: string) => `ret:vlast:${uid}`;

// ── XP (هادئ — مش grind) ─────────────────────
export const XP = {
  DOWNLOAD:       8,
  CACHE_HIT:      3,
  SUMMARY:        12,
  IMAGE:          10,
  RANDOM:         8,
  QUEST_COMPLETE: 18,
  DAILY_CLAIM:    12,
  STREAK_DAY:     5,
  COMEBACK:       18,
} as const;

const LEVEL_THRESHOLDS = [0, 40, 100, 180, 280, 420, 600, 850, 1150, 1550, 2100, 2800];

export function levelFromXp(xp: number): number {
  let lvl = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]) lvl = i + 1;
    else break;
  }
  if (xp >= LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1]) {
    const extra = xp - LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
    lvl = LEVEL_THRESHOLDS.length + Math.floor(extra / 1000);
  }
  return Math.max(1, lvl);
}

export function xpToNextLevel(xp: number): { level: number; nextAt: number; remaining: number } {
  const level = levelFromXp(xp);
  let nextAt: number;
  if (level < LEVEL_THRESHOLDS.length) {
    nextAt = LEVEL_THRESHOLDS[level];
  } else {
    const base = LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
    const beyond = level - LEVEL_THRESHOLDS.length;
    nextAt = base + (beyond + 1) * 1000;
  }
  return { level, nextAt, remaining: Math.max(0, nextAt - xp) };
}

// ── لفتات اختيارية (مش كوتا تحميل) ───────────
/** checkin = يكتمل تلقائياً مع /daily · الباقي فضول اختياري */
export type QuestType =
  | "checkin"
  | "explore_random"
  | "summary_soft"
  | "image_soft"
  | "curious_touch";

export interface DailyQuest {
  type:        QuestType;
  title:       string;
  description: string;
  target:      number;
  progress:    number;
  done:        boolean;
  rewardXp:    number;
  optional:    boolean;
}

const QUEST_ROTATION: QuestType[] = [
  "checkin",
  "explore_random",
  "checkin",
  "summary_soft",
  "curious_touch",
  "checkin",
  "image_soft",
];

function questTypeForDay(day: string): QuestType {
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) >>> 0;
  return QUEST_ROTATION[h % QUEST_ROTATION.length];
}

function questMeta(type: QuestType): { title: string; description: string; target: number; optional: boolean } {
  switch (type) {
    case "checkin":
      return {
        title: "سجّل حضورك",
        description: "اضغط الزرّ أو /daily — يكفي أن تفتح البوت اليوم. لا يُطلب منك تحميل كتاب",
        target: 1,
        optional: false,
      };
    case "explore_random":
      return {
        title: "اكتشف كتاباً (اختياري)",
        description: "اختياري: اضغط «كتاب مفاجأة» أو اكتب /random",
        target: 1,
        optional: true,
      };
    case "summary_soft":
      return {
        title: "ملخّص كتاب (اختياري)",
        description: "اختياري: بعد تحميل كتاب اضغط «ملخّص سريع»",
        target: 1,
        optional: true,
      };
    case "image_soft":
      return {
        title: "صورة بالذكاء (اختياري)",
        description: "اختياري: اكتب /img ثمّ وصف الصورة",
        target: 1,
        optional: true,
      };
    case "curious_touch":
      return {
        title: "أي نشاط بسيط (اختياري)",
        description: "اختياري: ابحث عن كتاب أو جرّب مفاجأة أو ملخّصاً أو صورة",
        target: 1,
        optional: true,
      };
  }
}

interface QuestProg {
  claim: number;
  random: number;
  sum: number;
  img: number;
  touch: number;
  dl: number;
}

async function getQuestProgress(userId: string, day: string): Promise<QuestProg> {
  try {
    const raw = await redis.hgetall(QUEST_KEY(userId, day));
    return {
      claim:  parseInt(raw?.claim  || "0", 10) || 0,
      random: parseInt(raw?.random || "0", 10) || 0,
      sum:    parseInt(raw?.sum    || "0", 10) || 0,
      img:    parseInt(raw?.img    || "0", 10) || 0,
      touch:  parseInt(raw?.touch  || "0", 10) || 0,
      dl:     parseInt(raw?.dl     || "0", 10) || 0,
    };
  } catch {
    return { claim: 0, random: 0, sum: 0, img: 0, touch: 0, dl: 0 };
  }
}

export async function getDailyQuest(userId: string): Promise<DailyQuest> {
  const day = cairoDateString();
  const type = questTypeForDay(day);
  const meta = questMeta(type);
  const prog = await getQuestProgress(userId, day);
  const claimed = (await redis.get(DAILY_CLAIM(userId, day)).catch(() => null)) === "1";

  let progress = 0;
  switch (type) {
    case "checkin":
      progress = claimed || prog.claim > 0 ? 1 : 0;
      break;
    case "explore_random":
      progress = prog.random;
      break;
    case "summary_soft":
      progress = prog.sum;
      break;
    case "image_soft":
      progress = prog.img;
      break;
    case "curious_touch": {
      const any =
        prog.touch > 0 ||
        prog.random > 0 ||
        prog.sum > 0 ||
        prog.img > 0 ||
        prog.dl > 0 ||
        claimed ||
        prog.claim > 0;
      progress = any ? 1 : 0;
      break;
    }
  }

  const doneFlag = await redis.get(QUEST_DONE(userId, day)).catch(() => null);
  const done = doneFlag === "1" || progress >= meta.target;

  return {
    type,
    title: meta.title,
    description: meta.description,
    target: meta.target,
    progress: Math.min(progress, meta.target),
    done,
    rewardXp: XP.QUEST_COMPLETE,
    optional: meta.optional,
  };
}

async function bumpField(userId: string, field: string, n = 1): Promise<void> {
  const day = cairoDateString();
  try {
    await redis.hincrby(QUEST_KEY(userId, day), field, n);
    await redis.expire(QUEST_KEY(userId, day), 3 * 86400).catch(() => {});
  } catch { /* */ }
}

async function maybeCompleteQuest(userId: string): Promise<{ completed: boolean; quest?: DailyQuest; leveledUp?: number }> {
  const day = cairoDateString();
  const quest = await getDailyQuest(userId);
  if (quest.done && (await redis.get(QUEST_DONE(userId, day)).catch(() => null)) === "1") {
    return { completed: false, quest };
  }
  if (quest.progress < quest.target) return { completed: false, quest };

  const set = await redis.set(QUEST_DONE(userId, day), "1", "EX", 3 * 86400, "NX").catch(() => null);
  if (set !== "OK") return { completed: false, quest: { ...quest, done: true } };

  try {
    const last = await redis.get(VISIT_LAST(userId));
    const yest = yesterdayOf(day);
    if (last === yest) await redis.incr(VISIT_STREAK(userId));
    else await redis.set(VISIT_STREAK(userId), "1");
    await redis.set(VISIT_LAST(userId), day);
  } catch { /* */ }

  const { leveledUp } = await addXp(userId, XP.QUEST_COMPLETE);
  redis.incr("tel:retention:quest_complete").catch(() => {});
  return { completed: true, quest: { ...quest, done: true, progress: quest.target }, leveledUp: leveledUp ?? undefined };
}

function yesterdayOf(day: string): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return day;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ── XP ────────────────────────────────────────
export async function addXp(userId: string, amount: number): Promise<{ xp: number; level: number; leveledUp: number | null }> {
  try {
    const xp = await redis.incrby(XP_KEY(userId), amount);
    const level = levelFromXp(xp);
    const prev = parseInt((await redis.get(LEVEL_KEY(userId))) || "1", 10) || 1;
    if (level > prev) {
      await redis.set(LEVEL_KEY(userId), String(level));
      redis.incr("tel:retention:level_up").catch(() => {});
      return { xp, level, leveledUp: level };
    }
    if (prev === 1 && !(await redis.get(LEVEL_KEY(userId)))) {
      await redis.set(LEVEL_KEY(userId), "1");
    }
    return { xp, level, leveledUp: null };
  } catch {
    return { xp: 0, level: 1, leveledUp: null };
  }
}

export async function getXpState(userId: string): Promise<{ xp: number; level: number; remaining: number; nextAt: number }> {
  try {
    const xp = parseInt((await redis.get(XP_KEY(userId))) || "0", 10) || 0;
    const info = xpToNextLevel(xp);
    return { xp, level: info.level, remaining: info.remaining, nextAt: info.nextAt };
  } catch {
    return { xp: 0, level: 1, remaining: 40, nextAt: 40 };
  }
}

// ── Hooks ─────────────────────────────────────
export interface RetentionHookResult {
  messages: string[];
}

export async function onSuccessfulDownload(
  userId: string,
  opts: { fromCache?: boolean; streakTransitioned?: boolean },
): Promise<RetentionHookResult> {
  const messages: string[] = [];
  await bumpField(userId, "dl");
  await bumpField(userId, "touch");

  await addXp(userId, opts.fromCache ? XP.CACHE_HIT : XP.DOWNLOAD);
  if (opts.streakTransitioned) await addXp(userId, XP.STREAK_DAY);

  const comeback = await maybeComebackBonus(userId);
  if (comeback) messages.push(comeback);

  const q = await maybeCompleteQuest(userId);
  if (q.completed && q.quest) {
    messages.push(buildQuestCompleteMessage(q.quest));
    if (q.leveledUp) messages.push(buildLevelUpMessage(q.leveledUp));
  }

  return { messages };
}

export async function onSuccessfulSummary(userId: string): Promise<RetentionHookResult> {
  const messages: string[] = [];
  await bumpField(userId, "sum");
  await bumpField(userId, "touch");

  const { leveledUp } = await addXp(userId, XP.SUMMARY);
  if (leveledUp) messages.push(buildLevelUpMessage(leveledUp));

  const q = await maybeCompleteQuest(userId);
  if (q.completed && q.quest) {
    messages.push(buildQuestCompleteMessage(q.quest));
    if (q.leveledUp) messages.push(buildLevelUpMessage(q.leveledUp));
  }
  return { messages };
}

export async function onSuccessfulRandom(userId: string): Promise<RetentionHookResult> {
  const messages: string[] = [];
  await bumpField(userId, "random");
  await bumpField(userId, "touch");
  const { leveledUp } = await addXp(userId, XP.RANDOM);
  if (leveledUp) messages.push(buildLevelUpMessage(leveledUp));
  const q = await maybeCompleteQuest(userId);
  if (q.completed && q.quest) {
    messages.push(buildQuestCompleteMessage(q.quest));
    if (q.leveledUp) messages.push(buildLevelUpMessage(q.leveledUp));
  }
  return { messages };
}

export async function onSuccessfulImage(userId: string): Promise<RetentionHookResult> {
  const messages: string[] = [];
  await bumpField(userId, "img");
  await bumpField(userId, "touch");
  const { leveledUp } = await addXp(userId, XP.IMAGE);
  if (leveledUp) messages.push(buildLevelUpMessage(leveledUp));
  const q = await maybeCompleteQuest(userId);
  if (q.completed && q.quest) {
    messages.push(buildQuestCompleteMessage(q.quest));
    if (q.leveledUp) messages.push(buildLevelUpMessage(q.leveledUp));
  }
  return { messages };
}

async function maybeComebackBonus(userId: string): Promise<string | null> {
  try {
    const prev = await redis.get(`ret:last_active:${userId}`);
    const today = cairoDateString();
    await redis.set(`ret:last_active:${userId}`, today);

    if (!prev || prev === today) return null;

    const daysAway = daysBetween(prev, today);
    if (daysAway < 3) return null;

    const claim = await redis.set(COMEBACK_KEY(userId), today, "EX", 7 * 86400, "NX");
    if (claim !== "OK") return null;

    await addXp(userId, XP.COMEBACK);
    redis.incr("tel:retention:comeback").catch(() => {});
    return (
      `🌿 *أهلاً بعودتك*\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `غبت نحو *${daysAway}* يوماً — وهذا أمر طبيعي.\n` +
      `🎁 +${XP.COMEBACK} نقطة ترحيب.\n` +
      `_لم يفُتك شيء. اكتب عنوان كتاب متى شئت._`
    );
  } catch {
    return null;
  }
}

function daysBetween(a: string, b: string): number {
  const pa = a.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const pb = b.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!pa || !pb) return 0;
  const da = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]);
  const db = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.round((db - da) / 86400000);
}

function isoWeekId(d = new Date()): string {
  const day = cairoDateString(d);
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const onejan = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt.getTime() - onejan.getTime()) / 86400000) + onejan.getUTCDay() + 1) / 7);
  return `${dt.getUTCFullYear()}-W${week}`;
}

export async function tryUseStreakShield(userId: string, activeStreak: number): Promise<boolean> {
  if (activeStreak < 3) return false;
  const week = isoWeekId();
  try {
    const used = await redis.get(`${SHIELD_KEY(userId)}:${week}`);
    if (used === "1") return false;
    const xp = await getXpState(userId);
    if (xp.level < 2 && activeStreak < 5) return false;

    await redis.set(`${SHIELD_KEY(userId)}:${week}`, "1", "EX", 10 * 86400);
    redis.incr("tel:retention:shield_used").catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function hasShieldAvailable(userId: string): Promise<boolean> {
  const week = isoWeekId();
  try {
    const used = await redis.get(`${SHIELD_KEY(userId)}:${week}`);
    return used !== "1";
  } catch {
    return false;
  }
}

// ── /daily — حضور يومي ───────────────────────
export async function claimDaily(userId: string): Promise<{
  ok: boolean;
  already?: boolean;
  message: string;
}> {
  const day = cairoDateString();
  const set = await redis.set(DAILY_CLAIM(userId, day), "1", "EX", 3 * 86400, "NX").catch(() => null);

  if (set !== "OK") {
    const quest = await getDailyQuest(userId);
    const xp = await getXpState(userId);
    return {
      ok: true,
      already: true,
      message: buildDailyStatusMessage(quest, xp, true),
    };
  }

  await bumpField(userId, "claim");
  try {
    const last = await redis.get(VISIT_LAST(userId));
    const yest = yesterdayOf(day);
    if (last === yest) await redis.incr(VISIT_STREAK(userId));
    else if (last !== day) await redis.set(VISIT_STREAK(userId), "1");
    await redis.set(VISIT_LAST(userId), day);
  } catch { /* */ }

  const { leveledUp } = await addXp(userId, XP.DAILY_CLAIM);
  await redis.set(`ret:last_active:${userId}`, day).catch(() => {});

  const q = await maybeCompleteQuest(userId);

  const quest = await getDailyQuest(userId);
  const xp = await getXpState(userId);
  let msg = buildDailyStatusMessage(quest, xp, false);
  if (leveledUp) msg += `\n\n` + buildLevelUpMessage(leveledUp);
  if (q.completed && q.quest) {
    msg += `\n\n` + buildQuestCompleteMessage(q.quest);
  }
  redis.incr("tel:retention:daily_claim").catch(() => {});
  return { ok: true, message: msg };
}

export function buildDailyStatusMessage(
  quest: DailyQuest,
  xp: { xp: number; level: number; remaining: number },
  alreadyClaimed: boolean,
): string {
  const bar = questProgressBar(quest.progress, quest.target);

  const header =
    `✅ *تسجيل الحضور*
` +
    `━━━━━━━━━━━━━━━━

`;

  const claimLine = alreadyClaimed
    ? `لقد سجّلتَ حضورك *اليوم* بالفعل. شكراً لعودتك 🌿
`
    : `تمّ تسجيل حضورك اليوم (+${XP.DAILY_CLAIM} نقطة).
` +
      `_معناه: أنّك فتحت رفيق اليوم — ولا يُطلب منك تحميل كتب._
`;

  const how =
    `
*ما النقاط والمستوى؟*
` +
    `◦ تزداد النقاط عند استخدام رفيق (حضور · تحميل · ملخّص…)
` +
    `◦ يرتفع المستوى كلّما تجمّعت النقاط — للمتعة فحسب
`;

  const bonus =
    `
*مكافأة اختيارية اليوم*
` +
    `🎯 ${escMd(quest.title)}
` +
    `_${escMd(quest.description)}_
` +
    `${bar}  ${quest.progress}/${quest.target}` +
    (quest.done ? ` ✅ أُنجزت` : ``) +
    `
` +
    (quest.done
      ? `_أحسنت — إن رغبت: +${quest.rewardXp} نقطة قد احتُسبت._
`
      : (quest.optional
          ? `_اختيارية بالكامل — يمكنك تجاهلها بلا حرج._
`
          : `_حضورك عبر هذه الرسالة يكفي._
`));

  const level =
    `
📊 *مستواك:* ${xp.level}  ·  النقاط: ${xp.xp}
` +
    `_يتبقّى ${xp.remaining} نقطة للمستوى التالي_
`;

  const next =
    `
*يمكنك الآن:*
` +
    `◦ كتابة عنوان كتاب
` +
    `◦ أو الضغط على «كتاب مفاجأة»
` +
    `◦ أو فتح «ملفي» لرؤية تقدّمك
`;

  return header + claimLine + how + bonus + level + next;
}

function questProgressBar(cur: number, max: number): string {
  const n = 5;
  const filled = Math.round((Math.min(cur, max) / Math.max(max, 1)) * n);
  return "`" + "█".repeat(filled) + "░".repeat(Math.max(0, n - filled)) + "`";
}

export function buildQuestCompleteMessage(quest: DailyQuest): string {
  return (
    `🎉 *أتممت المكافأة الاختيارية*
` +
    `━━━━━━━━━━━━━━━━
` +
    `✅ ${escMd(quest.title)}
` +
    `🎁 +${quest.rewardXp} نقطة

` +
    `_حسناً. غداً مكافأة جديدة إن أحببت — بلا ضغط._`
  );
}

export function buildLevelUpMessage(level: number): string {
  return (
    `🌟 *تهانينا — وصلت إلى المستوى ${level}*
` +
    `━━━━━━━━━━━━━━━━
` +
    `_هذا مستوى داخل رفيق للمتعة، لا امتحان. تابع على مهلك._`
  );
}

export async function buildRetentionProfileBlock(userId: string): Promise<string> {
  const [quest, xp, vStreak, shield] = await Promise.all([
    getDailyQuest(userId),
    getXpState(userId),
    redis.get(VISIT_STREAK(userId)).catch(() => "0"),
    hasShieldAvailable(userId),
  ]);
  const vs = parseInt(vStreak || "0", 10) || 0;
  const qBar = questProgressBar(quest.progress, quest.target);
  const claimToday = (await redis.get(DAILY_CLAIM(userId, cairoDateString())).catch(() => null)) === "1";
  return (
    `📈 *تقدّمك في رفيق*
` +
    `◦ المستوى: *${xp.level}*  ·  النقاط: *${xp.xp}* _(يتبقّى ${xp.remaining} للتالي)_
` +
    `◦ حضور اليوم: ${claimToday ? "✅ مسجّل" : "⬜ لم يُسجَّل — من زرّ «سجّل حضورك»"}
` +
    `◦ مكافأة اختيارية: ${escMd(quest.title)} ${qBar} ${quest.progress}/${quest.target}` +
    (quest.done ? " ✅" : "") +
    (vs > 1 ? `
◦ أيّام عودة متتالية: *${vs}*` : "") +
    `
◦ حماية السلسلة هذا الأسبوع: ${shield ? "متاحة" : "استُخدمت"}
`
  );
}

// ── Worker: صباح دافئ + مساء لطيف ─────────────
let _bot: TelegramBot | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;

export function startRetentionWorker(bot: TelegramBot): void {
  _bot = bot;
  if (_timer) return;
  _timer = setInterval(() => {
    runRetentionTick().catch((e) =>
      L.warn("retention", "tick failed", { err: String(e).slice(0, 100) }),
    );
  }, 15 * 60 * 1000);
  _timer.unref?.();
  setTimeout(() => runRetentionTick().catch(() => {}), 3 * 60 * 1000).unref?.();
  L.info("retention", "worker started (warm morning + gentle evening)");
}

export function stopRetentionWorker(): void {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

async function runRetentionTick(): Promise<void> {
  if (!_bot) return;
  if (!(await isFeatureOn("retention_push"))) return;
  const hour = cairoHourNumber();
  if (hour >= 9 && hour <= 11) {
    await sendWarmMorningNotes(_bot);
  }
  if (hour >= 10 && hour <= 13) {
    await runGroupClubWeeklyPosts(_bot).catch(() => {});
  }
  if (hour >= 17 && hour <= 20) {
    await sendSundayWeekReports(_bot).catch(() => {});
  }
  if (hour >= 19 && hour <= 21) {
    await sendGentleEveningNotes(_bot);
  }
}

function pickNote(pool: readonly string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

async function sendWarmMorningNotes(bot: TelegramBot): Promise<void> {
  const day = cairoDateString();
  const lock = await redis
    .set(`ret:morning_lock:${day}:${cairoHourNumber()}`, "1", "EX", 50 * 60, "NX")
    .catch(() => null);
  if (lock !== "OK") return;

  try {
    const weekAgo = Date.now() - 7 * 86400_000;
    const uids = await redis.zrangebyscore("user:lastSeen", weekAgo, "+inf", "LIMIT", 0, 200).catch(() => [] as string[]);
    let sent = 0;
    for (const uid of uids) {
      if (sent >= 30) break;
      if (!uid || !/^\d+$/.test(uid)) continue;
      const already = await redis.sismember(MORNING_KEY(day), uid);
      if (already === 1) continue;
      const morningOn = await getPref(uid, "morning").catch(() => true);
      if (!morningOn) { await redis.sadd(MORNING_KEY(day), uid); continue; }
      const claimed = await redis.get(DAILY_CLAIM(uid, day)).catch(() => null);
      if (claimed === "1") {
        await redis.sadd(MORNING_KEY(day), uid);
        continue;
      }

      const note = pickNote(WARM_DAILY_NOTES, `${day}:${uid}`);
      const botd = await bookOfDayMorningBlock();
      let personalBit = "";
      try {
        const pw = await getPersonalWeekStats(uid);
        if (pw.total > 0) personalBit = `📅 أسبوعك حتى الآن: *${pw.total}* تحميل\n`;
        const taste = await getTopInterests(uid, 1);
        if (taste[0]) personalBit += `🎭 أقرب ذوق: ${taste[0].label}\n`;
      } catch { /* */ }
      const text =
        `🕊 *رسالة من ${BOT_NAME}*\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `${escMd(note)}\n\n` +
        `${botd.text}\n` +
        (personalBit ? `\n${personalBit}\n` : `\n`) +
        `*يمكنك:*\n` +
        `◦ طلب كتاب اليوم من الزر\n` +
        `◦ كتابة عنوان كتاب\n` +
        `◦ تسجيل الحضور: /daily\n` +
        `◦ أو تجاهل الرسالة كما تشاء`;

      try {
        const kb = await kbBookOfDayAsync();
        await bot.sendMessage(Number(uid), text, { parse_mode: "Markdown", reply_markup: kb });
        await redis.sadd(MORNING_KEY(day), uid);
        await redis.expire(MORNING_KEY(day), 2 * 86400);
        sent++;
        redis.incr("tel:retention:morning_note").catch(() => {});
        // عادة يومية خفيفة — ليس كل صباح لكل أحد
        try {
          if (sent % 3 === 0 && !(await hasAnsweredMicro(uid))) {
            const micro = buildMicroMessage();
            await bot.sendMessage(Number(uid), micro.text, {
              parse_mode: "Markdown", reply_markup: micro.kb,
            });
          }
        } catch { /* */ }
      } catch { /* blocked */ }
      await new Promise((r) => setTimeout(r, 90));
    }
    if (sent > 0) L.info("retention", "warm morning notes sent", { sent, day });
  } catch (e) {
    L.warn("retention", "sendWarmMorningNotes failed", { err: String(e).slice(0, 100) });
  }
}

async function sendGentleEveningNotes(bot: TelegramBot): Promise<void> {
  const day = cairoDateString();
  const lock = await redis
    .set(`ret:remind_lock:${day}:${cairoHourNumber()}`, "1", "EX", 50 * 60, "NX")
    .catch(() => null);
  if (lock !== "OK") return;

  try {
    let cursor = "0";
    let sent = 0;
    const yest = yesterdayOf(day);

    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "streak:last:*", "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        if (sent >= 30) break;
        const last = await redis.get(key);
        if (last !== yest) continue;
        const uid = key.slice("streak:last:".length);
        if (!uid || !/^\d+$/.test(uid)) continue;

        const already = await redis.sismember(REMIND_KEY(day), uid);
        if (already === 1) continue;
        const eveOn = await getPref(uid, "evening").catch(() => true);
        if (!eveOn) { await redis.sadd(REMIND_KEY(day), uid); continue; }

        const cur = parseInt((await redis.get(`streak:cur:${uid}`)) || "0", 10) || 0;
        if (cur < 2) continue;

        const claimed = await redis.get(DAILY_CLAIM(uid, day)).catch(() => null);
        if (claimed === "1") {
          await redis.sadd(REMIND_KEY(day), uid);
          continue;
        }

        const note = pickNote(WARM_EVENING_NOTES, `${day}:${uid}:eve`);
        const text =
          `🌙 *مساء الخير من ${BOT_NAME}*\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `${escMd(note)}\n\n` +
          (cur >= 3 ? `لديك *${cur}* أيام نشاط متتالية. إن أحببت الحفاظ عليها: اكتب /daily أو اضغط «سجّل حضورك».\n\n` : "") +
          `_لا يُطلب منك تحميل. تجاهل الرسالة كما تشاء._`;

        try {
          await bot.sendMessage(Number(uid), text, { parse_mode: "Markdown" });
          await redis.sadd(REMIND_KEY(day), uid);
          await redis.expire(REMIND_KEY(day), 2 * 86400);
          sent++;
          redis.incr("tel:retention:evening_note").catch(() => {});
        } catch { /* */ }
        await new Promise((r) => setTimeout(r, 90));
      }
    } while (cursor !== "0" && sent < 30);

    if (sent > 0) L.info("retention", "gentle evening notes sent", { sent, day });
  } catch (e) {
    L.warn("retention", "sendGentleEveningNotes failed", { err: String(e).slice(0, 100) });
  }
}

// ── Tips ──────────────────────────────────────
export const RETENTION_TIPS = [
  "«سجّل حضورك» يعني أنّك فتحت البوت اليوم. لا يلزمك تحميل كتاب.",
  "اكتب عنوان الكتاب في المحادثة… يبحث رفيق ويرسل PDF.",
  "«كتاب مفاجأة» يختار عنواناً عشوائياً — للفضول فحسب.",
  "بعد التحميل: «ملخّص سريع» يوفّر وقتك إن رغبت.",
  "ملفي = مكان ترى فيه تحميلاتك ومستواك وشاراتك.",
  "رصيدي اليوم = كم كتاباً يمكنك تحميله اليوم بعد.",
  "بعض الأيّام للقراءة وبعضها للراحة — وكلاهما مقبول عند رفيق.",
  "دعوة صديق من «ادعُ صديقاً» قد تمنحك أيّام Premium.",
] as const;
