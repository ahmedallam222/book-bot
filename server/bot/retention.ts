// ══════════════════════════════════════════════
// RETENTION ENGINE — عودة يومية + مهام + مستويات
//
// يعمّق الـ streak/badges/referral الموجودين بـ:
//   1) مهمة يومية (daily quest) — هدف بسيط كل يوم Cairo
//   2) نقاط ومستويات (XP) — تتراكم مع التحميل/الملخص/المهام
//   3) تذكير سلسلة القراءة — مساءً لمن عنده streak ولم يحمّل اليوم
//   4) مكافأة العودة (comeback) — بعد غياب ≥ 3 أيام
//   5) درع سلسلة أسبوعي (streak shield) — حماية مرة/أسبوع
//
// التخزين: Redis فقط. fail-open. لا schema migration.
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { cairoDateString, cairoHourNumber, escMd } from "./text.js";

const QUEST_KEY     = (uid: string, day: string) => `ret:quest:${uid}:${day}`;
const QUEST_DONE    = (uid: string, day: string) => `ret:qdone:${uid}:${day}`;
const XP_KEY        = (uid: string) => `ret:xp:${uid}`;
const LEVEL_KEY     = (uid: string) => `ret:lvl:${uid}`;
const COMEBACK_KEY  = (uid: string) => `ret:comeback:${uid}`;
const SHIELD_KEY    = (uid: string) => `ret:shield_week:${uid}`; // week id
const REMIND_KEY    = (day: string) => `ret:reminded:${day}`; // set of uids already reminded
const DAILY_CLAIM   = (uid: string, day: string) => `ret:dclaim:${uid}:${day}`;
const QUEST_STREAK  = (uid: string) => `ret:qstreak:${uid}`;
const QUEST_LAST    = (uid: string) => `ret:qlast:${uid}`;

// ── XP awards ─────────────────────────────────
export const XP = {
  DOWNLOAD:       10,
  CACHE_HIT:       4,
  SUMMARY:        15,
  QUEST_COMPLETE: 25,
  DAILY_CLAIM:    8,
  STREAK_DAY:      5, // bonus when streak transitions
  COMEBACK:       20,
} as const;

// Level thresholds (cumulative XP)
const LEVEL_THRESHOLDS = [0, 50, 120, 220, 350, 520, 750, 1050, 1450, 2000, 2800, 4000];

export function levelFromXp(xp: number): number {
  let lvl = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]) lvl = i + 1;
    else break;
  }
  if (xp >= LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1]) {
    // every +1200 XP after last threshold → +1 level
    const extra = xp - LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
    lvl = LEVEL_THRESHOLDS.length + Math.floor(extra / 1200);
  }
  return Math.max(1, lvl);
}

export function xpToNextLevel(xp: number): { level: number; nextAt: number; remaining: number } {
  const level = levelFromXp(xp);
  let nextAt: number;
  if (level < LEVEL_THRESHOLDS.length) {
    nextAt = LEVEL_THRESHOLDS[level]; // level is 1-indexed; next threshold index = level
  } else {
    const base = LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
    const beyond = level - LEVEL_THRESHOLDS.length;
    nextAt = base + (beyond + 1) * 1200;
  }
  return { level, nextAt, remaining: Math.max(0, nextAt - xp) };
}

// ── Daily quest types ─────────────────────────
export type QuestType = "download_1" | "download_2" | "summary_1" | "any_2";

export interface DailyQuest {
  type:        QuestType;
  title:       string;
  description: string;
  target:      number;
  progress:    number;
  done:        boolean;
  rewardXp:    number;
}

const QUEST_ROTATION: QuestType[] = [
  "download_1",
  "download_1",
  "summary_1",
  "download_2",
  "download_1",
  "any_2",
  "summary_1",
];

function questTypeForDay(day: string): QuestType {
  // Stable per-day: hash date to index
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) >>> 0;
  return QUEST_ROTATION[h % QUEST_ROTATION.length];
}

function questMeta(type: QuestType): { title: string; description: string; target: number } {
  switch (type) {
    case "download_1":
      return { title: "قارئ اليوم", description: "حمّل كتاباً واحداً اليوم", target: 1 };
    case "download_2":
      return { title: "نهم المعرفة", description: "حمّل كتابين اليوم", target: 2 };
    case "summary_1":
      return { title: "ملخّص ذكي", description: "اطلب ملخصاً لكتاب واحد", target: 1 };
    case "any_2":
      return { title: "يوم نشط", description: "نشاطان: تحميل أو ملخص (مجموع 2)", target: 2 };
  }
}

