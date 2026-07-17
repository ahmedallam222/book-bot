import TelegramBot from "node-telegram-bot-api";
import type { BookResult } from "./types.js";
import { escMd } from "./text.js";
import { storeRetryKey, storeFeedbackUrl, storeSummaryKey } from "./session.js";
import { DIV, DIV_SOFT } from "./ui.js";

// ══════════════════════════════════════════════════════════════
// KEYBOARDS — رفيق v9 (وضوح أولاً)
// ──────────────────────────────────────────────────────────────
// فلسفة:
//   • الصف الأول = الفعل الأكثر احتمالاً
//   • تجميع منطقي: بحث | اكتشاف | أنا | إبداع | ترقية
//   • تسميات قصيرة واضحة — مسافتان بعد الإيموجي للقراءة
// ══════════════════════════════════════════════════════════════

const CB_MAX_BYTES = 64;

function safeCb(data: string): string {
  if (Buffer.byteLength(data, "utf8") <= CB_MAX_BYTES) return data;
  let t = data;
  while (Buffer.byteLength(t, "utf8") > CB_MAX_BYTES) t = t.slice(0, -1);
  return t;
}

// ── القائمة الرئيسية ──────────────────────────────────────
export function kbMain(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🔍  ابحث عن كتاب", callback_data: "new_search" },
        { text: "🎲  كتاب مفاجأة", callback_data: "rg:any" },
      ],
      [
        { text: "✅  سجّل حضورك", callback_data: "daily_quest" },
        { text: "📖  كتاب اليوم", callback_data: "botd:show" },
      ],
      [
        { text: "👤  ملفي", callback_data: "my_profile" },
        { text: "📚  مكتبتي", callback_data: "my_library" },
      ],
      [
        { text: "📊  أسبوعي أنا", callback_data: "my_week" },
        { text: "▶️  أكمل رحلتي", callback_data: "lib_continue" },
      ],
      [
        { text: "🔖  أمنياتي", callback_data: "wishlist_view" },
        { text: "📖  قوائم مختارة", callback_data: "curated_menu" },
      ],
      [
        { text: "📅  هذا الأسبوع", callback_data: "weekly_refresh" },
        { text: "🎨  اصنع صورة", callback_data: "img_gen" },
      ],
      [
        { text: "🎁  ادعُ صديقاً", callback_data: "invite_view" },
        { text: "⭐  Premium", callback_data: "premium_buy" },
      ],
      [
        { text: "❓  كيف أستخدم رفيق؟", callback_data: "help" },
      ],
    ],
  };
}

// ── بعد النجاح ────────────────────────────────────────────
export function kbAfterSuccess(
  bookName: string,
  sourceUrl?: string,
  opts?: { isPrem?: boolean; fromCache?: boolean; related?: string[] },
): TelegramBot.InlineKeyboardMarkup {
  const retryK   = storeRetryKey(bookName);
  const summaryK = storeSummaryKey(bookName, sourceUrl || undefined);
  const isPrem = !!opts?.isPrem;
  const related = (opts?.related || []).slice(0, 2);

  // Post-delivery UX:
  //  primary: summary + wishlist
  //  discover: related titles (one-tap)
  //  more: search + surprise
  //  quality + nav
  const rows: TelegramBot.InlineKeyboardButton[][] = [
    [
      { text: "📘  ملخّص سريع", callback_data: safeCb(`sum:${summaryK}`) },
      { text: "🔖  احفظه",     callback_data: safeCb(`wishlist_add:${retryK}`) },
    ],
  ];
  for (const title of related) {
    const rk = storeRetryKey(title);
    const label = title.length > 28 ? title.slice(0, 27) + "…" : title;
    rows.push([{ text: `✨  ${label}`, callback_data: safeCb(`retry:${rk}`) }]);
  }
  rows.push([
      { text: "🔍  كتاب آخر", callback_data: "new_search" },
      { text: "🎲  مفاجأة",   callback_data: "rg:any" },
  ]);

  if (sourceUrl) {
    const fbKey = storeFeedbackUrl(sourceUrl, bookName);
    rows.push([
      { text: "⚠️  ليس هذا الكتاب؟", callback_data: safeCb(`bad_file:${fbKey}`) },
      { text: "🔁  أعد إرسال الملف",      callback_data: safeCb(`retry:${retryK}`) },
    ]);
  } else {
    rows.push([
      { text: "🔁  أعد إرسال الملف", callback_data: safeCb(`retry:${retryK}`) },
    ]);
  }

  rows.push([
    { text: "📚  مكتبتي", callback_data: "my_library" },
    { text: "▶️  أكمل لاحقاً", callback_data: "lib_continue" },
  ]);

  if (isPrem) {
    rows.push([
      { text: "👤  ملفي",     callback_data: "my_profile" },
      { text: "🏠  الرئيسية", callback_data: "main_menu" },
    ]);
  } else {
    rows.push([
      { text: "⭐  Premium",  callback_data: "premium_buy" },
      { text: "🏠  الرئيسية", callback_data: "main_menu" },
    ]);
  }

  return { inline_keyboard: rows };
}

