import * as fsPromises from "fs/promises";
import { createHash }  from "crypto";
import { L } from "./logger.js";
import { normalizeArabic, urlFilenameRelevance } from "./text.js";
import { redis } from "./redis.js";
import {
  MISTRAL_API_KEY,
  PDF_VALIDATE_ACCEPT_THRESHOLD,
  PDF_VALIDATE_CONFIRM_THRESHOLD,
  PDF_VALIDATE_REJECT_THRESHOLD,
  TIMEOUT_MISTRAL,
  TRUSTED_PDF_DOMAINS,
  FILENAME_TRUSTED_PDF_DOMAINS,
  MISTRAL_BYPASS_FILENAME_THRESHOLD,
} from "./config.js";

// domains موثوقة — نتخطى الـ validator ونقبل مباشرة
function isTrustedDomain(url: string): boolean {
  return TRUSTED_PDF_DOMAINS.some(d => url.includes(d));
}

// Curated content libraries — trust filename match as ground truth.
// Used to short-circuit Mistral when the filename score is high enough,
// avoiding paid API calls on PDFs that the URL itself already identifies.
function isFilenameTrustedDomain(url: string): boolean {
  return FILENAME_TRUSTED_PDF_DOMAINS.some(d => url.includes(d));
}

// True when the URL's filename is opaque — carries zero title signal.
// Opaque shapes:
//   1. digit-only id      (Hindawi `/books/14168605.pdf`)
//   2. very-short ASCII   (`AB.pdf`, `xz.pdf`)
//   3. random alnum no-sep up to 8 chars (`xK9mP2.pdf`)
//   4. mixed alpha+digit but real letters < 4 (`TT-79.pdf`, `AB-3.pdf`)
// On hosts whose search ranker we can't trust, these URLs let wrong-book
// PDFs slip into the cache because no signal can distinguish them by
// URL alone. Exported so the cache writer (`bookRequest.ts`) refuses
// to persist file_ids tied to opaque URLs.
//
// FIX-WRONG-FILE (BUG-4): the original function only caught (1) so
// shapes (2)-(4) leaked into the cache (production audit 2026-05-04
// found `bookleaks.com/files/server/53.pdf`, `book-shadow.com/.../1094.pdf`
// caching candidates whose filenames carry no book identity). Now mirrors
// the richer `isMeaninglessFilename` heuristic used inside the validator.
export function hasUninformativeFilename(url: string): boolean {
  try {
    const filename = decodeURIComponent(
      new URL(url).pathname.split("/").pop()?.split("?")[0] || "",
    ).replace(/\.pdf$/i, "").trim();
    if (filename.length === 0) return false;
    // (1) digit-only id
    if (/^\d+$/.test(filename)) return true;
    // (2) very-short ASCII (3 chars or less, alnum/dash/underscore)
    if (filename.length <= 3 && /^[a-zA-Z0-9_-]+$/.test(filename)) return true;
    const hasAlpha = /[a-zA-Z\u0600-\u06FF]/.test(filename);
    const hasDigit = /\d/.test(filename);
    const hasSep   = /[_\-\s]/.test(filename);
    // (3) random alnum no-separator ≤ 8 chars (e.g. xK9mP2)
    if (hasAlpha && hasDigit && filename.length <= 8 && !hasSep && /^[a-zA-Z0-9]+$/.test(filename)) {
      return true;
    }
    // (4) alpha letters < 4 with digits → TT-79, AB-3
    const alphaOnly = filename.replace(/[^a-zA-Z\u0600-\u06FF]/g, "");
    if (hasAlpha && hasDigit && alphaOnly.length < 4) return true;
    return false;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
//  PDF CONTENT VALIDATOR — Anti False-Positive Layer
//
//  المنطق (3-tier):
//    1. استخرج /Title من metadata الـ PDF (الإشارة الموثوقة الوحيدة)
//    2. score واضح على metaTitle → قبول/رفض تلقائي (يوفر API call)
//    3. metaTitle غائب أو score غامض → Mistral يحكم
//
//  لماذا metadata فقط وليس raw text؟
//    معظم ملفات PDF العربية تستخدم CIDFont/Type0 بـ custom encoding.
//    الـ bytes (0xD8-0xDB) في stream الـ PDF هي glyph IDs لا Unicode.
//    الاستثناء: /Title في الـ Info dictionary — دائماً نص حقيقي قابل للقراءة.
//
//  Telemetry (Redis counters):
//    tel:pdf:accepted_match    → candidate_accepted_title_match
//    tel:pdf:rejected_mismatch → candidate_rejected_title_mismatch
//    tel:pdf:mistral_used      → mistral_rerank_used
//    tel:pdf:extract_failed    → لا metadata → Mistral أو fail-open
// ══════════════════════════════════════════════════════════════

const TEL_ACCEPTED       = "tel:pdf:accepted_match";
const TEL_REJECTED       = "tel:pdf:rejected_mismatch";
const TEL_MISTRAL        = "tel:pdf:mistral_used";
const TEL_EXTRACT_FAILED = "tel:pdf:extract_failed";

// Mistral result cache TTL — ساعتان
const MISTRAL_CACHE_TTL_SEC = 2 * 3600;

// ══════════════════════════════════════════════
//  Arabic stop-words — مُخزَّنة بشكلها المُعيَّر
//
//  BUG FIX (مؤكَّد بالاختبارات):
//  كانت القائمة تحتوي الأشكال الأصلية ("على","إلى","أو")
//  لكن wordOverlapScore تُقارِن بعد normalizeArabic():
//    "على"  → "علي"   ← Miss
//    "إلى"  → "الي"   ← Miss
//    "أو"   → "او"    ← Miss (كانت "او" موجودة فنجت)
//    "أي"   → "اي"    ← Miss
//  الحل: نخزّن الشكل المُعيَّر مباشرةً لضمان المطابقة دائماً.
//  تحقق: node -e "...normalizeArabic('على')..." يُعطي "علي"
// ══════════════════════════════════════════════
const ARABIC_STOPWORDS = new Set<string>([
  // حروف الجر والعطف (بعد التعيير)
  "علي",   // على
  "في",
  "من",
  "الي",   // إلى / الى
  "عن",
  "مع",
  "او",    // أو / او
  "لا",
  "بل",
  "ثم",
  "اي",    // أي / اي
  "حتي",   // حتى
  "إذا",
  "إذ",
  "لم",
  "لن",
  "ليس",
  // ضمائر
  "هو",
  "هي",
  "هم",
  "انت",
  "انا",
  "نحن",
  "هما",
  "انتم",
  // كلمات وظيفية شائعة
  "كل",
  "بين",
  "عند",
  "لقد",
  "قد",
  "كان",
  "كما",
  "غير",
  "حول",
  "خلال",
  "بعد",
  "قبل",
  "عبر",
  "بدون",
  "حيث",
  // أسماء إشارة (بعد التعيير — ة→ه)
  "هذا",
  "هذه",
  "هؤلاء",
  "ذلك",
  "تلك",
  "الذي",
  "التي",
  // TEST-FIND-1 FIX: كلمات بحثية وظيفية عالية التكرار في عناوين الكتب
  // هذه الكلمات تظهر في آلاف العناوين المختلفة → تُحدث ضوضاء في حساب score
  // مثال: "فهرس الكتب الإسلامية" يحصل على تشابه عالٍ مع "مئة عام من العزلة"
  // بسبب كلمة "الكتب" المشتركة — وهي لا معنى لها في المقارنة.
  // بعد normalizeArabic: رواية→روايه، قصة→قصه، كتاب/كتب بدون تغيير
  "كتاب",
  "كتب",
  "الكتاب",
  "الكتب",
  "روايه",    // رواية
  "روايات",
  "قصه",      // قصة
  "قصص",
  "مجله",     // مجلة
  "مجلد",
  "جزء",
  "الجزء",
  "طبعه",     // طبعة
  "شرح",
  "ديوان",
  // FIX v29: كلمات إسلامية/دينية شائعة جداً في عناوين الكتب العربية
  // تظهر في آلاف الكتب المختلفة → بلا قيمة تمييزية
  "تفسير",
  "الاسلام",   // الإسلام
  "الاسلامي",  // الإسلامي
  "الاسلاميه", // الإسلامية
  "المسلمين",
  "الفقه",
  "العلم",
  "العلوم",
  "الدين",
  "الديني",
  "السيره",    // السيرة
  "الحديث",
  "القران",    // القرآن
  "السنه",     // السنة
  "المسلم",
  "الاسلامية",
  "العربي",
  "العربيه",   // العربية
  "العربيات",
  "المعاصر",
  "الحديثه",   // الحديثة
  "دراسه",     // دراسة
  "دراسات",
  "بحث",
  "ابحاث",     // أبحاث
  "موسوعه",    // موسوعة
  "المقدمه",   // المقدمة
  "الخلاصه",   // الخلاصة
  "ملخص",
  // FIX v29: English stopwords لملفات PDF ذات عناوين إنجليزية (كتب مترجمة)
  // تُقابَل مع bookName العربي عبر Mistral (crossLang=true) لكن في حالات
  // كتابة اسم الكتاب بالإنجليزية في الـ query → score مباشر
  "the",
  "and",
  "for",
  "pdf",
  "book",
  "vol",
  "volume",
  "part",
  "edition",
]);

export type PdfValidationEvent =
  | "candidate_accepted_title_match"
  | "candidate_rejected_title_mismatch"
  | "trusted_domain_title_mismatch"
  | "mistral_rerank_used"
  | "no_metadata_accepted"
  | "empty_file"
  | "file_too_small"
  | "not_pdf_magic";

export interface PdfValidationResult {
  accepted:    boolean;
  score:       number;
  event:       PdfValidationEvent;
  mistralUsed: boolean;
  metaTitle:   string;
}

// ══════════════════════════════════════════════
//  STEP 0: tryUtf8 — Smart UTF-8 auto-decode
// ══════════════════════════════════════════════

/**
 * يُحاوِل تفسير string ثنائي (latin1) كـ UTF-8.
 *
 * السياق: buf.toString("binary") يُنتج latin1 encoding.
 * عند مقارنة النص بالعناوين العربية نحتاج UTF-8 الصحيح.
 *
 * الخوارزمية:
 *   1. حوِّل binary string → Buffer (يُعيد bytes الأصلية)
 *   2. حوِّل Buffer → UTF-8 string
 *   3. إذا ظهر U+FFFD (replacement char) → الأصل كان Latin-1 لا UTF-8 → أبقِ الأصل
 *
 * المثال:
 *   "تفسير" كـ UTF-8 bytes → binary string "ØªÙØ³ÙØ±"
 *   tryUtf8("ØªÙØ³ÙØ±") → "تفسير" ✅
 *
 *   "Mémoires" كـ Latin-1 (0xE9 لـ é) → tryUtf8 يرجع "Mémoires" ✅
 *   (لأن 0xE9 وحده غير صالح كـ UTF-8 → U+FFFD يظهر → نحتفظ بالأصل)
 */
function tryUtf8(binaryStr: string): string {
  if (!binaryStr) return binaryStr;
  try {
    const decoded = Buffer.from(binaryStr, "binary").toString("utf8");
    return decoded.includes("\uFFFD") ? binaryStr : decoded;
  } catch {
    return binaryStr;
  }
}

// ══════════════════════════════════════════════
//  STEP 1: extractMetaTitle — PDF /Title فقط
// ══════════════════════════════════════════════

/**
 * يستخرج /Title من PDF Info dictionary أو XMP metadata.
 *
 * يدعم ثلاثة encodings حقيقية كما تصدرها المولِّدات الشائعة:
 *  A. UTF-16BE مع BOM (0xFE 0xFF) — Word, Acrobat, كثير من مولِّدات PDF العربية
 *  B. UTF-8 bytes بدون BOM   — LibreOffice, reportlab, wkhtmltopdf
 *  C. Latin-1 + Octal escapes — Ghostscript, PS-to-PDF قديم
 *
 * الـ regex يسمح بأقواس داخل العنوان عبر ((?:[^\\)]|\\.)*):
 *  — يتجنب كسر العناوين مثل "المرأة (دراسة)" المُخزَّنة كـ (المرأة \(دراسة\))
 */
function extractMetaTitle(buf: Buffer): string {
  const raw = buf.toString("binary"); // latin1 — يحافظ على bytes 1:1

  // ── Pattern 1: /Title (PDF literal string) ──────────────────
  const literalMatch = raw.match(/\/Title\s*\(((?:[^\\)]|\\.){1,500})\)/i);
  if (literalMatch) {
    const str = literalMatch[1];

    // A. UTF-16BE BOM: 0xFE 0xFF يسبق كل نص
    if (str.charCodeAt(0) === 0xfe && str.charCodeAt(1) === 0xff) {
      try {
        const chars: string[] = [];
        for (let i = 2; i + 1 < str.length; i += 2) {
          const cp = (str.charCodeAt(i) << 8) | str.charCodeAt(i + 1);
          if (cp === 0) break;
          chars.push(String.fromCodePoint(cp));
        }
        const title = chars.join("").trim();
        if (title.length > 1) return title;
      } catch { /* fall through */ }
    }

    // B/C. Octal escapes → bytes → tryUtf8 للكشف التلقائي
    const decoded = str
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\[nrt\\()]/g, " ")
      .trim();
    const title = tryUtf8(decoded);
    if (title.length > 1) return title;
  }

  // ── Pattern 2: XMP metadata <dc:title> ──────────────────────
  // {0,600} يستوعب namespace declarations الطويلة الموجودة بين <dc:title> و<rdf:li>
  const xmpMatch = raw.match(/<dc:title>[\s\S]{0,600}?<rdf:li[^>]*>([^<]{2,300})<\/rdf:li>/i);
  if (xmpMatch) {
    const title = tryUtf8(xmpMatch[1]).trim();
    if (title.length > 1) return title;
  }

  return "";
}

