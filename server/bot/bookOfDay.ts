// ══════════════════════════════════════════════
// كتاب اليوم — اقتراح يومي ثابت (بتوقيت القاهرة)
//
// يُخزَّن في Redis مرّة يومياً. يظهر في:
//   • زر «📖 كتاب اليوم» / الأمر /today
//   • الرسالة الصباحية الدافئة
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { cairoDateString, escMd } from "./text.js";
import { SUGGESTIONS, GENRE_MAP } from "./suggestions.js";
import { storeRetryKey } from "./session.js";
import { BOT_NAME } from "./brand.js";

const KEY = (day: string) => `ret:botd:${day}`;

/** عناوين نظيفة بلا شرطة مؤلّف طويلة للبحث */
function cleanTitle(raw: string): string {
  // "العنوان — المؤلف" → العنوان
  const part = raw.split(/\s*[—–-]\s*/)[0]?.trim() || raw.trim();
  return part.slice(0, 120);
}

function catalog(): string[] {
  const set = new Set<string>();
  for (const s of SUGGESTIONS) {
    const t = cleanTitle(s);
    if (t.length >= 3) set.add(t);
  }
  for (const books of Object.values(GENRE_MAP)) {
    for (const b of books) {
      const t = cleanTitle(b);
      if (t.length >= 3) set.add(t);
    }
  }
  return [...set];
}

function pickForDay(day: string, pool: string[]): string {
  let h = 2166136261;
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // mix more for stability across restarts
  h = (h >>> 0) % pool.length;
  return pool[h] || pool[0] || "الأمير الصغير";
}

export async function getBookOfDay(): Promise<{ day: string; title: string }> {
  const day = cairoDateString();
  try {
    const cached = await redis.get(KEY(day));
    if (cached && cached.trim().length >= 2) {
      return { day, title: cached.trim() };
    }
  } catch { /* */ }

  const pool = catalog();
  const title = pickForDay(day, pool);
  try {
    await redis.set(KEY(day), title, "EX", 3 * 86400);
  } catch { /* */ }
  return { day, title };
}

const WHY_LINES = [
  "اختيار هادئ ليومك — يستحق دقائق من التركيز.",
  "عنوان يفتح باباً للقراءة دون التزام ثقيل.",
  "اقتراح اليوم من مكتبة رفيق — بلا ضغط.",
  "إن كان لديك مزاج للقراءة، فهذا عنوان جميل للبداية.",
  "رفيق اختار لك شيئاً متوازناً بين الفائدة والمتعة.",
] as const;

function whyLine(day: string): string {
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) >>> 0;
  return WHY_LINES[h % WHY_LINES.length];
}

export async function buildBookOfDayMessage(): Promise<string> {
  const { day, title } = await getBookOfDay();
  return (
    `📖 *كتاب اليوم*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `📗 «${escMd(title)}»\n\n` +
    `_${escMd(whyLine(day))}_\n\n` +
    `📅 ${escMd(day)} · ${BOT_NAME}\n\n` +
    `*ماذا بعد؟*\n` +
    `◦ اضغط «أرسل الكتاب» للبحث والتحميل\n` +
    `◦ أو اكتب عنواناً آخر في المحادثة\n` +
    `◦ أو تجاهل الاقتراح كما تشاء`
  );
}

/** سطر قصير يُدمج في الإشعار الصباحي */
export async function bookOfDayMorningBlock(): Promise<{ text: string; title: string }> {
  const { title } = await getBookOfDay();
  return {
    title,
    text:
      `📖 *كتاب اليوم:* «${escMd(title)}»\n` +
      `_اضغط الزر أدناه إن رغبت في استلامه._`,
  };
}

export function kbBookOfDay(title?: string): TelegramBot.InlineKeyboardMarkup {
  // نستخدم storeRetryKey لتخزين العنوان تحت مفتاح قصير
  // إن لم يُمرَّر عنوان، نبني زراً generic يعيد التحميل من redis عبر callback botd:go
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (title && title.trim()) {
    const k = storeRetryKey(title.trim());
    rows.push([{ text: "📥  أرسل الكتاب", callback_data: `retry:${k}` }]);
  } else {
    rows.push([{ text: "📥  أرسل كتاب اليوم", callback_data: "botd:go" }]);
  }
  rows.push([
    { text: "🎲  مفاجأة أخرى", callback_data: "rg:any" },
    { text: "✅  سجّل حضورك", callback_data: "daily_quest" },
  ]);
  rows.push([{ text: "🏠  الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

export async function kbBookOfDayAsync(): Promise<TelegramBot.InlineKeyboardMarkup> {
  const { title } = await getBookOfDay();
  return kbBookOfDay(title);
}
