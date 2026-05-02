import { L } from "./logger.js";

// ══════════════════════════════════════════════
// BOOK NAME PARSER — تنظيف وتحسين اسم الكتاب
// ══════════════════════════════════════════════

// أنماط تُزيل noise من اسم الكتاب قبل البحث
const NOISE_PATTERNS: RegExp[] = [
  /\btحميل\b/gi,
  /\bdownload\b/gi,
  /\bpdf\b/gi,
  /\bمجاني\b/gi,
  /\bمجاناً\b/gi,
  /\bتنزيل\b/gi,
  /\bاقرأ\b/gi,
  /\bقراءة\b/gi,
  /\bكامل\b/gi,      // "الكتاب كامل"
  /\bمترجم\b/gi,
  /\bترجمة\b/gi,
];

// أنماط الكلمات التي تسبق الاسم الحقيقي
const LEADING_NOISE = /^(?:كتاب|رواية|قصة|ديوان|كتب|روايات)\s+/i;

/**
 * يُنظّف اسم الكتاب ويُحسّن صياغته للبحث
 *
 * الخطوات:
 *  1. حذف الـ noise words (تحميل، pdf، مجاني...)
 *  2. حذف كلمات الـ prefix الزائدة (كتاب، رواية...)
 *  3. تنظيف المسافات المتعددة
 *  4. يُبقي الاسم كما هو إذا لم يتغير شيء مهم
 */
export async function parseBookName(bookName: string): Promise<string> {
  if (!bookName.trim()) return bookName;

  let cleaned = bookName.trim();

  // 1. حذف noise words
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "").trim();
  }

  // 2. حذف كلمات الـ prefix الزائدة (فقط من البداية)
  const withoutLeading = cleaned.replace(LEADING_NOISE, "").trim();

  // لا نحذف الـ prefix إذا ما بقي شيء ذو معنى بعده
  if (withoutLeading.length >= 3) {
    cleaned = withoutLeading;
  }

  // 3. تنظيف المسافات
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();

  // 4. لو الناتج قصير جداً → ارجع للأصل
  if (cleaned.length < 2) {
    return bookName.trim();
  }

  if (cleaned !== bookName.trim()) {
    L.debug("parser", `Book name normalized`, {
      original: bookName.slice(0, 60),
      parsed:   cleaned.slice(0, 60),
    });
  }

  return cleaned;
}