// ══════════════════════════════════════════════
//  STEP 2: wordOverlapScore
// ══════════════════════════════════════════════

/**
 * يُزيل البادئات العربية المتصلة قبل مقارنة الكلمات.
 *
 * المشكلة بدونها:
 *   اسم الكتاب: "السنة والبدعة" → needleWords: ["السنه", "والبدعه"]
 *   PDF title:  "السنة والبدعة في الإسلام" → haystackWords: ["السنه", "والبدعه", ...]
 *   ← هنا لا مشكلة لأن البادئة "و" موجودة في الاثنين.
 *
 *   لكن: اسم الكتاب "التوحيد والعقيدة" ← needle: ["التوحيد", "والعقيده"]
 *   PDF title:  "التوحيد والعقيدة السلفية" ← haystack: ["التوحيد", "والعقيده", ...]
 *   ← موجودة في الاثنين. لكن لو كان haystack: "عقيدة التوحيد":
 *   ← "والعقيده" ≠ "عقيده" → Miss — رغم أن المعنى متطابق.
 *
 * البادئات المدعومة (مرتبة من الأطول للأقصر لمنع التطابق الجزئي):
 *   وال، بال، لل، كال، فال — ثم — و، ب، ل، ك، ف
 */
function stripArabicPrefix(word: string): string {
  const prefixRe = /^(وال|بال|لل|كال|فال|وب|وك|ول|وف|فب|و|ب|ل|ك|ف)/;
  const m = prefixRe.exec(word);
  // الكلمة الناتجة يجب أن تبقى ذات معنى (3+ أحرف) وإلا نبقي الكلمة كما هي
  if (m && word.length - m[1].length >= 3) {
    return word.slice(m[1].length);
  }
  return word;
}

