// ══════════════════════════════════════════════
// PERSONAL WEEK — تقريرك الأسبوعي مع رفيق
//
// يتتبع التحميلات الناجحة لكل مستخدم في أسبوع القاهرة،
// ويعرض تقريراً دافئاً + دفع اختياري يوم الأحد.
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { cairoDateString, cairoHourNumber, escMd, isoWeekKey } from "./text.js";
import { getTopInterests } from "./interests.js";
import { BOT_NAME } from "./brand.js";
import { storeRetryKey } from "./session.js";
import { getPref } from "./notifPrefs.js";

const BOOKS_KEY = (uid: string, week: string) => `ret:uweek:books:${uid}:${week}`;
const COUNT_KEY = (uid: string, week: string) => `ret:uweek:cnt:${uid}:${week}`;
const CLAIM_KEY = (uid: string, week: string) => `ret:uweek:sent:${uid}:${week}`;
const TTL = 28 * 86400;

function cleanTitle(raw: string): string {
  return (raw.split(/\s*[—–-]\s*/)[0] || raw).trim().slice(0, 100);
}

/** يُستدعى بعد كل تحميل ناجح */
export async function recordPersonalWeekDownload(
  userId: string,
  bookName: string,
): Promise<void> {
  const week = isoWeekKey();
  const title = cleanTitle(bookName);
  if (!title) return;
  try {
    const pipe = redis.pipeline();
    pipe.zincrby(BOOKS_KEY(userId, week), 1, title);
    pipe.incr(COUNT_KEY(userId, week));
    pipe.expire(BOOKS_KEY(userId, week), TTL);
    pipe.expire(COUNT_KEY(userId, week), TTL);
    await pipe.exec();
  } catch { /* fail-open */ }
}

export async function getPersonalWeekStats(userId: string, week?: string): Promise<{
  week: string;
  total: number;
  topBooks: { title: string; count: number }[];
}> {
  const w = week || isoWeekKey();
  try {
    const [totalRaw, rows] = await Promise.all([
      redis.get(COUNT_KEY(userId, w)),
      redis.zrevrange(BOOKS_KEY(userId, w), 0, 9, "WITHSCORES"),
    ]);
    const total = parseInt(totalRaw || "0", 10) || 0;
    const topBooks: { title: string; count: number }[] = [];
    for (let i = 0; i < rows.length; i += 2) {
      topBooks.push({
        title: rows[i],
        count: parseInt(rows[i + 1] || "1", 10) || 1,
      });
    }
    return { week: w, total, topBooks };
  } catch {
    return { week: w, total: 0, topBooks: [] };
  }
}

function encouragement(total: number): string {
  if (total === 0) {
    return "لم تبدأ بعد هذا الأسبوع — كتاب واحد يكفي لفتح الصفحة.";
  }
  if (total === 1) {
    return "بداية جميلة. عادة صغيرة أهدأ من اندفاع يوم ثم صمت.";
  }
  if (total < 4) {
    return "إيقاع هادئ ومنتظم — هذا ما يبني عادة القراءة.";
  }
  if (total < 8) {
    return "أسبوع ثري. خذ وقتك مع ما حمّلته قبل طلب المزيد.";
  }
  return "أسبوع استثنائي في النشاط. لا تنسَ أن القراءة أهم من العدد.";
}

export async function buildPersonalWeekMessage(userId: string): Promise<string> {
  const { week, total, topBooks } = await getPersonalWeekStats(userId);
  const interests = await getTopInterests(userId, 2);
  let xpLine = "";
  try {
    const xp = parseInt((await redis.get(`ret:xp:${userId}`)) || "0", 10) || 0;
    const lvl = parseInt((await redis.get(`ret:lvl:${userId}`)) || "1", 10) || 1;
    xpLine = `⭐ المستوى: *${lvl}* · ${xp} نقطة\n`;
  } catch { /* */ }

  const taste =
    interests.length > 0
      ? interests.map((i) => i.label).join(" · ")
      : "ما زال يتشكّل";

  let booksBlock = "_لا كتب مسجّلة بعد هذا الأسبوع._";
  if (topBooks.length > 0) {
    booksBlock = topBooks
      .slice(0, 7)
      .map((b, i) => `${i + 1}. ${escMd(b.title)}${b.count > 1 ? ` _(×${b.count})_` : ""}`)
      .join("\n");
  }

  return (
    `📊 *أسبوعك مع ${BOT_NAME}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `📅 الأسبوع: \`${escMd(week)}\`\n` +
    `📥 تحميلات ناجحة: *${total}*\n` +
    xpLine +
    `🎭 ذوقك: ${escMd(taste)}\n\n` +
    `*أبرز ما طلبت:*\n${booksBlock}\n\n` +
    `💬 _${escMd(encouragement(total))}_\n\n` +
    `_تقرير شخصي · لا مقارنة مع أحد · على مهل_`
  );
}