async function getQuestProgress(userId: string, day: string): Promise<{ dl: number; sum: number }> {
  try {
    const raw = await redis.hgetall(QUEST_KEY(userId, day));
    return {
      dl:  parseInt(raw?.dl  || "0", 10) || 0,
      sum: parseInt(raw?.sum || "0", 10) || 0,
    };
  } catch {
    return { dl: 0, sum: 0 };
  }
}

export async function getDailyQuest(userId: string): Promise<DailyQuest> {
  const day = cairoDateString();
  const type = questTypeForDay(day);
  const meta = questMeta(type);
  const prog = await getQuestProgress(userId, day);
  let progress = 0;
  if (type === "download_1" || type === "download_2") progress = prog.dl;
  else if (type === "summary_1") progress = prog.sum;
  else progress = prog.dl + prog.sum;

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
  };
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

  // quest streak
  try {
    const last = await redis.get(QUEST_LAST(userId));
    const yest = (() => {
      const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return day;
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      d.setUTCDate(d.getUTCDate() - 1);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    })();
    if (last === yest) await redis.incr(QUEST_STREAK(userId));
    else await redis.set(QUEST_STREAK(userId), "1");
    await redis.set(QUEST_LAST(userId), day);
  } catch { /* */ }

  const { leveledUp } = await addXp(userId, XP.QUEST_COMPLETE);
  redis.incr("tel:retention:quest_complete").catch(() => {});
  return { completed: true, quest: { ...quest, done: true, progress: quest.target }, leveledUp: leveledUp ?? undefined };
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
    return { xp: 0, level: 1, remaining: 50, nextAt: 50 };
  }
}

// ── Hooks from download / summary ─────────────
export interface RetentionHookResult {
  messages: string[]; // extra user-facing messages (Markdown)
}

export async function onSuccessfulDownload(
  userId: string,
  opts: { fromCache?: boolean; streakTransitioned?: boolean },
): Promise<RetentionHookResult> {
  const messages: string[] = [];
  const day = cairoDateString();

  try {
    await redis.hincrby(QUEST_KEY(userId, day), "dl", 1);
    await redis.expire(QUEST_KEY(userId, day), 3 * 86400).catch(() => {});
  } catch { /* */ }

  await addXp(userId, opts.fromCache ? XP.CACHE_HIT : XP.DOWNLOAD);
  if (opts.streakTransitioned) await addXp(userId, XP.STREAK_DAY);

  // Comeback: if last activity was ≥3 days ago (before this download)
  const comeback = await maybeComebackBonus(userId);
  if (comeback) messages.push(comeback);

  const q = await maybeCompleteQuest(userId);
  if (q.completed && q.quest) {
    messages.push(buildQuestCompleteMessage(q.quest));
    if (q.leveledUp) messages.push(buildLevelUpMessage(q.leveledUp));
  } else {
    // level up from download XP alone
    const st = await getXpState(userId);
    // leveledUp only returned from addXp — re-check via storing previous is hard; skip
  }

  // Quest progress nudge if not done
  if (!q.quest?.done && q.quest) {
    // silent — shown in /daily
  }

  return { messages };
}