/**
 * كم نسبة كلمات bookName موجودة كاملةً في metaTitle؟
 *
 * الخصائص:
 *  - تُعيَّر الكلمات قبل المقارنة (همزات، تاء مربوطة، تشكيل)
 *  - مطابقة كلمة كاملة لا substring (Set lookup لا includes)
 *  - يدعم البادئات العربية المتصلة: "والبدعة" تتطابق مع "البدعة"
 *  - ARABIC_STOPWORDS تُستبعَد (كلمات وظيفية شائعة بلا قيمة تمييزية)
 *  - عناوين ≥ 3 كلمات تحتاج كلمتان متطابقتان للحصول على score > 0
 *    (يمنع كلمة شائعة واحدة من إعطاء 33%+ زوراً)
 */
function wordOverlapScore(bookName: string, metaTitle: string): number {
  // needleWords: كلمات bookName بعد تعيير + حذف القصيرة + حذف الـ stopwords
  const needleWords = normalizeArabic(bookName)
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ARABIC_STOPWORDS.has(w));

  if (needleWords.length === 0) return 0;

  // haystackSet: كلمات metaTitle كـ Set للبحث O(1)
  // FIX: حذف علامات الترقيم من كلمات haystack قبل البحث
  // المشكلة: "العادة:" ≠ "العادة" → miss رغم أن الكلمة صحيحة
  // شائع جداً في عناوين PDF العربية: "قوة العادة: لماذا..."
  const stripPunct = (w: string) => w.replace(/[،,.:;!؟?()[\]{}'"«»\-–—/\\]/g, "");
  const haystackWords = normalizeArabic(metaTitle).split(/\s+/)
    .filter((w) => w.length >= 1)
    .map(stripPunct)
    .filter((w) => w.length >= 1);
  const haystackSet = new Set(haystackWords);

  // haystackStrippedSet — يجرد البادئات الكاملة من كلمات haystack
  const haystackStrippedSet = new Set(haystackWords.map(stripArabicPrefix));

  // BUG FIX v26-WORD-1: haystackConjSet — يجرد حروف العطف الأحادية فقط (و،ب،ل،ك،ف)
  //   دون لمس "ال" التعريف.
  //   المشكلة: stripArabicPrefix("والبدعه") يجرد "وال" دفعة واحدة → "بدعه" لا "البدعه"
  //   مثال: needle="البدعه" ، haystack has "والبدعه"
  //     haystackStrippedSet has "بدعه" (وال جُرّد) لا "البدعه" → miss
  //   الحل: haystackConjSet يجرد "و" فقط → "البدعه" → needle يجدها ✓
  function stripConjOnly(word: string): string {
    const m = /^([وبلكف])/.exec(word);
    return (m && word.length - 1 >= 3) ? word.slice(1) : word;
  }
  const haystackConjSet = new Set(haystackWords.map(stripConjOnly));

  // BUG FIX v26-WORD-2: فحص "ال" + needle في haystackSet
  //   المشكلة: needle="فقه" ، haystack has "الفقه" → لا تطابق رغم أنهما نفس الكلمة
  //   لأن "ال" ليست في قائمة البادئات → stripArabicPrefix("الفقه")="الفقه" (بلا تغيير)
  //   الحل: نتحقق من "ال" + needle مباشرةً في haystackSet

  const matched = needleWords.filter((w) => {
    if (haystackSet.has(w)) return true;

    const strippedNeedle = stripArabicPrefix(w);

    // needle مجردة → في haystack
    if (strippedNeedle !== w && haystackSet.has(strippedNeedle)) return true;

    // needle → في haystack بعد جرد البادئات الكاملة
    if (haystackStrippedSet.has(w)) return true;
    if (strippedNeedle !== w && haystackStrippedSet.has(strippedNeedle)) return true;

    // v26-WORD-1: needle → في haystack بعد جرد حرف عطف أحادي
    if (haystackConjSet.has(w)) return true;
    if (strippedNeedle !== w && haystackConjSet.has(strippedNeedle)) return true;

    // v26-WORD-2: "ال" + needle → في haystack (فقه ↔ الفقه)
    if (haystackSet.has("ال" + w)) return true;
    if (strippedNeedle !== w && haystackSet.has("ال" + strippedNeedle)) return true;

    return false;
  });

  const ratio   = matched.length / needleWords.length;

  // BUG FIX v27-BIDIR: الـ score الأحادي الاتجاه يسمح لعنوان قصير جداً (1-2 كلمة)
  // بمطابقة أي PDF يحتوي تلك الكلمة — حتى لو عنوان الـ PDF مختلف تماماً.
  //
  // مثال بدون الإصلاح:
  //   needle = "التوحيد" (1 كلمة)
  //   PDF    = "الجامع في علوم التوحيد والسنة" (5 كلمات دالة)
  //   → ratio = 1/1 = 1.0 → ACCEPTED ❌ (كتاب مختلف!)
  //
  // الحل: لو الـ needle قصير (≤ 2 كلمة) وعنوان الـ PDF أطول منه بأكثر من 2.5x
  // → هذه منطقة غامضة → أرجع 0.25 (بين REJECT=0.12 وACCEPT=0.40) → Mistral يحكم.
  //
  // لماذا 2.5x وليس أقل؟
  //   "صحيح البخاري" ← "صحيح البخاري الجامع" (3 كلمات دالة < 2*2.5=5) → لا penalty ✓
  //   "الرحيق المختوم" ← "الرحيق المختوم كاملاً" (3 < 5) → لا penalty ✓
  //   "التوحيد" ← "الجامع في علوم التوحيد" (3 > 1*2.5=2.5) → Mistral ✓
  //
  // ملاحظة: نطبّق الـ guard فقط لو matched.length === needleWords.length (تطابق كامل)
  // لأن تطابق جزئي سيتعامل معه الكود أدناه بشكل صحيح.
  if (needleWords.length <= 2 && matched.length === needleWords.length) {
    const haystackSigWords = normalizeArabic(metaTitle)
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !ARABIC_STOPWORDS.has(w));
    if (haystackSigWords.length > needleWords.length * 2.5) {
      // المنطقة الغامضة — Mistral يحكم
      return 0.25;
    }
  }

  // BUG FIX (BUG-REVIEW-2): الكود القديم كان يُعيد 0 دائماً عند needleWords.length >= 2
  // وmatched.length < 2، ثم الكود الخارجي يرفضه مباشرة لو كان العنوان واضحاً.
  // هذا يُفوّت حالات مثل:
  //   الكتاب: "الفقه الإسلامي" — PDF: "الفقه الإسلامي وأدلته" (الكلمتان موجودتان)
  //   لكن بسبب ترميز مختلف أو بادئة، قد يتطابق "الفقه" فقط → 1/2 → كان يُرفض.
  //
  // الحل الجديد:
  //   - 0 كلمة متطابقة → score = 0 → قد يُرفض لو العنوان واضح (صحيح)
  //   - 1 كلمة متطابقة → score = 0.20 (منطقة غامضة) → يذهب لـ Mistral
  //   - 2+ كلمة متطابقة → نسبة طبيعية (صحيح)
  //
  // لماذا 0.20 وليس ratio عادي (0.50)؟
  //   ratio=0.50 > ACCEPT_THRESHOLD (0.40) → قبول تلقائي بدون Mistral
  //   هذا خطر: "العقيدة الواسطية" ← 1 كلمة تطابق في "العقيدة السفارينية" → قبول خاطئ!
  //   0.20 يقع بين REJECT_THRESHOLD (0.12) وACCEPT_THRESHOLD (0.40) → Mistral يحكم.
  if (needleWords.length >= 2 && matched.length < 2) {
    return matched.length === 1 ? 0.20 : 0;
  }

  // للعناوين الأطول (3+ كلمات): guard إضافي — 2 تطابق مطلوبان كحد أدنى
  if (needleWords.length >= 3 && matched.length < 2) return 0;

  return ratio;
}

