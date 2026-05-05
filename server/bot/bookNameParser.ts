import { L } from "./logger.js";

// ══════════════════════════════════════════════
// BOOK NAME PARSER — تنظيف وتحسين اسم الكتاب
// ══════════════════════════════════════════════

// JS regex's `\b` يعتمد على ASCII word characters فقط — لا يطابق
// حدود الكلمات العربية (لأن الحروف العربية ليست word chars في
// ASCII semantics). لذلك نبني الأنماط العربية بشكل (^|\s)…(\s|$)
// ليعمل التطابق فعلياً.
function arabicNoise(word: string): RegExp {
  return new RegExp(`(^|\\s)${word}(\\s|$)`, "gi");
}

// كلمات حشو عربية — تُحذف من أي موضع داخل اسم الكتاب
// مهم: لا تضع كلمات قد تكون جزءاً من عنوان كتاب حقيقي هنا
// (مثل "تحميل"، "اقرأ"، "قراءة"، "حمل"). تلك تُعالَج عبر
// LEADING_NOISE (أنماط مرتبطة ببداية النص فقط) — وإلا نمسحها
// من العنوان نفسه. مثال: "فن قراءة العقول" كان يُحوَّل إلى
// "فن العقول" قبل هذا الإصلاح.
const ARABIC_NOISE_WORDS: string[] = [
  // نيّة التلخيص — يكتبها المستخدم قبل اسم الكتاب لكن
  // البوت يتعامل معها كزر "📘 ملخص الكتاب" بعد التحميل،
  // فلا داعي لتسرّبها إلى اسم الكتاب أو caption أو filename.
  // هذه آمن إزالتها من أي موضع (لا تظهر في عناوين كتب).
  "لخصلي", "لخّصلي", "لخّص لي", "لخص لي", "لخّص", "لخص",
  "تلخيص", "ملخص", "مُلخّص", "ملخّص",
  "اختصرلي", "اختصر لي", "اختصر",
  // أوصاف — آمنة الإزالة
  "مجاني", "مجاناً", "مجانًا", "مجانية",
  "كامل", "كاملة", "كامله",
  "مترجم", "ترجمة",
];

// أنماط تُزيل noise من اسم الكتاب قبل البحث
const NOISE_PATTERNS: RegExp[] = [
  ...ARABIC_NOISE_WORDS.map(arabicNoise),
  // الإنجليزية: \b يعمل بشكل صحيح لأنها ASCII
  /\bdownload\b/gi,
  /\bpdf\b/gi,
  /\bebook\b/gi,
  /\bepub\b/gi,
  /\bfree\b/gi,
];

// أنماط الكلمات التي تسبق الاسم الحقيقي
// تشمل: نوع الكتاب (كتاب/رواية/...) + نيّة التلخيص + نيّة
// التحميل/القراءة. الـ loop في parseBookName يُزيل أكثر من
// prefix على التوالي مثل "تحميل كتاب فن قراءة العقول" →
// "كتاب فن قراءة العقول" → "فن قراءة العقول".
//
// لازم تكون هذه الكلمات leading-only لأن أي حذف من الوسط
// قد يُتلف عناوين كتب فيها هذه الكلمات ("فن قراءة العقول"،
// "حمل العنزة"، "اقرأ باسم ربك"، إلخ).
// ملاحظة: "حمل" و"نزل" بلا شدة لم يُدرَجا (ambiguous مع نوع
// كتاب: "حمل العنزة"، "نزل القرآن"). نكتفي بالأشكال الواضحة
// (تحميل، تنزيل، حمّل، نزّل) للنية.
const LEADING_NOISE = /^(?:كتاب|رواية|قصة|ديوان|كتب|روايات|تحميل|تنزيل|حمّل|نزّل|اقرأ|قراءة|لخصلي|لخّصلي|لخّص\s+لي|لخص\s+لي|لخّص|لخص|ملخص|ملخّص|مُلخّص|تلخيص|اختصرلي|اختصر\s+لي|اختصر)\s+/i;

// ── Summary-intent words ───────────────────────────────────
// نفصل هذه عن باقي الـ noise words لأن parseBookName يُجرّدها من
// اسم الكتاب (لازم — كي لا تظهر في caption/filename)، لكننا
// نريد كَشْف وجودها على رسالة المستخدم *قبل* التجريد كي يُصدر
// البوت ملخصًا تلقائيًا بعد الإرسال (PR G — auto-summary trigger).
const SUMMARY_INTENT_WORDS: string[] = [
  "لخصلي", "لخّصلي", "لخّص لي", "لخص لي", "لخّص", "لخص",
  "تلخيص", "ملخص", "مُلخّص", "ملخّص",
  "اختصرلي", "اختصر لي", "اختصر",
];

// نستخدم flag `i` فقط (بدون `g`) كي يكون .test() مستقلاً عن
// lastIndex الـ stateful — وليس هناك حاجة للـ global match هنا.
const SUMMARY_INTENT_PATTERNS: RegExp[] = SUMMARY_INTENT_WORDS.map(
  (w) => new RegExp(`(^|\\s)${w}(\\s|$)`, "i"),
);

/**
 * يكشف نية المستخدم لطلب تلخيص الكتاب من الرسالة الخام (قبل
 * parseBookName) — مثلاً: "لخصلي كتاب أرض زيكولا" أو "ملخص فن
 * قراءة العقول".
 *
 * يستخدمه bookRequest عبر QueueJob.wantsSummary لتشغيل تدفّق
 * الملخص تلقائيًا بعد الإرسال الناجح بدلاً من انتظار ضغطة زر.
 */
export function detectSummaryIntent(rawBookName: string): boolean {
  if (!rawBookName) return false;
  const text = rawBookName.trim();
  if (!text) return false;
  for (const pattern of SUMMARY_INTENT_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * يُنظّف اسم الكتاب ويُحسّن صياغته للبحث
 *
 * الخطوات:
 *  1. حذف الـ noise words (تحميل، pdf، مجاني، لخصلي، ملخص…)
 *  2. حذف كلمات الـ prefix الزائدة (كتاب، رواية، نيّة التلخيص…)
 *     في loop — لاستيعاب prefix مزدوج مثل "لخصلي كتاب X"
 *  3. تنظيف المسافات المتعددة
 *  4. يُبقي الاسم كما هو إذا لم يتغير شيء مهم
 */
export async function parseBookName(bookName: string): Promise<string> {
  if (!bookName.trim()) return bookName;

  let cleaned = bookName.trim();

  // 1. حذف noise words في أي موضع
  // نستبدل بمسافة بدل سلسلة فارغة حتى لا تلتصق كلمتان
  // (مثلاً "X ملخص Y" → "X  Y" ثم تُختصر لـ "X Y" في الخطوة 3)
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ").trim();
  }

  // 2. حذف كلمات الـ prefix الزائدة (فقط من البداية، iteratively)
  // مثال: "لخصلي كتاب صديقي الملحد" → "كتاب صديقي الملحد" → "صديقي الملحد"
  // لا نحذف الـ prefix إذا ما بقي شيء ذو معنى بعده
  let prev: string;
  do {
    prev = cleaned;
    const withoutLeading = cleaned.replace(LEADING_NOISE, "").trim();
    if (withoutLeading.length >= 3) {
      cleaned = withoutLeading;
    } else {
      break;
    }
  } while (cleaned !== prev);

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
