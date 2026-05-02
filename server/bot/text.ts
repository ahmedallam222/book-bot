// ══════════════════════════════════════════════
// TEXT UTILITIES — خلاصة الكتب
// ══════════════════════════════════════════════

/**
 * Markdown v1 escaping — يهرّب أحرف التنسيق الخاصة
 * يدعم: * _ ` [ ]
 */
export function escMd(text: string): string {
  return text.replace(/([*_`[]])/g, "\\$1"); // ✅ FIX: أُضيف ] لإغلاق الـ character class
}

/**
 * توحيد النص العربي — للكاش والمقارنة
 * يُزيل التشكيل ويوحّد أشكال الحروف
 */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ٰٟ]/g, "")  // حذف التشكيل
    .replace(/[أإآٱ]/g, "ا")                 // توحيد الألف
    .replace(/ة/g,  "ه")                      // تاء مربوطة → هاء
    .replace(/ى/g,  "ي")                      // ألف مقصورة → ياء
    .replace(/ؤ/g,  "و")
    .replace(/ئ/g,  "ي")
    .replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48))
    .trim()
    .toLowerCase();
}

/**
 * تطبيع للكاش — يُوحّد النص ويُحوّله لـ lowercase للمقارنة
 */
export function normalizeForCache(text: string): string {
  return normalizeArabic(text)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * تنظيف استعلام البحث — يُزيل كلمات الحشو الشائعة
 * مثال: "تحميل رواية اسمها أرض زيكولا pdf مجانا" → "أرض زيكولا"
 */
export function cleanSearchQuery(query: string): string {
  const fillerWords = [
    // أفعال الطلب
    "تحميل", "تنزيل", "حمل", "نزل", "ابغي", "ابغى", "ابي", "أبي",
    "اريد", "أريد", "ممكن", "اجيب", "أجيب", "اطلب", "أطلب",
    // كلمات وصفية
    "كتاب", "رواية", "روايه", "قصة", "قصه", "كتيب", "مؤلف",
    "كتب", "روايات", "قصص", "ملف",
    // كلمات تقنية
    "pdf", "PDF", "ebook", "epub",
    // كلمات الوصف
    "اسمه", "اسمها", "اسمه", "اسمها", "يسمى", "تسمى",
    "مجانا", "مجانًا", "مجاني", "مجانية", "free", "مجاناً",
    "كامل", "كاملة", "كامله", "نسخة", "نسخه",
  ];

  let cleaned = query.trim();

  // أزل الكلمات من البداية والنهاية والوسط
  for (const word of fillerWords) {
    // استخدم regex لتجنب إزالة كلمات جزئية
    const re = new RegExp(`(^|\\s)${word}(\\s|$)`, "gi");
    cleaned = cleaned.replace(re, " ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // لو التنظيف أفرغ الاستعلام — ارجع للأصلي
  if (cleaned.length < 2) return query.trim();

  return cleaned;
}

/**
 * وقت التجديد التالي — يُستخدم في رسائل الـ stats والـ daily limit
 * يُعيد مثلاً: "5 ساعة و23 دقيقة" أو "47 دقيقة" أو "دقائق قليلة"
 */
export function buildResetTime(): string {
  const midnight = new Date();
  midnight.setUTCHours(24, 0, 0, 0);
  const diffMs = midnight.getTime() - Date.now();
  const diffH  = Math.floor(diffMs / 3_600_000);
  const diffM  = Math.floor((diffMs % 3_600_000) / 60_000);
  return diffH > 0
    ? `${diffH} ساعة و${diffM} دقيقة`
    : diffM > 1
    ? `${diffM} دقيقة`
    : "دقائق قليلة";
}

/**
 * يُستخدم لترتيب URLs قبل التحميل —
 * أسماء الملفات الرقمية تحصل على 0.3 neutral بدل 0
 */
export function urlFilenameRelevance(bookName: string, url: string): number {
  try {
    const filename = decodeURIComponent(
      new URL(url).pathname.split("/").pop()?.split("?")[0] || ""
    ).replace(/\.pdf$/i, "").replace(/[-_+]/g, " ").trim().toLowerCase();

    if (!filename || filename.length < 2) return 0;

    // اسم الملف رقمي بحت (ID من archive.org مثلاً) — neutral score
    if (/^\d+$/.test(filename.replace(/\s/g, ""))) return 0.3;

    const normBook = normalizeForCache(bookName);
    const normFile = normalizeForCache(filename);

    const bookWords = normBook.split(/\s+/).filter((w) => w.length >= 3);
    const fileWords = new Set(normFile.split(/\s+/).filter((w) => w.length >= 3));

    if (bookWords.length === 0 || fileWords.size === 0) return 0.1;

    const matched = bookWords.filter((w) => fileWords.has(w)).length;

    // FIX: لو مفيش تطابق كلمات لكن اسم الملف يحتوي جزء من اسم الكتاب كـ substring
    // مثال: bookName="مئة عام من العزلة", filename="miaamilazla" (transliteration)
    // لا نرفضه بصفر — نعطيه 0.15 بدل 0
    if (matched === 0) {
      const bookNoSpace = normBook.replace(/\s/g, "");
      const fileNoSpace = normFile.replace(/\s/g, "");
      if (fileNoSpace.length > 4 && bookNoSpace.includes(fileNoSpace.slice(0, 5))) return 0.15;
      return 0;
    }

    return matched / bookWords.length;
  } catch {
    return 0;
  }
}