// ══════════════════════════════════════════════
//  STEP 3: askMistral
// ══════════════════════════════════════════════

/**
 * يُستدعى في حالتين:
 *  1. لا metaTitle (PDF بدون عنوان في الـ metadata)
 *  2. score في المنطقة الغامضة: REJECT_THRESHOLD ≤ score < ACCEPT_THRESHOLD
 *
 * Cache Redis بـ TTL ساعتين:
 *  يمنع الاستدعاء المزدوج لنفس (url, book) عند retries أو concurrent requests
 */
async function askMistral(
  bookName:  string,
  metaTitle: string,
  urlHint:   string,
  explicitFilenameHint: string = "",
): Promise<boolean> {
  // FIX-WRONG-FILE (BUG-1): fail-closed بدون مفتاح — بدل fail-open
  // الكود السابق كان متناقضاً مع تعليقه: التعليق يقول fail-closed لكن
  // `return true` فعلياً = fail-open (اقبل) → ثغرة خطيرة لو سقط مفتاح
  // Mistral أو انتهى الرصيد، كل ملف PDF غامض يُقبل ويُرسل ويُكاش.
  // لتجنّب breakage مفاجئ في deployments قديمة لم تُعدّ Mistral، نسمح
  // بـ flag صريح `MISTRAL_FAIL_OPEN=true` (default false) للسلوك القديم.
  if (!MISTRAL_API_KEY) {
    const failOpen = process.env.MISTRAL_FAIL_OPEN === "true";
    redis.incr(failOpen ? "tel:pdf:mistral_no_key_open" : "tel:pdf:mistral_no_key_closed").catch(() => {});
    return failOpen;
  }

  // BUG FIX: الكود السابق استخدم urlHint (اسم الملف فقط) كـ cache key بدل الـ URL الكامل.
  // هذا يُنتج تصادمات عند ملفات تشترك في نفس الاسم من مصادر مختلفة:
  //   "https://site1.com/الكتاب.pdf" و "https://site2.com/الكتاب.pdf"
  //   كلاهما urlHint = "الكتاب" → نفس cache key → verdict غير صحيح للثاني.
  // الحل: استخدام pdfUrl الكامل (يُمرَّر كـ urlHint من validatePdfContent)
  // ملاحظة: pdfUrl يُمرَّر هنا عبر المعامل urlHint الأصلي للدالة
  // لتجنب تغيير signature الدالة، نستخدم urlHint كما هو لكن بعد SHA-256 على القيمة الكاملة
  // (urlHint = pdfUrl كاملاً من الـ caller في validatePdfContent)
  // FIX (CD-filename): cache key بيشمل اسم الـ Content-Disposition عشان verdicts قديمة
  //   كانت بتبقى "NO" قبل ما نضيف الـ header لازم تـ invalidate لما الـ header
  //   يبدأ يوصل (مثلاً Hindawi numeric URL: نفس الـ pdfUrl لكن CD فيها اسم الكتاب
  //   الحقيقي → verdict جديد).
  const cacheSeed = explicitFilenameHint
    ? `${urlHint}|${bookName}|cd:${explicitFilenameHint}`
    : `${urlHint}|${bookName}`;
  const cacheKey = `mv:${createHash("sha256").update(cacheSeed).digest("hex").slice(0, 16)}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      L.debug("pdfValidator", "Mistral cache hit", { book: bookName.slice(0, 40), verdict: cached });
      return cached === "1";
    }
  } catch { /* Redis miss → proceed */ }

  // FIX: نفك ترميز الـ URL slug (مثلاً %D8%A2%D9%86%D8%A7 → آنا) قبل ما نوريه لـ Mistral.
  // مع الـ URL الخام كان Mistral بيشوف "غير مفهوم" ويرفض حتى لو الـ slug فيه اسم الكتاب الكامل.
  // FIX (CD-filename): لو الـ caller مرّر اسم ملف صريح (من Content-Disposition) نستخدمه
  //   مباشرة. هو ده اللي بيحل مشكلة الـ hosts اللي بتخدّم URLs رقمية بدون أسماء
  //   (Hindawi /books/62575295.pdf، foulabook /book/downloading/123، إلخ) لكن
  //   بترسل اسم الكتاب الحقيقي في الـ HTTP header.
  let promptFilename = urlHint;
  if (explicitFilenameHint && explicitFilenameHint.trim().length > 1) {
    promptFilename = explicitFilenameHint.trim();
  } else {
    try {
      const decoded = decodeURIComponent(new URL(urlHint).pathname.split("/").pop() || "");
      const cleaned = decoded.replace(/\.pdf$/i, "").replace(/[-_+]/g, " ").trim();
      if (cleaned.length > 1) promptFilename = cleaned;
    } catch { /* urlHint مش URL → نسيبه زي ما هو */ }
  }

  // FIX: Prompt متوازن — صارم بشكل كافٍ يرفض كتب مختلفة تماماً، ومرن بشكل كافٍ
  // يقبل التطابق بالـ slug/الترجمة/الـ transliteration.
  // قبل كده كان prompt صارم جداً يرفض حتى التطابق الحرفي (filename="آنا كارنينا" + book="آنا كارنينا" → NO)
  // بسبب "When in doubt answer NO". الجديد متعدد اللغات ويسمح بزيادات شائعة (pdf, اسم الموقع، السنة).
  const lines: string[] = [
    `You are verifying whether a PDF file contains the book the user requested.`,
    `Requested book: "${bookName}"`,
  ];
  if (metaTitle) lines.push(`PDF metadata title: "${metaTitle}"`);
  else           lines.push(`(PDF metadata title is empty)`);
  if (promptFilename) lines.push(`PDF filename / URL hint: "${promptFilename}"`);
  else                lines.push(`(no filename hint)`);
  lines.push(
    ``,
    `Decide YES or NO using these rules in order:`,
    `1) If the metadata title matches the requested book (same title in any language, transliteration, or translation), answer YES.`,
    `2) If metadata is empty or unhelpful, check the filename hint:`,
    `   - YES if the filename contains the requested book title (in any language, transliteration, or translation),`,
    `     even with extra words like "pdf", "book", "كتاب", site name, year, etc.`,
    `   - YES if the filename contains the requested author's name.`,
    `3) Answer NO only if there is positive evidence of a different book — i.e. the filename or metadata clearly names a different specific book.`,
    `4) If the filename has no useful information (only digits, random IDs, empty), answer NO.`,
    `Reply with one word only: YES or NO`,
  );

  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${MISTRAL_API_KEY}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MISTRAL),
      body: JSON.stringify({
        model:       "mistral-small-latest",
        messages:    [{ role: "user", content: lines.join("\n") }],
        max_tokens:  16,   // كافٍ لـ YES/NO حتى مع leading whitespace
        temperature: 0,
      }),
    });

    if (!r.ok) {
      // FIX: fail-closed عند خطأ HTTP من Mistral
      L.warn("pdfValidator", `Mistral API HTTP ${r.status} — fail-closed`);
      return false;
    }

    const data    = await r.json() as { choices?: { message?: { content?: string } }[] };
    const ans     = (data.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
    const verdict = ans.startsWith("Y");

    L.info("pdfValidator", "Mistral answered", { ans: ans.slice(0, 10), verdict, book: bookName.slice(0, 40) });
    redis.setex(cacheKey, MISTRAL_CACHE_TTL_SEC, verdict ? "1" : "0").catch(() => {});
    return verdict;

  } catch (e) {
    // FIX: fail-closed عند خطأ Mistral بدل fail-open
    // Mistral معطّل مؤقتاً → لا نُرسَل كتاباً ربما غلط — نرفض ونجرّب الـ URL التالي
    L.warn("pdfValidator", `Mistral error — fail-closed: ${String(e).slice(0, 80)}`);
    return false;
  }
}