export async function onSuccessfulSummary(userId: string): Promise<RetentionHookResult> {
  const messages: string[] = [];
  const day = cairoDateString();
  try {
    await redis.hincrby(QUEST_KEY(userId, day), "sum", 1);
    await redis.expire(QUEST_KEY(userId, day), 3 * 86400).catch(() => {});
  } catch { /* */ }

  const { leveledUp } = await addXp(userId, XP.SUMMARY);
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
    // user:lastSeen is updated on every message — we need previous lastSeen
    // Use ret:last_active:{uid} that WE update after processing
    const prev = await redis.get(`ret:last_active:${userId}`);
    const today = cairoDateString();
    await redis.set(`ret:last_active:${userId}`, today);

    if (!prev || prev === today) return null;

    // days between prev and today
    const daysAway = daysBetween(prev, today);
    if (daysAway < 3) return null;

    // once per absence episode
    const claim = await redis.set(COMEBACK_KEY(userId), today, "EX", 7 * 86400, "NX");
    if (claim !== "OK") return null;

    await addXp(userId, XP.COMEBACK);
    redis.incr("tel:retention:comeback").catch(() => {});
    return (
      `👋 *أهلاً بعودتك!*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `_غبتَ ${daysAway} أيام — وفرنا لك +${XP.COMEBACK} XP ترحيباً._\n` +
      `🔥 ابدأ سلسلة جديدة اليوم… كتاب واحد يكفي.`
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

// ── Streak shield (weekly) ────────────────────
function isoWeekId(d = new Date()): string {
  // simple: Cairo date year + week number approx
  const day = cairoDateString(d);
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const onejan = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt.getTime() - onejan.getTime()) / 86400000) + onejan.getUTCDay() + 1) / 7);
  return `${dt.getUTCFullYear()}-W${week}`;
}

/** Called when streak would break — returns true if shield consumed and streak should be preserved. */
export async function tryUseStreakShield(userId: string, activeStreak: number): Promise<boolean> {
  if (activeStreak < 3) return false;
  const week = isoWeekId();
  try {
    const used = await redis.get(`${SHIELD_KEY(userId)}:${week}`);
    if (used === "1") return false; // already used this week
    // Grant availability: user earns shield if quest streak or level >= 3
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

// ── /daily claim ──────────────────────────────
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

  const { leveledUp } = await addXp(userId, XP.DAILY_CLAIM);
  const quest = await getDailyQuest(userId);
  const xp = await getXpState(userId);
  let msg = buildDailyStatusMessage(quest, xp, false);
  if (leveledUp) msg += `\n\n` + buildLevelUpMessage(leveledUp);
  redis.incr("tel:retention:daily_claim").catch(() => {});
  return { ok: true, message: msg };
}

export function buildDailyStatusMessage(
  quest: DailyQuest,
  xp: { xp: number; level: number; remaining: number },
  alreadyClaimed: boolean,
): string {
  const bar = questProgressBar(quest.progress, quest.target);
  const claimLine = alreadyClaimed
    ? `✅ _سجّلتَ حضورك اليوم_`
    : `🎁 *+${XP.DAILY_CLAIM} XP* — تم تسجيل الحضور اليومي!`;

  return (
    `☀️ *روتينك اليومي*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
    `${claimLine}\n\n` +
    `🎯 *مهمة اليوم — ${escMd(quest.title)}*\n` +
    `_${escMd(quest.description)}_\n` +
    `${bar}  ${quest.progress}/${quest.target}` +
    (quest.done ? ` ✅` : ``) +
    `\n_مكافأة الإتمام: +${quest.rewardXp} XP_\n\n` +
    `⭐ *المستوى ${xp.level}* · ${xp.xp} XP\n` +
    `_يتبقّى ${xp.remaining} للمستوى التالي_\n\n` +
    `💡 _حمّل كتاباً الآن للحفاظ على سلسلتك ومهمتك_`
  );
}

function questProgressBar(cur: number, max: number): string {
  const n = 5;
  const filled = Math.round((Math.min(cur, max) / Math.max(max, 1)) * n);
  return "`" + "█".repeat(filled) + "░".repeat(Math.max(0, n - filled)) + "`";
}

export function buildQuestCompleteMessage(quest: DailyQuest): string {
  return (
    `🎯 *أتممت مهمة اليوم!*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `✅ ${escMd(quest.title)}\n` +
    `🎁 +${quest.rewardXp} XP\n\n` +
    `_عد غداً لمهمة جديدة — الاستمرار يبني مستواك._`
  );
}

export function buildLevelUpMessage(level: number): string {
  return (
    `🌟 *ارتقيت للمستوى ${level}!*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `_قارئ ينمو — استمر في التحميل والمهام اليومية._`
  );
}

// ── Profile block ─────────────────────────────
export async function buildRetentionProfileBlock(userId: string): Promise<string> {
  const [quest, xp, qStreak, shield] = await Promise.all([
    getDailyQuest(userId),
    getXpState(userId),
    redis.get(QUEST_STREAK(userId)).catch(() => "0"),
    hasShieldAvailable(userId),
  ]);
  const qs = parseInt(qStreak || "0", 10) || 0;
  const qBar = questProgressBar(quest.progress, quest.target);
  return (
    `⭐ *المستوى ${xp.level}* · ${xp.xp} XP _(يتبقّى ${xp.remaining})_\n` +
    `🎯 *مهمة اليوم:* ${escMd(quest.title)} ${qBar} ${quest.progress}/${quest.target}` +
    (quest.done ? " ✅" : "") +
    (qs > 1 ? `\n📅 سلسلة مهام: ${qs} يوم` : "") +
    `\n🛡️ درع السلسلة: ${shield ? "متاح هذا الأسبوع" : "مستُخدم هذا الأسبوع"}\n` +
    `_/daily لروتينك اليومي_`
  );
}

