// ══════════════════════════════════════════════
// GROUP CLUB — نادي القراءة في المجموعات
//
// • كتاب النادي الأسبوعي (مشترك للمجموعة)
// • ترحيب أغنى
// • همسة نادي خفيفة (محدودة المعدل) بعد تسليم في المجموعة
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { cairoDateString, escMd, isoWeekKey } from "./text.js";
import { getBookOfDay } from "./bookOfDay.js";
import { SUGGESTIONS } from "./suggestions.js";
import { isFreeTextGroup } from "./groupPolicy.js";
import { storeRetryKey } from "./session.js";
import { BOT_NAME } from "./brand.js";
import { listKnownGroups } from "./groupTracker.js";

const CLUB_BOOK_KEY = (chatId: number | string, week: string) =>
  `grp:club:book:${chatId}:${week}`;
const CLUB_POST_KEY = (chatId: number | string, week: string) =>
  `grp:club:posted:${chatId}:${week}`;
const CLUB_WHISPER_KEY = (chatId: number, day: string) =>
  `grp:club:whisper:${chatId}:${day}`;

function cleanTitle(raw: string): string {
  return (raw.split(/\s*[—–-]\s*/)[0] || raw).trim().slice(0, 100);
}

export async function getGroupClubBook(chatId: number): Promise<{ week: string; title: string }> {
  const week = isoWeekKey();
  try {
    const cached = await redis.get(CLUB_BOOK_KEY(chatId, week));
    if (cached && cached.trim().length >= 2) {
      return { week, title: cached.trim() };
    }
  } catch { /* */ }

  // Prefer global book of day, else stable pick from catalog
  let title = "";
  try {
    const botd = await getBookOfDay();
    title = botd.title;
  } catch { /* */ }
  if (!title) {
    const pool = SUGGESTIONS.map(cleanTitle).filter((t) => t.length >= 3);
    let h = 0;
    const seed = `${week}:${chatId}`;
    for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
    title = pool[h % pool.length] || "الأمير الصغير";
  }

  try {
    await redis.set(CLUB_BOOK_KEY(chatId, week), title, "EX", 21 * 86400);
  } catch { /* */ }
  return { week, title };
}

export async function buildGroupClubMessage(chatId: number): Promise<string> {
  const { week, title } = await getGroupClubBook(chatId);
  return (
    `📖 *نادي ${BOT_NAME} — كتاب الأسبوع*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `📗 «${escMd(title)}»\n\n` +
    `هذا اقتراح مشترك للمجموعة هذا الأسبوع (\`${escMd(week)}\`).\n` +
    `اكتب العنوان أو اضغط الزر للبحث.\n\n` +
    `*كيف يشارك الجميع؟*\n` +
    `◦ اكتب عنوان أي كتاب مباشرةً\n` +
    `◦ أو اطلب مفاجأة: /random\n` +
    `◦ بعد التحميل: ملخّص سريع من الأزرار\n\n` +
    `_نادي هادئ — بلا ضغط وبلا مسابقات._`
  );
}

export function kbGroupClub(title: string): TelegramBot.InlineKeyboardMarkup {
  const k = storeRetryKey(title);
  return {
    inline_keyboard: [
      [{ text: "📥  أرسل كتاب النادي", callback_data: `retry:${k}` }],
      [
        { text: "🎲  مفاجأة", callback_data: "rg:any" },
        { text: "❓  كيف أستخدم؟", callback_data: "help" },
      ],
    ],
  };
}

export async function maybePostWeeklyClub(
  bot: TelegramBot,
  chatId: number,
  force = false,
): Promise<boolean> {
  if (!isFreeTextGroup(chatId) && !force) return false;
  const week = isoWeekKey();
  try {
    if (!force) {
      const ok = await redis.set(CLUB_POST_KEY(chatId, week), "1", "EX", 10 * 86400, "NX");
      if (ok !== "OK") return false;
    } else {
      await redis.set(CLUB_POST_KEY(chatId, week), "1", "EX", 10 * 86400);
    }
    const text = await buildGroupClubMessage(chatId);
    const { title } = await getGroupClubBook(chatId);
    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: kbGroupClub(title),
    });
    redis.incr("tel:group:club_post").catch(() => {});
    return true;
  } catch (e) {
    L.warn("groupClub", "maybePostWeeklyClub failed", {
      chatId,
      err: String(e).slice(0, 80),
    });
    return false;
  }
}

/** همسة قصيرة بعد تسليم في المجموعة (مرّة/يوم للمجموعة) */
export async function maybeGroupDeliveryWhisper(
  bot: TelegramBot,
  chatId: number,
  bookName: string,
): Promise<void> {
  if (chatId > 0) return; // private
  if (!isFreeTextGroup(chatId)) return;
  const day = cairoDateString();
  try {
    const ok = await redis.set(CLUB_WHISPER_KEY(chatId, day), "1", "EX", 86400, "NX");
    if (ok !== "OK") return;
    const { title: club } = await getGroupClubBook(chatId);
    await bot.sendMessage(
      chatId,
      `✨ _وصل كتاب إلى أحد الأعضاء._\n` +
        `نادي الأسبوع: «${escMd(club)}» — اكتب العنوان إن أحببت المشاركة.\n` +
        `_/club لعرض كتاب النادي_`,
      { parse_mode: "Markdown" },
    ).catch(() => {});
  } catch { /* */ }
}

/** يُستدعى من worker: نشر نادي الأسبوع للمجموعات النشطة */
export async function runGroupClubWeeklyPosts(bot: TelegramBot): Promise<void> {
  // Monday–Tuesday Cairo morningish via retention tick hours 10-12
  let weekday = "";
  try {
    weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Cairo",
      weekday: "short",
    }).format(new Date());
  } catch {
    return;
  }
  // Post early week: Mon or Tue
  if (weekday !== "Mon" && weekday !== "Tue") return;

  const { cairoHourNumber } = await import("./text.js");
  const hour = cairoHourNumber();
  if (hour < 10 || hour > 13) return;

  const week = isoWeekKey();
  const lock = await redis
    .set(`grp:club:run:${week}:${hour}`, "1", "EX", 50 * 60, "NX")
    .catch(() => null);
  if (lock !== "OK") return;

  try {
    const groups = await listKnownGroups();
    let sent = 0;
    for (const g of groups) {
      if (sent >= 15) break;
      if (!isFreeTextGroup(g.chatId)) continue;
      // only if seen in last 14 days
      if (g.lastSeen && Date.now() - g.lastSeen > 14 * 86400_000) continue;
      const ok = await maybePostWeeklyClub(bot, g.chatId, false);
      if (ok) {
        sent++;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (sent > 0) L.info("groupClub", "weekly club posts", { sent, week });
  } catch (e) {
    L.warn("groupClub", "runGroupClubWeeklyPosts failed", { err: String(e).slice(0, 100) });
  }
}

export const GROUP_CLUB_WELCOME_EXTRA =
  `\n\n📖 *نادي القراءة*\n` +
  `◦ كل أسبوع كتاب مقترح للمجموعة\n` +
  `◦ اكتب /club لعرضه\n` +
  `◦ شارك العنوان مباشرةً في الشات`;