// ══════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════

/**
 * validatePdfContent
 *
 * يُستدعى بعد تحميل PDF محلياً وقبل إرساله لـ Telegram.
 *
 * @param filePath  مسار الملف المؤقت على الديسك
 * @param bookName  اسم الكتاب الذي طلبه المستخدم
 * @param pdfUrl    URL المصدر — يُستخدم كـ cache key لـ Mistral + filename hint
 * @param skipMistral  لو true بيـ skip الـ Mistral validation (early-stop)
 * @param contentDispositionFilename  اسم الملف المستخرج من HTTP `Content-Disposition`
 *   header. ضروري للـ hosts اللي بتخدّم URL رقمي بحت (مثلاً Hindawi
 *   `/books/62575295.pdf` أو foulabook `/book/downloading/<id>`) لكن بترسل اسم
 *   الكتاب الحقيقي في الـ header. لو فاضي، الـ validator بيرجع للـ URL filename
 *   كما كان قبل (سلوك متوافق).
 * @returns PdfValidationResult — accepted:true → أرسل | false → جرّب التالي
 */
export async function validatePdfContent(
  filePath:    string,
  bookName:    string,
  pdfUrl:      string = "",
  skipMistral: boolean = false,
  contentDispositionFilename: string = "",
  searchResultTitle: string = "",
): Promise<PdfValidationResult> {
  const t0 = Date.now();

  // searchResultTitle = HTML <title> from the search engine (Firecrawl)
  // for the page that linked to this PDF. Used as an additional title
  // signal when the PDF metadata is unavailable (e.g. Hindawi PDFs whose
  // /Title sits beyond the 64KB scan window) AND as a sanity check on
  // trusted domains — see the trusted-domain branch below.
  // Strip common URL-only fallbacks: engine.ts falls back to the raw URL
  // when the HTML <title> tag is missing.
  const searchTitle = (searchResultTitle && !searchResultTitle.startsWith("http"))
    ? searchResultTitle.trim()
    : "";

  // ── trusted domains — نقبل مباشرة بدون validation ────────
  // PR #31: if the search-result title is available AND clearly mismatches
  // bookName, reject. This catches cases like Firecrawl returning an
  // unrelated Hindawi book ("ملك وامرأة وإله") for a query the catalog
  // doesn't actually have ("تحت مسمى الرجولة").
  //
  // PR #33 (cache-poison defense): when there is *no* search title AND
  // the URL filename is opaque (digit-only id), do NOT bypass — fall
  // through to full PDF metadata + Mistral validation. Without this gate,
  // Hindawi numeric URLs got accepted and cached even when Firecrawl
  // returned no title to verify against (10 poisoned entries observed
  // in production on 2026-05-03).
  if (pdfUrl && isTrustedDomain(pdfUrl)) {
    if (searchTitle) {
      const titleScore = wordOverlapScore(bookName, searchTitle);
      if (titleScore < PDF_VALIDATE_REJECT_THRESHOLD) {
        redis.incr(TEL_REJECTED).catch(() => {});
        L.warn("pdfValidator", "trusted_domain_title_mismatch — search title doesn't match book", {
          url: pdfUrl.slice(0, 80),
          book: bookName.slice(0, 50),
          searchTitle: searchTitle.slice(0, 80),
          score: titleScore.toFixed(2),
        });
        return {
          accepted: false,
          score: titleScore,
          event: "trusted_domain_title_mismatch",
          mistralUsed: false,
          metaTitle: searchTitle,
        };
      }
      L.info("pdfValidator", "Trusted domain — title-gate passed, accepting", {
        url: pdfUrl.slice(0, 80),
        searchTitle: searchTitle.slice(0, 60),
        score: titleScore.toFixed(2),
      });
      redis.incr(TEL_ACCEPTED).catch(() => {});
      return {
        accepted: true,
        score: 1,
        event: "candidate_accepted_title_match",
        mistralUsed: false,
        metaTitle: searchTitle,
      };
    }

    if (hasUninformativeFilename(pdfUrl)) {
      // No search title to verify AND the URL itself carries no title
      // signal. We can't tell if the search ranker resolved the right
      // book — fall through to full validation (metadata + Mistral).
      L.warn("pdfValidator", "trusted_domain_opaque_url_no_title — falling through to full validation", {
        url:  pdfUrl.slice(0, 80),
        book: bookName.slice(0, 50),
      });
      // (Falls through to the 64KB read + Mistral path below.)
    } else {
      // Informative-looking filename, no search title. Before bypass,
      // verify the filename has at least *some* token overlap with the
      // requested book — otherwise the slug could be an entirely
      // different book on the same trusted domain.
      //
      // Production incident 2026-05-03: archive.org URL
      // `.../items/dalilkuwa-s2021-a/dalilkuwa-s2021-a.pdf` (= "الدليل
      // إلى القوة والدهاء") was bypassed for the request "الموجز في
      // فن التفاوض". Filename was informative (not digit-only) so this
      // branch fired and accepted blindly. Filename relevance check
      // catches this: 0 token overlap → fall through to full validation.
      const filenameScore = urlFilenameRelevance(bookName, pdfUrl);
      if (filenameScore < 0.15) {
        L.warn("pdfValidator", "trusted_domain_unrelated_filename — falling through to full validation", {
          url:  pdfUrl.slice(0, 80),
          book: bookName.slice(0, 50),
          score: filenameScore.toFixed(2),
        });
        // (Falls through to the 64KB read + Mistral path below.)
      } else {
        L.info("pdfValidator", "Trusted domain — informative URL with filename match, no search title, skipping validation", {
          url: pdfUrl.slice(0, 80),
          score: filenameScore.toFixed(2),
        });
        redis.incr(TEL_ACCEPTED).catch(() => {});
        return {
          accepted: true,
          score: 1,
          event: "candidate_accepted_title_match",
          mistralUsed: false,
          metaTitle: searchTitle,
        };
      }
    }
  }

  // ── قراءة أول 64KB — كافٍ لأي PDF metadata ──────────────
  // الـ Info dictionary موجود دائماً في أول 20KB تقريباً
  let buf: Buffer;
  try {
    const stat = await fsPromises.stat(filePath);
    // FIX: ملف 0 bytes = تحميل فاشل أو ملف تالف → رفض فوري
    if (stat.size === 0) {
      L.warn("pdfValidator", `Empty file (0 bytes) — rejecting`, { url: pdfUrl.slice(0, 80) });
      return { accepted: false, score: 0, event: "empty_file", mistralUsed: false, metaTitle: "" };
    }
    // FIX: ملف أصغر من 1KB لا يمكن أن يكون PDF حقيقي
    if (stat.size < 1024) {
      L.warn("pdfValidator", `File too small (${stat.size} bytes) — rejecting`, { url: pdfUrl.slice(0, 80) });
      return { accepted: false, score: 0, event: "file_too_small", mistralUsed: false, metaTitle: "" };
    }
    const size = Math.min(stat.size, 65_536);
    buf        = Buffer.alloc(size);
    const fh   = await fsPromises.open(filePath, "r");
    try {
      await fh.read(buf, 0, size, 0);
    } finally {
      await fh.close(); // يُغلَق دائماً — حتى لو read() أو أي كود أعلاه throw
    }
  } catch (e) {
    L.warn("pdfValidator", `Cannot read file — fail-open: ${String(e).slice(0, 80)}`);
    redis.incr(TEL_EXTRACT_FAILED).catch(() => {});
    return { accepted: true, score: 0.5, event: "no_metadata_accepted", mistralUsed: false, metaTitle: "" };
  }

  // FIX: تحقق من PDF magic bytes ("%PDF-") — أول 5 bytes
  // ملف لا يبدأ بـ %PDF- ليس PDF حقيقي (HTML error page, redirect, إلخ)
  if (buf.length < 5 || buf.slice(0, 5).toString("ascii") !== "%PDF-") {
    const preview = buf.slice(0, 20).toString("utf8", 0, 20).trim();
    L.warn("pdfValidator", `Not a PDF (bad magic bytes): "${preview.slice(0,30)}"`, { url: pdfUrl.slice(0, 80) });
    return { accepted: false, score: 0, event: "not_pdf_magic", mistralUsed: false, metaTitle: "" };
  }

  const metaTitle = extractMetaTitle(buf);

  // اسم الملف من الـ URL — إشارة إضافية للـ Mistral
  let urlFilename = "";
  try {
    urlFilename = decodeURIComponent(new URL(pdfUrl).pathname.split("/").pop() || "")
      .replace(/\.pdf$/i, "").replace(/[-_+]/g, " ").trim();
  } catch { /* URL غير صالح → تجاهل */ }

  // اسم الملف من Content-Disposition — أصدق من الـ URL لما الـ host بيخدّم
  // معرّف رقمي في الـ pathname (مثلاً Hindawi /books/62575295.pdf، foulabook
  // /book/downloading/123). لو فاضي، نستخدم اسم الـ URL.
  let cdFilename = "";
  if (contentDispositionFilename) {
    cdFilename = contentDispositionFilename
      .replace(/\.pdf$/i, "")
      .replace(/[-_+]/g, " ")
      .trim();
  }

  // اختر الأفضل: CD لو فيه أحرف حقيقية وURL ضعيف (رقم بحت، فاضي، أو قصير
  // جداً ASCII). بعكس ذلك نسيب URL filename لأنه بيكون فيه slug عربي/إنجليزي
  // مفيد (مثل foulabook /ar/book/<slug-of-book>).
  const urlHasLetters = /[a-zA-Z\u0600-\u06FF]/.test(urlFilename);
  const cdHasLetters  = /[a-zA-Z\u0600-\u06FF]/.test(cdFilename);
  const filenameHint  = (cdHasLetters && (!urlHasLetters || urlFilename.length < 4))
    ? cdFilename
    : urlFilename;
  const filenameSource = filenameHint === cdFilename && cdFilename
    ? "content-disposition"
    : "url";

  L.info("pdfValidator", "Extracted metadata", {
    book:           bookName.slice(0, 50),
    metaTitle:      metaTitle.slice(0, 80) || "(empty)",
    filename:       filenameHint.slice(0, 60) || "(empty)",
    filenameSource,
    urlFilename:    urlFilename.slice(0, 30) || "(empty)",
    cdFilename:     cdFilename.slice(0, 30) || "(empty)",
    ms:             Date.now() - t0,
  });

  // searchTitle promotion: when the PDF metadata title is missing but the
  // search-result <title> is available and looks like a real book title
  // (≥ 4 chars, has letters), use it as the effective metaTitle. This
  // gives downstream wordOverlapScore + Mistral a real signal instead of
  // falling back to numeric-ID filename guesses. Critical for hosts like
  // Hindawi where /Title sits beyond the 64KB scan window.
  let effectiveMetaTitle = metaTitle;
  let metaTitleSource: "pdf" | "search" = "pdf";
  if (!effectiveMetaTitle && searchTitle &&
      searchTitle.length >= 4 &&
      /[a-zA-Z\u0600-\u06FF]/.test(searchTitle)) {
    effectiveMetaTitle = searchTitle;
    metaTitleSource = "search";
    L.info("pdfValidator", "PDF metaTitle missing — using search-result title", {
      book: bookName.slice(0, 50),
      searchTitle: searchTitle.slice(0, 60),
    });
  }

  // ── لا metaTitle (ولا searchTitle بديل) → تحقق من اسم الملف أولاً ─
  if (!effectiveMetaTitle) {
    redis.incr(TEL_EXTRACT_FAILED).catch(() => {});

    // v25 FIX: اسم الملف العشوائي/الرقمي مع غياب metaTitle = صفر معلومة
    // مثال: "yxps7.pdf", "53814181.pdf", "abc123.pdf"
    // في هذه الحالة Mistral يخمّن بناءً على الموضوع لا العنوان → كتاب غلط مؤكد
    // الحل: رفض مباشر بدون Mistral — نجرب الـ URL التالي
    // منطق isMeaningless:
    //  - فارغ = رفض
    //  - قصير جداً (≤3 أحرف) ASCII = رفض
    //  - خلط حروف+أرقام ≤8 بدون _ أو - (عشوائي مثل xK9mP2) = رفض
    //  - اسم له كلمات (فيه _ أو - أو أحرف فقط بدون أرقام) = يمر حتى لو قصير
    //  - رقمي بحت (ID موثوق مثل 53814181) = يمر
    // FIX (CD-filename): نختبر الـ filenameHint اللي يفضل CD على URL،
    // مش الـ urlFilename الخام — كده أي host بيخدّم numeric ID لكن header
    // فيها اسم حقيقي يعدّي الـ meaningless check.
    const _fn = filenameHint.replace(/\s/g, "");
    const _hasAlpha = /[a-zA-Z]/.test(_fn);
    const _hasDigit = /[0-9]/.test(_fn);
    const _hasSep   = /[_-]/.test(_fn);           // underscore/dash = كلمات منفصلة
    // TEST-FIND-2 FIX: استخراج الأحرف الحقيقية فقط (بدون أرقام أو رموز)
    // "TT-79" → _alphaOnly="TT" (2 حرف < 4) → رفض
    // "vol1-book" → _alphaOnly="volbook" (7 حروف) → يمر
    const _alphaOnly = _fn.replace(/[^a-zA-Z\u0600-\u06FF]/g, "");
    const isMeaninglessFilename =
      _fn.length === 0 ||
      (_fn.length <= 3 && /^[a-zA-Z0-9_-]+$/.test(_fn)) ||  // قصير جداً
      (_hasAlpha && _hasDigit && _fn.length <= 8 && !_hasSep && /^[a-zA-Z0-9]+$/.test(_fn)) || // عشوائي بدون separator
      (_hasAlpha && _hasDigit && _alphaOnly.length < 4); // حروف < 4 مع أرقام → بلا معنى (TT-79, AB-3)
    if (isMeaninglessFilename && MISTRAL_API_KEY) {
      redis.incr(TEL_REJECTED).catch(() => {});
      L.warn("pdfValidator", "candidate_rejected_title_mismatch — no metaTitle + meaningless filename", {
        book: bookName.slice(0, 50), filename: filenameHint.slice(0, 30),
      });
      return { accepted: false, score: 0, event: "candidate_rejected_title_mismatch", mistralUsed: false, metaTitle: "" };
    }

    if (MISTRAL_API_KEY) {
      L.info("pdfValidator", "No metaTitle — delegating to Mistral", {
        book: bookName.slice(0, 50),
        filenameSource,
      });
      redis.incr(TEL_MISTRAL).catch(() => {});
      const accepted = await askMistral(bookName, "", pdfUrl, filenameHint);
      if (accepted) redis.incr(TEL_ACCEPTED).catch(() => {});
      else          redis.incr(TEL_REJECTED).catch(() => {});
      L.info("pdfValidator",
        accepted
          ? "candidate_accepted_title_match (Mistral, no meta)"
          : "candidate_rejected_title_mismatch (Mistral, no meta)",
        { book: bookName.slice(0, 50) }
      );
      return { accepted, score: 0, event: "mistral_rerank_used", mistralUsed: true, metaTitle: "" };
    }

    // لا Mistral ولا metaTitle ولا filename مفيد → fail-open
    L.info("pdfValidator", "No metaTitle, no Mistral key — fail-open accept", { book: bookName.slice(0, 50) });
    return { accepted: true, score: 0.5, event: "no_metadata_accepted", mistralUsed: false, metaTitle: "" };
  }

  // ── حساب score ─────────────────────────────────────────
  // We use effectiveMetaTitle (PDF /Title or, when missing, the search-result
  // title) so hosts whose /Title is unreadable (e.g. beyond the 64KB scan window)
  // can still be scored against a real title rather than failing to extract.
  const score = wordOverlapScore(bookName, effectiveMetaTitle);

  L.debug("pdfValidator", "Local score", {
    book:      bookName.slice(0, 50),
    score:     score.toFixed(2),
    metaTitle: effectiveMetaTitle.slice(0, 60),
    titleSrc:  metaTitleSource,
  });

  // ── قرار واضح: قبول (high-confidence) ───────────────
  // الدرجة عالية بالقدر الكافي عشان نقبل بدون استدعاء Mistral.
  // CONFIRM_THRESHOLD ≥ ACCEPT_THRESHOLD: لو متساويان البلوك ده بيشتغل
  // كأن الـ confirm band غير موجود (back-compat).
  if (score >= PDF_VALIDATE_CONFIRM_THRESHOLD) {
    redis.incr(TEL_ACCEPTED).catch(() => {});
    L.info("pdfValidator", "candidate_accepted_title_match", {
      book: bookName.slice(0, 50), score: score.toFixed(2),
      metaTitle: effectiveMetaTitle.slice(0, 60), titleSrc: metaTitleSource,
    });
    return { accepted: true, score, event: "candidate_accepted_title_match", mistralUsed: false, metaTitle: effectiveMetaTitle };
  }

  // ── منطقة "قابلة للقبول مع تأكيد Mistral" ─────────────
  // [ACCEPT_THRESHOLD, CONFIRM_THRESHOLD): الدرجة كافية للقبول لكنها مش
  // عالية لدرجة الثقة الكاملة. لو Mistral متاح → نطلب تأكيد.
  // لو Mistral غير متاح → نقبل (السلوك القديم) لأن الـ score يتعدّى
  // ACCEPT_THRESHOLD أصلاً.
  if (score >= PDF_VALIDATE_ACCEPT_THRESHOLD) {
    if (!MISTRAL_API_KEY || skipMistral) {
      redis.incr(TEL_ACCEPTED).catch(() => {});
      L.info("pdfValidator", "candidate_accepted_title_match (confirm-band, no mistral)", {
        book: bookName.slice(0, 50), score: score.toFixed(2),
        metaTitle: effectiveMetaTitle.slice(0, 60), titleSrc: metaTitleSource,
      });
      return { accepted: true, score, event: "candidate_accepted_title_match", mistralUsed: false, metaTitle: effectiveMetaTitle };
    }
    redis.incr(TEL_MISTRAL).catch(() => {});
    L.info("pdfValidator", "Confirm band — delegating to Mistral", {
      book: bookName.slice(0, 50), score: score.toFixed(2),
      metaTitle: effectiveMetaTitle.slice(0, 60), titleSrc: metaTitleSource,
    });
    const accepted = await askMistral(bookName, effectiveMetaTitle, pdfUrl, filenameHint);
    if (accepted) {
      redis.incr(TEL_ACCEPTED).catch(() => {});
      L.info("pdfValidator", "candidate_accepted_title_match (confirm-band, via Mistral)", {
        book: bookName.slice(0, 50), score: score.toFixed(2),
      });
    } else {
      redis.incr(TEL_REJECTED).catch(() => {});
      L.warn("pdfValidator", "candidate_rejected_title_mismatch (confirm-band overruled by Mistral)", {
        book: bookName.slice(0, 50), score: score.toFixed(2),
        metaTitle: effectiveMetaTitle.slice(0, 60), titleSrc: metaTitleSource,
      });
    }
    return { accepted, score, event: "mistral_rerank_used", mistralUsed: true, metaTitle: effectiveMetaTitle };
  }

  // ── قرار واضح: رفض ───────────────────────────────────
  // نرفض فقط إذا:
  //  1. metaTitle واضح (ليس مجرد أرقام/رموز)
  //  2. score منخفض جداً
  //  3. metaTitle بنفس لغة bookName — لو اللغة مختلفة قد يكون ترجمة → Mistral يحكم
  // FIX: الكتاب العربي "العادات الذرية" ← PDF "Atomic Habits" كانت تُرفض مباشرة
  // لأن الكلمات العربية لا تتطابق مع الإنجليزية → score=0 → REJECT بدون Mistral
  // الحل: إذا bookName عربي وmetaTitle إنجليزي (أو العكس) → منطقة غامضة → Mistral
  const isClearTitle = effectiveMetaTitle.length >= 4 && !/^[\d\s_\-\.]+$/.test(effectiveMetaTitle);
  const bookHasArabicLetters = /[\u0600-\u06FF]/.test(bookName);
  const metaIsArabic         = /[\u0600-\u06FF]/.test(effectiveMetaTitle);
  // Cross-language bypass: كتاب عربي ← PDF إنجليزي أو العكس = قد يكون ترجمة → Mistral يحكم
  // FIX: الكود القديم كان يفحص Arabic→English فقط (bookHasArabicLetters && !metaIsArabic)
  // الحالة الغائبة: بحث إنجليزي "Atomic Habits" ← PDF عربي "العادات الذرية"
  //   bookHasArabicLetters=false → crossLang=false → sameLang=true → score=0 → رفض بدون Mistral!
  // الحل: فحص الاتجاهين — إذا أي طرف عربي والآخر لا → منطقة غامضة → Mistral
  // استثناء: الأرقام مثل "1984" language-neutral — نتعامل معها كـ sameLang
  const crossLang = (bookHasArabicLetters !== metaIsArabic) &&
                    (bookHasArabicLetters || metaIsArabic); // على الأقل طرف واحد عربي
  const sameLang  = !crossLang;

  // ROOT FIX v2: العناوين القصيرة (≤ 2 كلمة دالة) مع Mistral متاح — لا نرفض بالـ score وحده
  //
  // المشكلة:
  //   اسم مثل "أماريتا" (كلمة واحدة) — كلمة واحدة لا تكفي للحكم المحلي بثقة
  //   PDF صحيح قد يكون metaTitle "أماريتا - رواية رومانسية حزينة" → بسبب v27-BIDIR
  //   يحصل score=0.25 (منطقة غامضة) ويذهب لـ Mistral بشكل صحيح
  //   لكن لو score=0 بسبب اختلاف encoding بسيط → كان يُرفض مباشرة بدون Mistral
  //
  // الحل (مشروط بـ MISTRAL_API_KEY):
  //   مع Mistral: العناوين القصيرة تذهب للمنطقة الغامضة → Mistral يحكم بذكاء
  //   بدون Mistral: نبقي السلوك القديم لمنع قبول كتب خاطئة بشكل عشوائي
  //   (fail-open بدون Mistral لعنوان قصير = خطر إرسال كتاب مختلف تماماً)
  const needleWordCount = normalizeArabic(bookName)
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !ARABIC_STOPWORDS.has(w)).length;
  const isShortTitleWithMistral = needleWordCount <= 2 && !!MISTRAL_API_KEY;

  if (!isShortTitleWithMistral && isClearTitle && score < PDF_VALIDATE_REJECT_THRESHOLD && sameLang) {
    redis.incr(TEL_REJECTED).catch(() => {});
    L.warn("pdfValidator", "candidate_rejected_title_mismatch", {
      book:      bookName.slice(0, 50),
      score:     score.toFixed(2),
      metaTitle: effectiveMetaTitle.slice(0, 60),
      titleSrc:  metaTitleSource,
    });
    return { accepted: false, score, event: "candidate_rejected_title_mismatch", mistralUsed: false, metaTitle: effectiveMetaTitle };
  }

  // ── Mistral early-stop ───────────────────────────────
  // The caller (bookRequest.ts) sets skipMistral=true once it has seen
  // MISTRAL_NO_STREAK_LIMIT consecutive Mistral NO verdicts for the
  // current request, to stop burning API budget on a query Mistral has
  // already failed to validate. In this branch we trust heuristics only:
  // the score-based ACCEPT path above didn't fire and the score-based
  // REJECT path also didn't fire (otherwise we'd have returned earlier),
  // so the candidate is genuinely ambiguous. Without Mistral the safest
  // choice on an ambiguous candidate is to reject — false-accepts here
  // would send the wrong book to the user, whereas false-rejects just
  // move on to the next candidate.
  if (skipMistral) {
    redis.incr(TEL_REJECTED).catch(() => {});
    L.warn("pdfValidator", "Mistral skipped (early-stop) — rejecting ambiguous candidate", {
      book:      bookName.slice(0, 50),
      score:     score.toFixed(2),
      metaTitle: effectiveMetaTitle.slice(0, 60),
    });
    return {
      accepted:    false,
      score,
      event:       "candidate_rejected_title_mismatch",
      mistralUsed: false,
      metaTitle:   effectiveMetaTitle,
    };
  }

  // ── منطقة غامضة → Mistral ───────────────────────────
  redis.incr(TEL_MISTRAL).catch(() => {});
  L.info("pdfValidator", "Ambiguous score — delegating to Mistral", {
    book: bookName.slice(0, 50), score: score.toFixed(2),
    metaTitle: effectiveMetaTitle.slice(0, 60), titleSrc: metaTitleSource,
  });

  // BUG FIX: نُمرِّر pdfUrl كاملاً (وليس urlFilename) لضمان uniqueness في الـ cache key
  // FIX (CD-filename): نمرّر filenameHint (CD أو URL) كـ explicit filename للـ prompt.
  // Pass effectiveMetaTitle (which may be the search-result title when PDF /Title
  // was unreadable) so Mistral can reason about a real title rather than "".
  const accepted = await askMistral(bookName, effectiveMetaTitle, pdfUrl, filenameHint);

  if (accepted) {
    redis.incr(TEL_ACCEPTED).catch(() => {});
    L.info("pdfValidator", "candidate_accepted_title_match (via Mistral)", {
      book: bookName.slice(0, 50), score: score.toFixed(2),
    });
  } else {
    redis.incr(TEL_REJECTED).catch(() => {});
    L.warn("pdfValidator", "candidate_rejected_title_mismatch (via Mistral)", {
      book: bookName.slice(0, 50), score: score.toFixed(2),
      metaTitle: effectiveMetaTitle.slice(0, 60), titleSrc: metaTitleSource,
    });
  }

  return { accepted, score, event: "mistral_rerank_used", mistralUsed: true, metaTitle: effectiveMetaTitle };
}

// ══════════════════════════════════════════════
//  STATS — للـ dashboard admin
// ══════════════════════════════════════════════

export interface PdfValidationStats {
  accepted:      number;
  rejected:      number;
  mistralUsed:   number;
  extractFailed: number;
  rejectionRate: string;
}

/** parseInt آمن — يُعيد 0 بدل NaN عند بيانات تالفة في Redis */
function safeInt(v: string | null): number {
  return parseInt(v ?? "0", 10) || 0;
}

export async function getPdfValidationStats(): Promise<PdfValidationStats> {
  try {
    const [a, r, m, e] = await redis.mget(TEL_ACCEPTED, TEL_REJECTED, TEL_MISTRAL, TEL_EXTRACT_FAILED);
    const accepted      = safeInt(a);
    const rejected      = safeInt(r);
    const mistralUsed   = safeInt(m);
    const extractFailed = safeInt(e);
    const total         = accepted + rejected;
    const rejectionRate = total > 0 ? `${Math.round((rejected / total) * 100)}%` : "0%";
    return { accepted, rejected, mistralUsed, extractFailed, rejectionRate };
  } catch {
    return { accepted: 0, rejected: 0, mistralUsed: 0, extractFailed: 0, rejectionRate: "?" };
  }
}