// ──لفشل ─────────────────────────────────────────────
export function kbAfterFail(
  bookName: string,
  results:  BookResult[],
  page      = 0
): TelegramBot.InlineKeyboardMarkup {
  const PAGE_SIZE  = 5;
  const totalPages = Math.ceil(results.length / PAGE_SIZE);
  const retryK     = storeRetryKey(bookName);
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  if (totalPages > 1) {
    const nav: TelegramBot.InlineKeyboardButton[] = [];
    if (page > 0)
      nav.push({ text: "◀️", callback_data: safeCb(`fp:${retryK}:${page - 1}`) });
    nav.push({ text: `📄  ${page + 1}/${totalPages}`, callback_data: "noop" });
    if (page < totalPages - 1)
      nav.push({ text: "▶️", callback_data: safeCb(`fp:${retryK}:${page + 1}`) });
    rows.push(nav);
  }

  rows.push([
    { text: "🔁  أعد المحاولة",  callback_data: safeCb(`retry:${retryK}`) },
    { text: "🔍  عنوان مختلف",      callback_data: "new_search"               },
  ]);
  rows.push([
    { text: "🎲  مفاجأة",        callback_data: "rg:any"    },
    { text: "🏠  الرئيسية",       callback_data: "main_menu" },
  ]);
  return { inline_keyboard: rows };
}

// ── لا نتائج ──────────────────────────────────────────────
export function kbNoResults(bookName: string): TelegramBot.InlineKeyboardMarkup {
  const retryK = storeRetryKey(bookName);
  return {
    inline_keyboard: [
      [
        { text: "🔁  أعد المحاولة",  callback_data: safeCb(`retry:${retryK}`) },
        { text: "🔍  عنوان مختلف",      callback_data: "new_search"               },
      ],
      [
        { text: "🔖  للأمنيات",     callback_data: safeCb(`wishlist_add:${retryK}`) },
        { text: "🎲  مفاجأة",        callback_data: "rg:any"                        },
      ],
      [
        { text: "🏠  الرئيسية",       callback_data: "main_menu" },
      ],
    ],
  };
}

// ── الطابور ───────────────────────────────────────────────
export function kbQueued(position: number): TelegramBot.InlineKeyboardMarkup {
  const posLabel = position <= 1 ? "🟢  يُعالَج الآن" : `🔢  موقعك #${position}`;
  return {
    inline_keyboard: [
      [{ text: posLabel, callback_data: "queue_status" }],
      [
        { text: "❌  إلغاء",         callback_data: "cancel_my_jobs" },
        { text: "📋  حالة الطابور",  callback_data: "queue_status"   },
      ],
    ],
  };
}

// ── رسالة فشل مع روابط معاينة ────────────────────────────
export function buildFailMessage(
  bookName: string,
  results:  BookResult[],
  page      = 0
): string {
  if (results.length === 0) {
    return (
      `😔 *لم أجد PDF قابلاً للإرسال*\n` +
      `${DIV}\n` +
      `📖  _«${escMd(bookName.slice(0, 52))}»_\n\n` +
      `جرّب العنوان فقط، أو أضف اسم المؤلف.`
    );
  }

  const PAGE_SIZE  = 5;
  const totalPages = Math.ceil(results.length / PAGE_SIZE);
  const slice      = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const directCount = results.filter((r) => r.access === "direct_pdf").length;
  const downloadPageCount = results.filter((r) => r.access === "download_page").length;
  const protectedCount = results.filter((r) => r.access === "protected_page").length;

  let msg =
    `🔎 *تعذّر الإرسال التلقائي*\n` +
    `${DIV}\n` +
    `📖  _«${escMd(bookName.slice(0, 52))}»_\n`;

  if (totalPages > 1) msg += `_صفحة ${page + 1} من ${totalPages}_\n`;
  msg += `\n`;
  if (directCount > 0) msg += `• PDF فشل الإرسال: *${directCount}*\n`;
  if (downloadPageCount > 0) msg += `• صفحات تحميل محتملة: *${downloadPageCount}*\n`;
  if (protectedCount > 0) msg += `• مدفوع / قراءة فقط: *${protectedCount}*\n`;
  msg += `\n${DIV_SOFT}\n_معاينة — ليست تحميلاً مضموناً:_\n\n`;

  slice.forEach((r, i) => {
    const rawUrl  = r.directPdfUrl || r.url;
    const safeUrl = rawUrl.replace(/\)/g, "%29").replace(/\]/g, "%5D");
    const labelByAccess: Record<BookResult["access"], string> = {
      direct_pdf:     "PDF",
      download_page:  "تحميل",
      catalog_page:   "معلومات",
      protected_page: "مدفوع",
    };
    const label = labelByAccess[r.access ?? (r.directPdfUrl ? "direct_pdf" : "catalog_page")];
    const star  = (r._score && r._score > 0.5) ? " ⭐" : "";
    const num   = page * PAGE_SIZE + i + 1;
    msg += `${num}\\. ${r.source.emoji} [${escMd(r.title.slice(0, 36))}](${safeUrl}) _${label}${star}_\n`;
  });

  return msg;
}