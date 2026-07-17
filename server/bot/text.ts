// ══════════════════════════════════════════════
// TEXT UTILITIES — رفيق
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
    // FIX-DELIVERY: treat _ - + / as word separators (archive/search titles)
    .replace(/[_+\-–—./\\|]+/g, " ")
    .replace(/\s+/g, " ")
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

const _cairoHourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CAIRO_TZ,
  hour:     "2-digit",
  hour12:   false,
});

/**
 * Returns the current Cairo-local hour as an integer 0-23. DST-aware.
 * Used by the daily-digest scheduler in alertWatcher to fire once per
 * day at a configurable Cairo hour.
 */
export function cairoHourNumber(now: Date = new Date()): number {
  // en-GB hour-only formatter returns the 2-digit hour ("00".."23")
  // even with hour12=false (Intl quirk: "24:35" → "00:35").
  const hh = _cairoHourFormatter.format(now);
  const n = parseInt(hh, 10);
  return Number.isFinite(n) ? n : 0;
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

// ══════════════════════════════════════════════
// LEADERBOARD helpers — تستخدمها analytics.ts و weekly.ts
// ══════════════════════════════════════════════

/**
 * مفتاح كنسي لاسم الكتاب في الـ leaderboard (`stats:top_books*`).
 *
 * يدمج 4 خطوات على رأس `canonicalizeForCache`:
 *  1. canonicalizeForCache (تطبيع عربي + تنظيف noise + lowercase)
 *  2. حذف علامات ترقيم نهائية (',", . إلخ) — كانت تتسرّب من الـ
 *     copy/paste وتخلي "X" و "X." entries مختلفة
 *  3. حذف فواصل غير مفيدة في البداية/النهاية ("ـ", "—", "-")
 *  4. اقتصاص لـ 100 حرف (نفس حد التخزين القديم)
 *
 * الفائدة: "هكذا تتعافي" و "هكذا تتعافى" → نفس المفتاح. كذلك
 * "أرض زيكولا" و "ارض زيكولا" و "ارض زيكولا pdf" — كله مفتاح واحد.
 *
 * ملاحظة: ده ما بيدمجش "هكذا تتعافي" مع "هكذا تتعافي عندما تكون
 * مستعدا تأليف بريانا وايست" (يوزر ضاف اسم المؤلف). الحل لده هو
 * استخدام `cached.bookName` (العنوان الكنسي اللي البوت سلّمه فعلاً)
 * بدل الـ user query — شاهد `trackDownload` في analytics.ts.
 */
export function canonicalBookKey(text: string): string {
  if (!text) return "";
  let key = canonicalizeForCache(text);
  // علامات ترقيم لاصقة في الآخر/البداية
  key = key.replace(/^[\s.,;:!?'"`«»—–\-ـ]+|[\s.,;:!?'"`«»—–\-ـ]+$/g, "");
  // مسافات داخلية مزدوجة (لو cleanSearchQuery خلّف فجوات)
  key = key.replace(/\s+/g, " ").trim();
  if (key.length > 100) key = key.slice(0, 100).trim();
  return key;
}

/**
 * عام-أسبوع كـ "YYYY-Www" بتوقيت القاهرة.
 * بيستخدمه الـ leaderboard للبكتنق الأسبوعي.
 *
 * ISO week (Mon-Sun)، مع ضبط أن الأسبوع الذي يحتوي على
 * 4 يناير ينتمي للسنة الجديدة بحسب ISO 8601.
 * نحسبه على Cairo midnight: نأخذ الـ Cairo date string ثم نحوّله
 * لـ Date في UTC (آمن لأن الـ ISO-week حسبة منفصلة).
 */
export function isoWeekKey(now: Date = new Date()): string {
  // نأخذ تاريخ القاهرة YYYY-MM-DD ونعيد بناء Date منه — فعلياً ده
  // بيخلي الحسبة تتعامل مع "اليوم القاهري" كـ unit وليس مع UTC.
  const cairoYmd = cairoDateString(now); // YYYY-MM-DD
  const [yStr, mStr, dStr] = cairoYmd.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const d = parseInt(dStr, 10);
  // ISO-week algo (يوم الخميس الأنكور)
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;     // Mon=1..Sun=7
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum); // الخميس في نفس الأسبوع
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    (((dt.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7
  );
  const ww = weekNum < 10 ? `0${weekNum}` : `${weekNum}`;
  return `${dt.getUTCFullYear()}-W${ww}`;
}

/**
 * قائمة كلمات شكوى — لو ظهرت في query فمعناه إن المستخدم بيشتكي
 * إن البوت سلّم له ملف غلط، مش بيدوّر على كتاب بهذا الاسم.
 * نتجاهلها من الـ leaderboard.
 *
 * البوت بيخزّن الـ query لما يلاقي ملف ويسلّمه — فلو المستخدم كتب
 * "هذا ليس الكتاب المطلوب" والبوت سلّم له حاجة، ده يدخل الـ
 * leaderboard كأنه كتاب اسمه "هذا ليس الكتاب المطلوب". نمنعه هنا.
 */
const COMPLAINT_PATTERNS: RegExp[] = [
  /ليس\s+الكتاب\s+المطلوب/i,
  /مش\s+(?:هو|الكتاب|دا|دي|ده|اللي)/i,
  /غلط\s+الكتاب|كتاب\s+غلط/i,
  /خطأ|خاطئ/i,
  /\bwrong\s+book\b/i,
  /\bnot\s+the\s+book\b/i,
];

export function isComplaintQuery(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  for (const re of COMPLAINT_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

/**
 * اقتصاص ذكي للنصوص الطويلة عند حدود الكلمات.
 *
 * المشكلة قبل: `text.slice(0, 55)` كان يقطع وسط الكلمة فيظهر مثلاً
 * "Full boo" بدل "Full book".
 *
 * الحل: نقطع عند آخر مسافة ≤ maxLen، ولو ما لقيناش مسافة قريبة
 * كفاية (≥ 80% من maxLen) نرجع لقص حرفي + "…".
 */
export function truncateAtWord(text: string, maxLen = 80): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;

  const sliced = text.slice(0, maxLen);
  // آخر مسافة في النص المقصوص
  const lastSpace = sliced.lastIndexOf(" ");
  // لو المسافة قريبة كفاية من النهاية (≥ 80% maxLen) نقص عندها
  if (lastSpace > 0 && lastSpace >= Math.floor(maxLen * 0.8)) {
    return `${sliced.slice(0, lastSpace).trim()}…`;
  }
  // قص حرفي + ellipsis (نشيل آخر حرف عشان الـ … يدخل)
  return `${sliced.slice(0, maxLen - 1).trim()}…`;
}

// ── Script detection helpers ──────────────────────────────────────────
//
// Used by the title-gate to recognise *cross-language* candidates: e.g.
// the user types Arabic "العادات الذرية" and the only available PDF is
// the English original "Atomic habits (PDFDrive).pdf". Token-overlap
// scoring returns 0 for such pairs (zero shared characters, zero shared
// transliterated bigrams) — so the existing `urlFilenameRelevance`
// gate would block direct-send AND blow trust ceilings even for
// search-engine-confident matches.
//
// Strategy: detect the script of each side (Arabic vs Latin), and when
// they differ on a search-engine-trusted candidate, downstream code
// (pdfValidator) treats that as "this is a translation match candidate"
// rather than "this is a wrong book". The Mistral prompt also receives
// an explicit translation hint so it can stop hedging on bestsellers.
//
// We classify a string by counting Arabic-block chars vs ASCII letters.
// Whichever is dominant wins; ties or empty strings → "unknown".

const ARABIC_BLOCK_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_LETTER_RE = /[A-Za-z]/g;

export type Script = "arabic" | "latin" | "unknown";

export function detectScript(s: string): Script {
  if (!s) return "unknown";
  const arabicCount = (s.match(ARABIC_BLOCK_RE) || []).length;
  const latinCount  = (s.match(LATIN_LETTER_RE) || []).length;
  if (arabicCount === 0 && latinCount === 0) return "unknown";
  if (arabicCount > latinCount) return "arabic";
  if (latinCount > arabicCount) return "latin";
  return "unknown";  // strict tie — don't claim either
}

// True iff the two inputs are written in different alphabets (e.g. Arabic
// query vs Latin filename). Used to recognise "translation pair" cases
// where filename-token overlap inherently can't work.
//
// Returns false when either side is "unknown" — we only claim a cross-
// language case when we're confident about both scripts.
export function isCrossLanguagePair(a: string, b: string): boolean {
  const sa = detectScript(a);
  const sb = detectScript(b);
  if (sa === "unknown" || sb === "unknown") return false;
  return sa !== sb;
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