export function kbPersonalWeek(
  topBooks: { title: string; count: number }[],
): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (const b of topBooks.slice(0, 3)) {
    const k = storeRetryKey(b.title);
    const label = b.title.length > 30 ? b.title.slice(0, 29) + "…" : b.title;
    rows.push([{ text: `📥  ${label}`, callback_data: `retry:${k}` }]);
  }
  rows.push([
    { text: "📖  كتاب اليوم", callback_data: "botd:show" },
    { text: "🎲  مفاجأة", callback_data: "rg:any" },
  ]);
  rows.push([
    { text: "👤  ملفي", callback_data: "my_profile" },
    { text: "🏠  الرئيسية", callback_data: "main_menu" },
  ]);
  return { inline_keyboard: rows };
}

export async function sendPersonalWeekReport(
  bot: TelegramBot,
  chatId: number,
  userId: string,
): Promise<void> {
  const stats = await getPersonalWeekStats(userId);
  const text = await buildPersonalWeekMessage(userId);
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: kbPersonalWeek(stats.topBooks),
  });
}

/** سطر قصير للملف الشخصي */
export async function buildPersonalWeekProfileLine(userId: string): Promise<string> {
  const { total } = await getPersonalWeekStats(userId);
  if (total <= 0) return `📅 *هذا الأسبوع:* لم تُسجَّل تحميلات بعد · /myweek`;
  return `📅 *هذا الأسبوع:* *${total}* تحميل · التفاصيل /myweek`;
}

// ── Sunday soft push (via retention worker) ───
export async function sendSundayWeekReports(bot: TelegramBot): Promise<void> {
  // Cairo: Sunday = 0 in JS getUTCDay if we use cairo wall... use Date with cairo offset
  // cairoHourNumber already exists; for weekday use cairoDateString + Date parse
  const day = cairoDateString();
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Cairo calendar date as UTC components approximates weekday for Egypt (no TZ library)
  // Better: use Intl
  let weekday = "";
  try {
    weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Cairo",
      weekday: "short",
    }).format(new Date());
  } catch {
    weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
  }
  if (weekday !== "Sun") return;

  const hour = cairoHourNumber();
  if (hour < 17 || hour > 20) return; // evening Sunday soft window

  const week = isoWeekKey();
  const lock = await redis
    .set(`ret:uweek_lock:${week}:${hour}`, "1", "EX", 50 * 60, "NX")
    .catch(() => null);
  if (lock !== "OK") return;

  try {
    const weekAgo = Date.now() - 10 * 86400_000;
    const uids = await redis
      .zrangebyscore("user:lastSeen", weekAgo, "+inf", "LIMIT", 0, 150)
      .catch(() => [] as string[]);
    let sent = 0;
    for (const uid of uids) {
      if (sent >= 25) break;
      if (!uid || !/^\d+$/.test(uid)) continue;
      const already = await redis.get(CLAIM_KEY(uid, week));
      if (already === "1") continue;
      const { total, topBooks } = await getPersonalWeekStats(uid, week);
      if (total < 1) continue;
      const sunOn = await getPref(uid, "sunday").catch(() => true);
      if (!sunOn) continue;

      const text =
        `🕯 *ختام أسبوع هادئ مع ${BOT_NAME}*\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        (await buildPersonalWeekMessage(uid)) +
        `\n\n_رسالة اختيارية — تجاهلها كما تشاء._`;

      try {
        await bot.sendMessage(Number(uid), text, {
          parse_mode: "Markdown",
          reply_markup: kbPersonalWeek(topBooks),
        });
        await redis.set(CLAIM_KEY(uid, week), "1", "EX", TTL);
        sent++;
        redis.incr("tel:retention:week_report").catch(() => {});
      } catch { /* blocked */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (sent > 0) L.info("personalWeek", "sunday reports sent", { sent, week });
  } catch (e) {
    L.warn("personalWeek", "sendSundayWeekReports failed", { err: String(e).slice(0, 100) });
  }
}