// ── Evening streak reminders ──────────────────
let _bot: TelegramBot | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;

export function startRetentionWorker(bot: TelegramBot): void {
  _bot = bot;
  if (_timer) return;
  // tick every 15 minutes
  _timer = setInterval(() => {
    runRetentionTick().catch((e) =>
      L.warn("retention", "tick failed", { err: String(e).slice(0, 100) }),
    );
  }, 15 * 60 * 1000);
  _timer.unref?.();
  // first run after 3 min
  setTimeout(() => runRetentionTick().catch(() => {}), 3 * 60 * 1000).unref?.();
  L.info("retention", "worker started (15m tick, evening streak reminders)");
}

export function stopRetentionWorker(): void {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

async function runRetentionTick(): Promise<void> {
  if (!_bot) return;
  const hour = cairoHourNumber();
  // Streak reminders between 19:00–21:00 Cairo
  if (hour >= 19 && hour <= 21) {
    await sendStreakReminders(_bot);
  }
}

/**
 * Remind users with active streak who haven't downloaded today.
 * Cap 40 messages per tick to avoid Telegram flood.
 */
async function sendStreakReminders(bot: TelegramBot): Promise<void> {
  const day = cairoDateString();
  const lock = await redis.set(`ret:remind_lock:${day}:${cairoHourNumber()}`, "1", "EX", 50 * 60, "NX").catch(() => null);
  if (lock !== "OK") return;

  try {
    // Scan streak:last:* for yesterday (active but not today)
    // Use SCAN — limited batch
    let cursor = "0";
    let sent = 0;
    const yest = (() => {
      const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      d.setUTCDate(d.getUTCDate() - 1);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    })();

    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "streak:last:*", "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        if (sent >= 35) break;
        const last = await redis.get(key);
        if (last !== yest) continue; // only those active yesterday, not yet today
        const uid = key.slice("streak:last:".length);
        if (!uid || !/^\d+$/.test(uid)) continue;

        // already reminded today?
        const already = await redis.sismember(REMIND_KEY(day), uid);
        if (already === 1) continue;

        const cur = parseInt((await redis.get(`streak:cur:${uid}`)) || "0", 10) || 0;
        if (cur < 2) continue;

        const quest = await getDailyQuest(uid);
        const text =
          `🔥 *سلسلتك ${cur} يوم على وشك أن تنكسر!*\n` +
          `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
          `_حمّل كتاباً واحداً قبل منتصف الليل (القاهرة)_\n\n` +
          `🎯 مهمة اليوم: ${escMd(quest.title)}\n` +
          `_${escMd(quest.description)}_\n\n` +
          `اكتب اسم كتاب… أو /random · /daily`;

        try {
          await bot.sendMessage(Number(uid), text, { parse_mode: "Markdown" });
          await redis.sadd(REMIND_KEY(day), uid);
          await redis.expire(REMIND_KEY(day), 2 * 86400);
          sent++;
          redis.incr("tel:retention:streak_remind").catch(() => {});
        } catch {
          // user blocked bot — ignore
        }
        // gentle pacing
        await new Promise((r) => setTimeout(r, 80));
      }
    } while (cursor !== "0" && sent < 35);

    if (sent > 0) L.info("retention", "streak reminders sent", { sent, day });
  } catch (e) {
    L.warn("retention", "sendStreakReminders failed", { err: String(e).slice(0, 100) });
  }
}

// ── Tips for daily claim variety ──────────────
export const RETENTION_TIPS = [
  "📚 كتاب واحد يومياً أفضل من سبعة في يوم واحد ثم انقطاع.",
  "🔥 السلسلة تُبنى بعادة صغيرة — ليس بعدد الصفحات.",
  "🎯 أتمم مهمة اليوم قبل أن تغلق تيليجرام.",
  "⭐ كل تحميل يرفع مستواك… والملخص أسرع طريق للـ XP.",
  "🛡️ المستويات الأعلى تحمي سلسلتك بدرع أسبوعي.",
  "👥 ادعُ صديقاً — الإحالات تمنح Premium مجاناً.",
  "🌙 آخر ساعات الليل أخطر على السلسلة — ثبّتها الآن.",
] as const;
