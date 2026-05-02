// ══════════════════════════════════════════════
// TEXT UTILITIES — Arabic normalization + Markdown escaping
// ══════════════════════════════════════════════

/**
 * normalizeArabic — تُعيَّر النص العربي للمقارنة:
 *  1. يُزال التشكيل الكامل (harakat + tatweel)
 *  2. تُحوَّل Arabic Presentation Forms → أحرف أساسية (ﻋ → ع)
 *  3. تُوحَّد الهمزات: أ إ آ → ا
 *  4. تُوحَّد الألف المقصورة: ى → ي
 *  5. تُوحَّد التاء المربوطة: ة → ه
 *
 * E5 FIX: إضافة:
 *   - Tatweel (ـ) U+0640: يكتب بعض الناس "مـحـمـد" بدل "محمد"
 *   - Arabic Presentation Forms A/B (FB50–FDFF, FE70–FEFF):
 *     بعض البرامج القديمة تحفظ "ﻋ" بدل "ع" → normalizeArabic يجب أن تُساوي بينهما.
 *     نستخدم NFC أولاً (يحوّل بعض الأشكال المركّبة) ثم regex للباقي.
 */
export function normalizeArabic(text: string): string {
  if (!text) return "";
  return text
    // NFC يحوّل المركّبات Unicode إلى شكلها الكنوني
    .normalize("NFC")
    // Arabic Presentation Forms A (FB50–FDFF) — أشكال بداية/وسط/نهاية الحروف
    // Arabic Presentation Forms B (FE70–FEFF) — حركات ممتدة وأشكال موصولة
    .replace(/[\uFB50-\uFDFF\uFE70-\uFEFF]/g, (ch) => {
      // محاولة تحويل الـ char عبر NFD + إزالة diacritics
      try { return ch.normalize("NFKD").replace(/[\u0300-\u036F]/g, ""); }
      catch { return ch; }
    })
    // Tatweel ـ (U+0640) — حرف المد الزخرفي
    .replace(/\u0640/g, "")
    // التشكيل الكامل: fathah, dammah, kasrah, sukun, shadda + علامات قرآنية
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670]/g, "")
    // توحيد الهمزات
    .replace(/[أإآ]/g, "ا")
    // ألف مقصورة → ياء
    .replace(/ى/g, "ي")
    // تاء مربوطة → هاء
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * normalizeForCache — مفتاح كاش موحّد:
 * normalizeArabic + lowercase + حذف الترقيم
 */
export function normalizeForCache(text: string): string {
  if (!text) return "";
  return normalizeArabic(text)
    .toLowerCase()
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * escMd — يُهرّب النصوص لـ Telegram Markdown v1
 * الأحرف الخاصة: _ * ` [
 */
export function escMd(text: string): string {
  if (!text) return "";
  return text.replace(/[_*`\[]/g, "\\$&");
}

const RELEVANCE_STOPWORDS = new Set([
  "كتاب",
  "كتب",
  "روايه",
  "روايات",
  "تحميل",
  "تنزيل",
  "قراءه",
  "pdf",
  "نسخه",
  "مجانا",
  "free",
  "book",
  "books",
  "download",
  "read",
  "ebook",
]);

function relevanceWords(text: string): string[] {
  const normalized = normalizeArabic(text)
    .toLowerCase()
    .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, " ");

  return normalized
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !RELEVANCE_STOPWORDS.has(w));
}

export function normalizeBookCacheKey(text: string): string {
  const words = relevanceWords(text);
  return words.length > 0 ? words.join(" ") : normalizeForCache(text);
}

/**
 * urlFilenameRelevance — مدى صلة اسم الملف في الـ URL بالكتاب المطلوب.
 * يُعيد 0 (لا صلة) إلى 1 (تطابق كامل).
 *
 * الخوارزمية:
 *  1. استخرج اسم الملف من URL وحوّله لكلمات
 *  2. قسِّم اسم الكتاب إلى كلمات
 *  3. احسب نسبة كلمات الكتاب الموجودة في اسم الملف
 */
export function urlFilenameRelevance(bookName: string, url: string): number {
  if (!url || !bookName) return 0.5;

  let filename = "";
  try {
    const parsed = new URL(url);
    filename = parsed.pathname.split("/").pop() || "";
    for (const key of ["title", "book", "name", "file", "q"]) {
      const value = parsed.searchParams.get(key);
      if (value) filename += ` ${value}`;
    }
  } catch {
    filename = url.split("/").pop()?.split("?")[0] || "";
  }
  filename = filename.replace(/\.(pdf|html?|php)$/i, "");
  if (!filename) return 0.5;

  let cleanFilename = filename;
  try { cleanFilename = decodeURIComponent(filename); } catch {}
  // BUG-4 FIX: يجب تعيير الـ Arabic في اسم الملف أيضاً قبل المقارنة.
  // المشكلة: bookWords مُعيَّرة (normalizeArabic → "أ" تصبح "ا")
  //           لكن cleanFilename كانت بدون تعيير → "أرض" في الملف لا تطابق "ارض" من الكتاب.
  // الحل: نُعيَّر cleanFilename بنفس normalizeArabic قبل استخراج الكلمات.
  cleanFilename = normalizeArabic(cleanFilename)
    .replace(/[-_+.]/g, " ")
    .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, " ")
    .toLowerCase();

  const bookWords = relevanceWords(bookName);
  if (bookWords.length === 0) return 0.5;

  const filenameWords = new Set(
    cleanFilename.split(/\s+/).filter((w) => w.length >= 2)
  );
  const filenameFlat = cleanFilename.replace(/\s/g, "");

  let matched = 0;
  for (const word of bookWords) {
    // word مُعيَّرة بالفعل (من normBook) — نستخدمها مباشرة
    if (filenameWords.has(word) || filenameFlat.includes(word)) {
      matched++;
    }
  }
  return matched / bookWords.length;
}
