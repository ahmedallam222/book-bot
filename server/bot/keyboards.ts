import TelegramBot from "node-telegram-bot-api";
import type { BookResult } from "./types.js";
import { escMd } from "./text.js";
import { storeRetryKey, storeFeedbackUrl } from "./session.js";

// ══════════════════════════════════════════════════════════════
//  KEYBOARDS — خلاصة الكتب v6
//  الفلسفة: أزرار ذات معنى — كل زر يُجيب على سؤال يحمله المستخدم
//  ترتيب: الأكثر أهمية أولاً — لا ضجيج بصري
// ══════════════════════════════════════════════════════════════

const CB_MAX_BYTES = 64;

function safeCb(data: string): string {
  if (Buffer.byteLength(data, "utf8") <= CB_MAX_BYTES) return data;
  let t = data;
  while (Buffer.byteLength(t, "utf8") > CB_MAX_BYTES) t = t.slice(0, -1);
  return t;
}

// ── القائمة الرئيسية ──────────────────────────────────────
// ترتيب: البحث هو القلب — ثم الاكتشاف — ثم الأدوات
export function kbMain(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🔍  ابحث عن كتاب",    callback_data: "new_search"  },
      ],
      [
        { text: "📊  إحصائياتي",        callback_data: "my_stats"    },
        { text: "📚  سجل كتبي",         callback_data: "my_history"  },
      ],
      [
        { text: "🏆  الأكثر تحميلاً",   callback_data: "top_books"   },
      ],
      [
        { text: "❓  مساعدة",            callback_data: "help"        },
      ],
    ],
  };
}

// ── بعد إرسال الكتاب بنجاح ────────────────────────────────
// السياق: المستخدم فرحان — نُعطيه خياراً للاستمرار أو الإبلاغ
export function kbAfterSuccess(
  bookName: string,
  sourceUrl: string
): TelegramBot.InlineKeyboardMarkup {
  const retryK = storeRetryKey(bookName);
  const rows: TelegramBot.InlineKeyboardButton[][] = [
    [
      { text: "🔍  كتاب آخر",      callback_data: "new_search"  },
    ],
    [
      { text: "🔁  أعد الإرسال",   callback_data: safeCb(`retry:${retryK}`) },
    ],
  ];

  if (sourceUrl) {
    const fbKey = storeFeedbackUrl(sourceUrl, bookName);
    rows[1].push({ text: "⚠️  ملف خاطئ؟", callback_data: safeCb(`bad_file:${fbKey}`) });
  }

  rows.push([{ text: "🏠  القائمة الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

// ── بعد الفشل — مع pagination محسّن ──────────────────────
export function kbAfterFail(
  bookName: string,
  results:  BookResult[],
  page      = 0
): TelegramBot.InlineKeyboardMarkup {
  const PAGE_SIZE  = 5;
  const totalPages = Math.ceil(results.length / PAGE_SIZE);
  const retryK     = storeRetryKey(bookName);
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  // التنقل — فقط لو يوجد أكثر من صفحة
  if (totalPages > 1) {
    const nav: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 0)
      nav.push({ text: "◀️", callback_data: safeCb(`fp:${retryK}:${page - 1}`) });
    nav.push({ text: `📄  ${page + 1} / ${totalPages}`, callback_data: "noop" });
    if (page < totalPages - 1)
      nav.push({ text: "▶️", callback_data: safeCb(`fp:${retryK}:${page + 1}`) });
    rows.push(nav);
  }

  rows.push([
    { text: "🔄  أعد المحاولة",    callback_data: safeCb(`retry:${retryK}`) },
    { text: "🔍  بحث جديد",        callback_data: "new_search"               },
  ]);
  rows.push([{ text: "🏠  القائمة", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

// ── بعد لا نتائج ─────────────────────────────────────────
export function kbNoResults(bookName: string): TelegramBot.InlineKeyboardMarkup {
  const retryK = storeRetryKey(bookName);
  return {
    inline_keyboard: [
      [
        { text: "🔄  أعد المحاولة",  callback_data: safeCb(`retry:${retryK}`) },
        { text: "🔍  بحث جديد",      callback_data: "new_search"               },
      ],
      [
        { text: "🏠  القائمة",        callback_data: "main_menu"    },
      ],
    ],
  };
}

// ── الطابور — مع عرض الموقع ───────────────────────────────
export function kbQueued(position: number): TelegramBot.InlineKeyboardMarkup {
  const posLabel = position <= 1 ? "🟢  يُعالَج الآن" : `🔢  موقعك: #${position}`;
  return {
    inline_keyboard: [
      [{ text: posLabel, callback_data: "queue_status" }],
      [
        { text: "❌  إلغاء طلبي",     callback_data: "cancel_my_jobs" },
        { text: "📋  حالة الطابور",   callback_data: "queue_status"   },
      ],
    ],
  };
}

// ── رسالة فشل الإرسال مع الروابط ────────────────────────
export function buildFailMessage(
  bookName: string,
  results:  BookResult[],
  page      = 0
): string {
  if (results.length === 0) {
    return (
      `😔 *لم أجد روابط قابلة للتحميل*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `_"${escMd(bookName.slice(0, 52))}"_\n\n` +
      `💡 جرّب صياغة مختلفة أو أضف اسم المؤلف`
    );
  }

  const PAGE_SIZE  = 5;
  const totalPages = Math.ceil(results.length / PAGE_SIZE);
  const slice      = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  let msg =
    `🔗 *${results.length} رابط مباشر*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `_"${escMd(bookName.slice(0, 52))}"_\n`;

  if (totalPages > 1) msg += `_صفحة ${page + 1} من ${totalPages}_\n`;
  msg += `\n_لم ينجح الإرسال التلقائي — اختر رابطاً مباشراً:_\n\n`;

  slice.forEach((r, i) => {
    const rawUrl  = r.directPdfUrl || r.url;
    const safeUrl = rawUrl.replace(/\)/g, "%29").replace(/\]/g, "%5D");
    const label   = r.directPdfUrl ? "PDF" : "صفحة";
    const star    = (r._score && r._score > 0.5) ? " ⭐" : "";
    const num     = page * PAGE_SIZE + i + 1;
    msg += `${num}\\. ${r.source.emoji} [${escMd(r.title.slice(0, 38))}](${safeUrl}) _${label}${star}_\n`;
  });

  return msg;
}

