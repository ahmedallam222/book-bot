import * as fsPromises from "fs/promises";
import { createHash }  from "crypto";
import { L } from "./logger.js";
import { normalizeArabic } from "./text.js";
import { redis } from "./redis.js";
import {
  MISTRAL_API_KEY,
  PDF_VALIDATE_ACCEPT_THRESHOLD,
  PDF_VALIDATE_REJECT_THRESHOLD,
  TIMEOUT_MISTRAL,
} from "./config.js";

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
  // ضمائر
  "هو",
  "هي",
  "هم",
  "انت",
  "انا",
  // كلمات وظيفية شائعة
  "كل",
  "بين",
  "عند",
  "لقد",
  "قد",
  "كان",
  "كما",
  // أسماء إشارة (بعد التعيير — ة→ه)
  "هذا",
  "هذه",
  "هؤلاء",
  "ذلك",
  "تلك",
  "الذي",
  "التي",
]);

export type PdfValidationEvent =
  | "candidate_accepted_title_match"
  | "candidate_rejected_title_mismatch"
  | "mistral_rerank_used"
  | "no_metadata_accepted";

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
  const haystackWords = normalizeArabic(metaTitle).split(/\s+/).filter((w) => w.length >= 1);
  const haystackSet = new Set(haystackWords);

  // BUG FIX: إضافة haystackStrippedSet — يحذف البادئات من كلمات haystack للمقارنة الثنائية.
  // المشكلة: الكود القديم كان يحذف البادئة من needle فقط:
  //   needle="البدعه" ، haystack has "والبدعه" → haystackSet.has("البدعه")=false → miss
  //   (كلمة الكتاب نظيفة، لكن عنوان الـ PDF يبدأ بحرف عطف)
  // الحل: نبني مجموعة ثانية من haystack بعد حذف البادئات من كل كلمة
  //   ثم نتحقق: هل needle موجود في haystack المجردة؟
  const haystackStrippedSet = new Set(haystackWords.map(stripArabicPrefix));

  // BUG FIX (BUG-REVIEW-3): إضافة مقارنة مع حذف البادئات العربية — ثنائية الاتجاه الآن.
  // "والبدعة" (needleWord) لن تتطابق مع "البدعة" (haystackWord) بدون هذا الفحص.
  // "البدعة" (needleWord) لن تتطابق مع "والبدعة" (haystackWord) بدون haystackStrippedSet.
  const matched = needleWords.filter((w) => {
    if (haystackSet.has(w)) return true;
    // needle → strip → check in haystack (النمط القديم)
    const strippedNeedle = stripArabicPrefix(w);
    if (strippedNeedle !== w && haystackSet.has(strippedNeedle)) return true;
    // needle → check in stripped-haystack (النمط الجديد — الحالة المعاكسة)
    if (haystackStrippedSet.has(w)) return true;
    if (strippedNeedle !== w && haystackStrippedSet.has(strippedNeedle)) return true;
    return false;
  });

  const ratio   = matched.length / needleWords.length;

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
): Promise<boolean> {
  if (!MISTRAL_API_KEY) return true; // fail-open بدون مفتاح

  // BUG FIX: الكود السابق استخدم urlHint (اسم الملف فقط) كـ cache key بدل الـ URL الكامل.
  // هذا يُنتج تصادمات عند ملفات تشترك في نفس الاسم من مصادر مختلفة:
  //   "https://site1.com/الكتاب.pdf" و "https://site2.com/الكتاب.pdf"
  //   كلاهما urlHint = "الكتاب" → نفس cache key → verdict غير صحيح للثاني.
  // الحل: استخدام pdfUrl الكامل (يُمرَّر كـ urlHint من validatePdfContent)
  // ملاحظة: pdfUrl يُمرَّر هنا عبر المعامل urlHint الأصلي للدالة
  // لتجنب تغيير signature الدالة، نستخدم urlHint كما هو لكن بعد SHA-256 على القيمة الكاملة
  // (urlHint = pdfUrl كاملاً من الـ caller في validatePdfContent)
  const cacheKey = `mv:${createHash("sha256").update(`${urlHint}|${bookName}`).digest("hex").slice(0, 16)}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      L.debug("pdfValidator", "Mistral cache hit", { book: bookName.slice(0, 40), verdict: cached });
      return cached === "1";
    }
  } catch { /* Redis miss → proceed */ }

  const lines: string[] = [
    `أنت نظام للتحقق من تطابق ملفات PDF مع الكتب المطلوبة.`,
    `الكتاب المطلوب: "${bookName}"`,
  ];
  if (metaTitle) lines.push(`عنوان الـ PDF في metadata: "${metaTitle}"`);
  else           lines.push(`(حقل العنوان في metadata فارغ)`);
  if (urlHint)   lines.push(`اسم ملف الـ PDF: "${urlHint}"`);
  lines.push(
    ``,
    `هل هذا الـ PDF هو فعلاً الكتاب المطلوب؟`,
    `أجب بـ YES إذا كان متطابقاً أو محتمل التطابق بشكل معقول.`,
    `أجب بـ NO إذا كان واضحاً أنه كتاب مختلف تماماً.`,
    `أجب بكلمة واحدة فقط: YES أو NO`,
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
      L.warn("pdfValidator", `Mistral API HTTP ${r.status} — fail-open`);
      return true;
    }

    const data    = await r.json() as { choices?: { message?: { content?: string } }[] };
    const ans     = (data.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
    const verdict = ans.startsWith("Y");

    L.info("pdfValidator", "Mistral answered", { ans: ans.slice(0, 10), verdict, book: bookName.slice(0, 40) });
    redis.setex(cacheKey, MISTRAL_CACHE_TTL_SEC, verdict ? "1" : "0").catch(() => {});
    return verdict;

  } catch (e) {
    L.warn("pdfValidator", `Mistral error — fail-open: ${String(e).slice(0, 80)}`);
    return true;
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
 * @returns PdfValidationResult — accepted:true → أرسل | false → جرّب التالي
 */
export async function validatePdfContent(
  filePath: string,
  bookName: string,
  pdfUrl:   string = "",
): Promise<PdfValidationResult> {
  const t0 = Date.now();

  // ── قراءة أول 64KB — كافٍ لأي PDF metadata ──────────────
  // الـ Info dictionary موجود دائماً في أول 20KB تقريباً
  let buf: Buffer;
  try {
    const stat = await fsPromises.stat(filePath);
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

  const metaTitle = extractMetaTitle(buf);

  // اسم الملف من الـ URL — إشارة إضافية للـ Mistral
  let urlFilename = "";
  try {
    urlFilename = decodeURIComponent(new URL(pdfUrl).pathname.split("/").pop() || "")
      .replace(/\.pdf$/i, "").replace(/[-_+]/g, " ").trim();
  } catch { /* URL غير صالح → تجاهل */ }

  L.info("pdfValidator", "Extracted metadata", {
    book:      bookName.slice(0, 50),
    metaTitle: metaTitle.slice(0, 80) || "(empty)",
    filename:  urlFilename.slice(0, 60) || "(empty)",
    ms:        Date.now() - t0,
  });

  // ── لا metaTitle → Mistral (لو موجود) أو fail-open ─────
  if (!metaTitle) {
    redis.incr(TEL_EXTRACT_FAILED).catch(() => {});

    if (MISTRAL_API_KEY) {
      L.info("pdfValidator", "No metaTitle — delegating to Mistral", { book: bookName.slice(0, 50) });
      redis.incr(TEL_MISTRAL).catch(() => {});
      // BUG FIX: نُمرِّر pdfUrl كاملاً كـ urlHint (وليس urlFilename فقط)
      // لضمان uniqueness في cache key الـ Mistral
      const accepted = await askMistral(bookName, "", pdfUrl);
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

    // لا Mistral ولا metaTitle → fail-open (false negative أقل ضرراً من false positive في هذه الحالة)
    L.info("pdfValidator", "No metaTitle, no Mistral key — fail-open accept", { book: bookName.slice(0, 50) });
    return { accepted: true, score: 0.5, event: "no_metadata_accepted", mistralUsed: false, metaTitle: "" };
  }

  // ── حساب score ─────────────────────────────────────────
  const score = wordOverlapScore(bookName, metaTitle);

  L.debug("pdfValidator", "Local score", {
    book:      bookName.slice(0, 50),
    score:     score.toFixed(2),
    metaTitle: metaTitle.slice(0, 60),
  });

  // ── قرار واضح: قبول ──────────────────────────────────
  if (score >= PDF_VALIDATE_ACCEPT_THRESHOLD) {
    redis.incr(TEL_ACCEPTED).catch(() => {});
    L.info("pdfValidator", "candidate_accepted_title_match", {
      book: bookName.slice(0, 50), score: score.toFixed(2), metaTitle: metaTitle.slice(0, 60),
    });
    return { accepted: true, score, event: "candidate_accepted_title_match", mistralUsed: false, metaTitle };
  }

  // ── قرار واضح: رفض ───────────────────────────────────
  // نرفض فقط إذا metaTitle واضح (ليس مجرد أرقام/رموز) — عنوان واضح + score منخفض = كتاب خاطئ مؤكد
  const isClearTitle = metaTitle.length >= 4 && !/^[\d\s_\-\.]+$/.test(metaTitle);
  if (isClearTitle && score < PDF_VALIDATE_REJECT_THRESHOLD) {
    redis.incr(TEL_REJECTED).catch(() => {});
    L.warn("pdfValidator", "candidate_rejected_title_mismatch", {
      book:      bookName.slice(0, 50),
      score:     score.toFixed(2),
      metaTitle: metaTitle.slice(0, 60),
    });
    return { accepted: false, score, event: "candidate_rejected_title_mismatch", mistralUsed: false, metaTitle };
  }

  // ── منطقة غامضة → Mistral ───────────────────────────
  redis.incr(TEL_MISTRAL).catch(() => {});
  L.info("pdfValidator", "Ambiguous score — delegating to Mistral", {
    book: bookName.slice(0, 50), score: score.toFixed(2), metaTitle: metaTitle.slice(0, 60),
  });

  // BUG FIX: نُمرِّر pdfUrl كاملاً (وليس urlFilename) لضمان uniqueness في الـ cache key
  const accepted = await askMistral(bookName, metaTitle, pdfUrl);

  if (accepted) {
    redis.incr(TEL_ACCEPTED).catch(() => {});
    L.info("pdfValidator", "candidate_accepted_title_match (via Mistral)", {
      book: bookName.slice(0, 50), score: score.toFixed(2),
    });
  } else {
    redis.incr(TEL_REJECTED).catch(() => {});
    L.warn("pdfValidator", "candidate_rejected_title_mismatch (via Mistral)", {
      book: bookName.slice(0, 50), score: score.toFixed(2), metaTitle: metaTitle.slice(0, 60),
    });
  }

  return { accepted, score, event: "mistral_rerank_used", mistralUsed: true, metaTitle };
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
