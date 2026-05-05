// ══════════════════════════════════════════════
// TEXT UTILITIES — خلاصة الكتب
// ══════════════════════════════════════════════

/**
 * Markdown v1 escaping — يهرّب أحرف التنسيق الخاصة
 * يدعم: * _ ` [ ]
 *
 * BUG FIX: الإصدار السابق كان `/([*_`[]])/g` — قراءته الفعلية:
 *   character class = [*_`[]   ثم literal ]
 * أي أنه كان يهرِّب أحد الأحرف فقط لو جاء بعده `]` مباشرة. كل بقية
 * الحالات كانت تمر دون escape ← Telegram يرفض الرسالة (`can't parse
 * entities`) والـ `.catch(() => {})` في الـ callers يبتلع الخطأ.
 * الآن: نهرِّب الأحرف الخمسة بشكل صحيح بـ escape للأقواس داخل الـ class.
 */
export function escMd(text: string): string {
  return text.replace(/([_*`\[\]])/g, "\\$1");
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
 * Canonical key for cache lookup/insert.
 *
 * FIX-WRONG-FILE (BUG-2/6/7/8): دمج 3 خطوات:
 *   1. cleanSearchQuery — يُزيل كلمات الحشو ("تحميل"، "كتاب"، "pdf"، إلخ)
 *      → "تحميل كتاب أرض زيكولا pdf" و "أرض زيكولا" يلتقيان على نفس المفتاح
 *   2. normalizeArabic — يوحّد أ/إ/آ → ا، ة → ه، ى → ي، يحذف التشكيل
 *      → "أرض زيكولا" و "ارض زيكولا" يلتقيان على نفس المفتاح
 *   3. space normalization — يوحّد المسافات
 *
 * هذا يحلّ:
 *   - تخزين مكرّر لنفس الكتاب تحت أشكال مختلفة
 *   - حرمان مستخدم B من الاستفادة من كاش مستخدم A عند اختلاف الصياغة
 *
 * استخدم هذه الدالة (لا normalizeForCache مباشرةً) لكل من
 * `getCachedBook` و `cacheBook` للحفاظ على تطابق المفتاح بين القراءة والكتابة.
 */
export function canonicalizeForCache(text: string): string {
  return normalizeForCache(cleanSearchQuery(text));
}

/**
 * تنظيف استعلام البحث — يُزيل كلمات الحشو الشائعة
 * مثال: "تحميل رواية اسمها أرض زيكولا pdf مجانا" → "أرض زيكولا"
 *
 * ── leading-only vs anywhere ──
 * كلمات أوصاف الكتاب (كتاب/رواية/قصة/كتب/روايات/قصص…) و أفعال
 * النيّة (تحميل/تنزيل/قراءة/اقرأ/لخصلي/ملخص/اختصر…) **تُحذَف من
 * البداية فقط**، لأنها كثيراً ما تكون جزءاً من عناوين كتب حقيقية:
 *   - "كتاب الموتى"  vs  "الموتى" (روايتان مختلفتان)
 *   - "روايات نجيب محفوظ" — اليوزر يطلب الكاتب نفسه
 *   - "فن قراءة العقول" — "قراءة" جزء من العنوان
 *   - "حمل العنزة" — "حمل" جزء من العنوان
 *   - "اقرأ باسم ربك" — "اقرأ" جزء من العنوان
 *
 * أما تطبيقات/أوصاف عامّة (pdf/ebook/epub/free/مجاناً/كامل/نسخة)
 * فتُحذَف من أي موضع — رارة جداً وجودها في عناوين كتب حقيقية.
 *
 * هذه الدالة تُستَخدم في `canonicalizeForCache` (مفاتيح الكاش)
 * فلا بد أن تكون متّسقة مع `parseBookName` في `bookNameParser.ts`
 * وإلا قد يحدث cross-book cache pollution (مثل "كتاب الموتى" يُسجَّل
 * تحت نفس مفتاح "الموتى" → User B يحصل على كتاب User A بالغلط).
 */

// نفس قائمة LEADING_NOISE في `bookNameParser.ts` بالضبط — أي تحديث
// لازم يُطبَّق على المكانين معاً (DRY غير ممكن لأن bookNameParser
// يستورد text، فالعكس يخلق دورة استيراد).
const CLEAN_LEADING = /^(?:كتاب|رواية|روايه|قصة|قصه|كتيب|كتب|روايات|قصص|ديوان|تحميل|تنزيل|حمّل|نزّل|اقرأ|قراءة|لخصلي|لخّصلي|لخّص\s+لي|لخص\s+لي|لخّص|لخص|ملخص|ملخّص|مُلخّص|تلخيص|اختصرلي|اختصر\s+لي|اختصر|ابغي|ابغى|ابي|أبي|اريد|أريد|ممكن|اجيب|أجيب|اطلب|أطلب)\s+/i;

const CLEAN_ANYWHERE: string[] = [
  // كلمات تقنية — رارة في عناوين كتب
  "pdf", "PDF", "ebook", "epub",
  // أوصاف عامّة
  "مجانا", "مجانًا", "مجاناً", "مجاني", "مجانية", "free",
  "كامل", "كاملة", "كامله", "نسخة", "نسخه",
  "اسمه", "اسمها", "يسمى", "تسمى",
];

export function cleanSearchQuery(query: string): string {
  let cleaned = query.trim();

  // 1. حذف leading-noise iteratively — لاستيعاب prefix مزدوج
  //    "تحميل كتاب فن قراءة العقول" → "كتاب فن قراءة العقول" → "فن قراءة العقول"
  let prev: string;
  do {
    prev = cleaned;
    const withoutLeading = cleaned.replace(CLEAN_LEADING, "").trim();
    // لا نقطع لو ما بقي شيء ذو معنى — نتراجع
    if (withoutLeading.length >= 2) cleaned = withoutLeading;
    else break;
  } while (cleaned !== prev);

  // 2. حذف كلمات anywhere الآمنة من أي موضع
  for (const word of CLEAN_ANYWHERE) {
    const re = new RegExp(`(^|\\s)${word}(\\s|$)`, "gi");
    cleaned = cleaned.replace(re, " ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // لو التنظيف أفرغ الاستعلام — ارجع للأصلي
  if (cleaned.length < 2) return query.trim();

  return cleaned;
}

// ── Cairo timezone helpers ─────────────────────
// المستخدمون كلهم في توقيت القاهرة (Africa/Cairo، UTC+2 شتاءً، UTC+3
// صيفاً مع DST). كل اللميتات اليومية لازم تتجدد منتصف ليل القاهرة،
// مش UTC. بدون كده اليوزر الساعة 23:50 القاهرة بيشوف "متبقي 5 ساعات"
// بدل "10 دقايق"، وممكن ياخد 2× quota لو دخل بين 21:00–00:00 UTC.
//
// نستخدم Intl.DateTimeFormat بـ timeZone: "Africa/Cairo" لأنه DST-aware
// ويرجع الـ wall-clock الحقيقي. (Date object داخلياً UTC، فالحسابات
// بـ getUTC* أو setUTC* بتكون غلط للقاهرة).
const CAIRO_TZ = "Africa/Cairo";

const _cairoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAIRO_TZ,
  year:     "numeric",
  month:    "2-digit",
  day:      "2-digit",
});

const _cairoDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CAIRO_TZ,
  hour12:   false,
  year:     "numeric",
  month:    "2-digit",
  day:      "2-digit",
  hour:     "2-digit",
  minute:   "2-digit",
  second:   "2-digit",
});

/**
 * Returns the current Cairo-local date as `YYYY-MM-DD`. Drop-in
 * replacement for `new Date().toISOString().split("T")[0]` that
 * respects Africa/Cairo DST.
 */
export function cairoDateString(now: Date = new Date()): string {
  return _cairoDateFormatter.format(now);
}

/**
 * Milliseconds remaining until the next Cairo-local midnight.
 * DST-aware (the Cairo day boundary moves forward/back 1h on DST
 * change days; this routine handles that correctly because it parses
 * the actual wall-clock components in the target timezone).
 */
export function msUntilCairoMidnight(now: Date = new Date()): number {
  const parts = _cairoDateTimeFormatter.formatToParts(now);
  let h = 0, m = 0, s = 0;
  for (const p of parts) {
    if      (p.type === "hour")   h = parseInt(p.value, 10);
    else if (p.type === "minute") m = parseInt(p.value, 10);
    else if (p.type === "second") s = parseInt(p.value, 10);
  }
  // عدد الميلي ثانية اللي عدت من بداية اليوم القاهري
  const elapsedMs = ((h * 60 + m) * 60 + s) * 1000;
  // الباقي للوصول لمنتصف الليل القاهري (24h بالكامل)
  const remaining = 24 * 3600 * 1000 - elapsedMs;
  // safety: لو فيه DST shift خلّى الـ remaining < 0 (نادر)، رجّع ساعة كحد أدنى
  return remaining > 0 ? remaining : 3600 * 1000;
}

/**
 * وقت التجديد التالي — يُستخدم في رسائل الـ stats والـ daily limit
 * يُعيد مثلاً: "5 ساعة و23 دقيقة" أو "47 دقيقة" أو "دقائق قليلة"
 *
 * Anchored to Africa/Cairo midnight (not UTC) so the displayed
 * countdown matches the actual quota reset boundary that Egyptian
 * users experience.
 */
export function buildResetTime(): string {
  const diffMs = msUntilCairoMidnight();
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
