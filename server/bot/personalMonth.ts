// ══════════════════════════════════════════════
// PERSONAL MONTH — تقرير شهري للمستخدم
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { cairoDateString, escMd } from "./text.js";
import { getTopInterests } from "./interests.js";
import { getLibrary } from "./library.js";
import { BOT_NAME } from "./brand.js";
import { storeRetryKey } from "./session.js";

function monthKey(d = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
    })
      .format(d)
      .slice(0, 7); // YYYY-MM from en-CA is YYYY-MM-DD style... en-CA gives YYYY-MM-DD
  } catch {
    return cairoDateString().slice(0, 7);
  }
}

// en-CA format is YYYY-MM-DD — take first 7 chars for month
function cairoMonth(): string {
  try {
    const full = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    // YYYY-MM-DD
    return full.slice(0, 7);
  } catch {
    return cairoDateString().slice(0, 7);
  }
}

const BOOKS_KEY = (uid: string, month: string) => `ret:umonth:books:${uid}:${month}`;
const COUNT_KEY = (uid: string, month: string) => `ret:umonth:cnt:${uid}:${month}`;
const TTL = 120 * 86400;

export async function recordPersonalMonthDownload(userId: string, bookName: string): Promise<void> {
  const month = cairoMonth();
  const title = (bookName.split(/\s*[—–-]\s*/)[0] || bookName).trim().slice(0, 100);
  if (!title) return;
  try {
    const pipe = redis.pipeline();
    pipe.zincrby(BOOKS_KEY(userId, month), 1, title);
    pipe.incr(COUNT_KEY(userId, month));
    pipe.expire(BOOKS_KEY(userId, month), TTL);
    pipe.expire(COUNT_KEY(userId, month), TTL);
    await pipe.exec();
  } catch { /* */ }
}

export async function buildPersonalMonthMessage(userId: string): Promise<string> {
  const month = cairoMonth();
  let total = 0;
  let top: { title: string; count: number }[] = [];
  try {
    total = parseInt((await redis.get(COUNT_KEY(userId, month))) || "0", 10) || 0;
    const rows = await redis.zrevrange(BOOKS_KEY(userId, month), 0, 9, "WITHSCORES");
    for (let i = 0; i < rows.length; i += 2) {
      top.push({ title: rows[i], count: parseInt(rows[i + 1] || "1", 10) || 1 });
    }
  } catch { /* */ }

  const [interests, lib] = await Promise.all([
    getTopInterests(userId, 3),
    getLibrary(userId, 50),
  ]);
  const done = lib.filter((x) => x.status === "done").length;
  const reading = lib.filter((x) => x.status === "reading").length;
  const taste = interests.length ? interests.map((i) => i.label).join(" · ") : "ما زال يتشكّل";

  const booksBlock =
    top.length === 0
      ? "_لا تحميلات مسجّلة هذا الشهر بعد._"
      : top.map((b, i) => `${i + 1}. ${escMd(b.title)}${b.count > 1 ? ` _(×${b.count})_` : ""}`).join("\n");

  return (
    `🌙 *شهرك مع ${BOT_NAME}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `📅 الشهر: \`${escMd(month)}\`\n` +
    `📥 تحميلات الشهر: *${total}*\n` +
    `🎭 ذوقك: ${escMd(taste)}\n` +
    `📚 في المكتبة الآن: أقرأ *${reading}* · أنهيت *${done}*\n\n` +
    `*أبرز ما طلبت هذا الشهر:*\n${booksBlock}\n\n` +
    `💬 _شهر القراءة يُقاس بالهدوء لا بالسباق. /myweek للأسبوع · /library للمكتبة_\n` +
    `_تقرير شخصي · بلا مقارنة_`
  );
}

export function kbPersonalMonth(
  top: { title: string; count: number }[],
): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (const b of top.slice(0, 3)) {
    const k = storeRetryKey(b.title);
    const label = b.title.length > 30 ? b.title.slice(0, 29) + "…" : b.title;
    rows.push([{ text: `📥  ${label}`, callback_data: `retry:${k}` }]);
  }
  rows.push([
    { text: "📊  أسبوعي", callback_data: "my_week" },
    { text: "📚  مكتبتي", callback_data: "my_library" },
  ]);
  rows.push([{ text: "🏠  الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

export async function sendPersonalMonthReport(
  bot: TelegramBot,
  chatId: number,
  userId: string,
): Promise<void> {
  const month = cairoMonth();
  let top: { title: string; count: number }[] = [];
  try {
    const rows = await redis.zrevrange(BOOKS_KEY(userId, month), 0, 9, "WITHSCORES");
    for (let i = 0; i < rows.length; i += 2) {
      top.push({ title: rows[i], count: parseInt(rows[i + 1] || "1", 10) || 1 });
    }
  } catch { /* */ }
  const text = await buildPersonalMonthMessage(userId);
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: kbPersonalMonth(top),
  });
}
