import { L } from "./logger.js";
import type { BookResult } from "./types.js";
import { searchAllSources } from "./engine.js";
import { MIN_QUERY_LENGTH } from "./config.js";

// ══════════════════════════════════════════════
// FUZZY SEARCH — بحث ذكي متعدد المحاولات
//
// المحاولات مرتبة من الأدق للأعم:
//  1. النص بعد normalization (توحيد الحروف)
//  2. بالتوازي: [بدون مؤلف] + [أول 3 كلمات]
//  3. اسم المؤلف وحده
//  4. أول كلمتين مهمتين
//  5. كلمة/كلمتين + prefix (رواية/كتاب)
//  6. spelling variants على withoutAuth
//
// التحسينات الجديدة:
//  - normalizeArabic: توحيد الهمزات والتشكيل → "أماريتا"="اماريتا"
//  - extractAuthor يدعم dash "كتاب - مؤلف" و "لـ" pattern
//  - STOP_WORDS موسّعة بأنواع الكتب وكلمات البحث
//  - Timeout كلي 40 ثانية لمنع التأخير الزائد
//  - dedup بـ Set لمنع هدر credits
// ══════════════════════════════════════════════

export interface FuzzyResult {
  results:   BookResult[];
  usedFuzzy: boolean;
}

// Timeout كلي للـ fuzzy — بعده نعيد [] بدل الانتظار
const FUZZY_TIMEOUT_MS = 40_000;

// ── Common Misspellings ──────────────────────────
// أخطاء إملائية شائعة لكتب مشهورة — تُصحَّح قبل أي بحث
const COMMON_FIXES: Record<string, string> = {
  // كتب مشهورة بأخطاء إملائية شائعة
  "الخميائي":    "الخيميائي",
  "الخيمائي":    "الخيميائي",
  "يوتبيا":      "يوتوبيا",
  "يتوبيا":      "يوتوبيا",
  "فهرنهيت":     "فهرنهايت",
  "١٩٨٤":        "1984",
  "مائة عام":    "مئة عام",
  "فرانكشتاين":  "فرانكنشتاين",
  "فرنكشتاين":   "فرانكنشتاين",
  "البؤسا":       "البؤساء",
  "البؤسأ":       "البؤساء",
  "دوستيفيسكي":  "دوستويفسكي",
  "دستيوفسكي":   "دوستويفسكي",
  "ماركيز":      "ماركيس",
  "العقيدة الواسطيه": "العقيدة الواسطية",
  // إضافات جديدة — كتب شائعة
  // FIX-7: حُذف "هاري بوتر": "هاري بوتر" — كانت تصحح الكلمة لنفسها (لا فائدة منها)
  "هاري بوتار":       "هاري بوتر",
  "انماء":            "أنماء",
  "الامير الصغير":    "الأمير الصغير",
  "امير الصغير":      "الأمير الصغير",
  "ألف ليلة":         "ألف ليلة وليلة",
  "ألف ليله":         "ألف ليلة وليلة",
  "كيف تكسب":         "كيف تكسب الأصدقاء",
  "كيف تكسب الاصدقاء": "كيف تكسب الأصدقاء وتؤثر في الناس",
  "العادات السبع":    "العادات السبع للناس الأكثر فاعلية",
  "7 عادات":          "العادات السبع للناس الأكثر فاعلية",
  "ابي الغني":        "أبي الغني وأبي الفقير",
  "ابي الفقير":       "أبي الغني وأبي الفقير",
  "اب غني":           "أب غني أب فقير",
  "العتبي الذري":     "العادات الذرية",
  "العادت الذرية":    "العادات الذرية",
  "اتوميك هابيتس":   "العادات الذرية",
  "رواية دون كيشوت":  "دون كيخوته",
  "دون كيشوت":        "دون كيخوته",
  "الجريمه والعقاب":  "الجريمة والعقاب",
  "الجريمة والعقاب دستيفسكي": "الجريمة والعقاب",
  "الاخوة كرامازوف":  "الإخوة كارامازوف",
  "الاخوه كرامازوف":  "الإخوة كارامازوف",
  "صاحبة الفندق":     "الفندق",
  "سابين":             "مذكرات سابين",
  "الرحيق المحتوم":   "الرحيق المختوم",
  "الرحيق المختون":   "الرحيق المختوم",
  "مقدمه ابن خلدون":  "مقدمة ابن خلدون",
  "سيكولوجية الحشود": "سيكولوجية الجماهير",
  "علم النفس الجماهير": "سيكولوجية الجماهير",
  "اغراء":             "الإغراء",
  "التلاعب بالعقل":   "التلاعب بالعقول",
  "فن اللامباله":     "فن اللامبالاة",
  "فن اللامبالاه":    "فن اللامبالاة",
  "نهاية التاريخ":    "نهاية التاريخ والإنسان الأخير",
  "بريده وتحيز":      "كبرياء وتحيز",
  "فخر وكبرياء":      "كبرياء وتحيز",
  "موبي ديك":         "موبي دك",
  "شيرلوك هولمز":     "مغامرات شيرلوك هولمز",
  "شيرلوك هومز":      "مغامرات شيرلوك هولمز",
};

function applyCommonFixes(text: string): string {
  const t = text.trim();
  if (!t) return t;
  if (COMMON_FIXES[t]) return COMMON_FIXES[t];
  const lower = t.toLowerCase();
  if (COMMON_FIXES[lower]) return COMMON_FIXES[lower];
  // longest partial key (typo inside longer query)
  let bestK = "", bestV = "";
  for (const [k, v] of Object.entries(COMMON_FIXES)) {
    if (k.length < 4) continue;
    if (t.includes(k) || lower.includes(k.toLowerCase())) {
      if (k.length > bestK.length) { bestK = k; bestV = v; }
    }
  }
  if (bestK) {
    const re = new RegExp(bestK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return t.replace(re, bestV);
  }
  return t;
}

// ── Arabic Normalization ──────────────────────
// توحيد الحروف قبل البحث — يحل مشكلة تعدد أشكال الكتابة
// "أماريتا" = "اماريتا" = "أمَارِيتَا" = نفس البحث
function normalizeQuery(text: string): string {
  return text
    .replace(/[\u064B-\u065F\u0670]/g, "")  // حذف التشكيل كله
    .replace(/[أإآٱ]/g, "ا")                 // توحيد الألف بأشكالها
    .replace(/ة/g,  "ه")                      // تاء مربوطة → هاء
    .replace(/ى/g,  "ي")                      // ألف مقصورة → ياء
    .replace(/ؤ/g,  "و")                      // واو مهموزة
    .replace(/ئ/g,  "ي")                      // ياء مهموزة
    .replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48))
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Stopwords عربية موسّعة ───────────────────
const STOP_WORDS = new Set([
  // حروف جر وعطف
  "في", "من", "على", "إلى", "الى", "عن", "مع", "بين", "عند", "بعد", "قبل",
  "حتى", "حتي", "إذ", "إذا", "لم", "لن", "ليس", "غير", "حول", "خلال", "عبر",
  "و", "أو", "او", "ثم", "لكن", "هذا", "هذه", "التي", "الذي", "هو", "هي",
  "كل", "قد", "لقد", "كان", "كما", "لا", "بل", "أي", "اي",
  "نحن", "هم", "أنت", "أنا", "هما",
  // أنواع الكتب — كلمات تزيد الضوضاء في البحث
  "كتاب", "رواية", "قصة", "ديوان", "مجلد", "جزء", "طبعة",
  "شرح", "تفسير", "دراسة", "موسوعة", "ملخص", "مقدمة", "مختصر",
  // كلمات بحث شائعة
  "تحميل", "pdf", "تنزيل", "مجاني", "مجانا", "كامل", "كاملة",
  // FIX v29: كلمات دينية عامة جداً — تُفشل البحث بالإعادة على نتائج عامة
  "الإسلام", "الاسلام", "المسلمين", "الفقه", "القرآن", "القران", "السنة",
]);

// ── ألقاب المؤلفين ────────────────────────────
const AUTHOR_TITLES = [
  "دكتور", "الدكتور", "أستاذ", "الأستاذ",
  "للمؤلف", "تأليف", "للكاتب",
  "للشيخ", "الشيخ", "شيخ",
];

// ══════════════════════════════════════════════
// extractAuthor — يستخرج اسم المؤلف من النص
//
// يدعم 3 أنماط:
//  1. ألقاب: "دكتور مصطفى محمود"، "للشيخ ابن تيمية"
//  2. dash:  "أماريتا - أحمد خالد توفيق"
//  3. "لـ":  "أماريتا لأحمد خالد توفيق"
// ══════════════════════════════════════════════
function extractAuthor(text: string): string | null {
  // ── نمط 1: ألقاب (آخر لقب في النص) ─────────
  let lastPos = -1, lastTitle = "";
  for (const title of AUTHOR_TITLES) {
    const pos = text.lastIndexOf(title);
    if (pos > lastPos) { lastPos = pos; lastTitle = title; }
  }
  if (lastPos !== -1) {
    const after = text.slice(lastPos + lastTitle.length).trim();
    const words = after.split(/\s+/).filter((w) => w.length >= 2);
    if (words.length >= 2) return `${words[0]} ${words[1]}`;
    if (words.length === 1 && words[0].length >= 4) return words[0];
  }

  // ── نمط 2: dash "كتاب - مؤلف" ───────────────
  const dashMatch = text.match(/[-–—]\s*(.{4,30})$/);
  if (dashMatch) {
    const words = dashMatch[1].trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 4) return words.join(" ");
  }

  // ── نمط 3: "لـ" "أماريتا لأحمد خالد توفيق" ─
  // اشتراط كلمتين على الأقل + استثناء الكلمات الوظيفية (لأنها، لأن، لكن...)
  const leMatch = text.match(/\sل([^\s]{3,}\s+[^\s]{2,}(?:\s+[^\s]{2,})?)$/);
  if (leMatch) {
    const FUNCTIONAL = new Set(["لأن","لأنه","لأنها","لأنهم","لكن","لكي","لما","لمن","لكل","لها","لهم"]);
    const firstWord = "ل" + leMatch[1].split(/\s+/)[0];
    if (!FUNCTIONAL.has(firstWord)) return leMatch[1].trim();
  }

  return null;
}

// ── removeAuthor ──────────────────────────────
function removeAuthor(text: string, author: string | null): string {
  if (!author) return text;
  let result = text;

  // حاول مع اللقب أولاً
  for (const title of AUTHOR_TITLES) {
    const withTitle = `${title} ${author}`;
    if (result.includes(withTitle)) {
      result = result.split(withTitle).join("").trim();
      break;
    }
  }
  // ثم بدون لقب
  if (result === text) result = result.split(author).join("").trim();

  // dash pattern
  result = result.replace(/\s*[-–—]\s*.{4,30}$/, "").trim();

  return result.replace(/\s{2,}/g, " ").trim();
}

// ── getKeyWords ───────────────────────────────
function getKeyWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

// ── trySearch مع dedup ────────────────────────
async function trySearch(
  query:    string,
  label:    string,
  original: string,
  tried:    Set<string>,
): Promise<BookResult[] | null> {
  const q = query.trim();
  if (!q || q.length < 2 || tried.has(q)) return null;
  tried.add(q);

  const results = await searchAllSources(q);
  if (results.length > 0) {
    L.info("bot", `Fuzzy[${label}]: "${original.slice(0, 40)}" → "${q.slice(0, 40)}"`);
    return results;
  }
  return null;
}

// ══════════════════════════════════════════════
// searchWithFuzzyFallback — نقطة الدخول
// ══════════════════════════════════════════════
export async function searchWithFuzzyFallback(bookName: string): Promise<FuzzyResult> {

  const tried    = new Set<string>();
  const deadline = Date.now() + FUZZY_TIMEOUT_MS;

  const timedOut = (): boolean => Date.now() > deadline;

  // FIX-PREFILTER: رفض فوري إذا كان الاستعلام قصيراً جداً بعد حذف الفراغات
  const cleanName = bookName.trim();
  if (cleanName.replace(/\s/g, "").length < MIN_QUERY_LENGTH) {
    L.debug("bot", `Query too short for fuzzy search: "${cleanName}"`);
    return { results: [], usedFuzzy: false };
  }

  // ── تصحيح الأخطاء الشائعة أولاً ─────────────
  bookName = applyCommonFixes(bookName);

  // ── محاولة 1: النص الكامل + normalization ───
  tried.add(bookName);
  const normalized = normalizeQuery(bookName);
  if (normalized !== bookName && !tried.has(normalized)) {
    tried.add(normalized);
  }

  // ابحث بالنص الأصلي أولاً، ثم المُعيَّر لو مختلف
  const r1 = await searchAllSources(bookName);
  if (r1.length > 0) return { results: r1, usedFuzzy: false };

  if (normalized !== bookName) {
    const r1n = await searchAllSources(normalized);
    if (r1n.length > 0) {
      L.info("bot", `Fuzzy[normalized]: "${bookName.slice(0, 40)}"`);
      return { results: r1n, usedFuzzy: true };
    }
  }

  if (timedOut()) return { results: [], usedFuzzy: false };

  // ── تحضير البيانات ────────────────────────────
  const authorName  = extractAuthor(bookName);
  const withoutAuth = removeAuthor(bookName, authorName).trim();
  // FIX: لو withoutAuth فارغ (مثل "تأليف نجيب محفوظ" فقط بدون عنوان)
  //  → authorName = "نجيب محفوظ" → ابحث به مباشرة بدل bookName
  const baseText    = withoutAuth.length >= 2 ? withoutAuth
                    : authorName              ? authorName
                    : bookName;
  const keyWords    = getKeyWords(baseText);
  const threeWords  = keyWords.slice(0, 3).join(" ");

  // ── محاولة 2+3: بالتوازي مع dedup ───────────
  const tasks: Promise<BookResult[]>[] = [];
  const labels: string[] = [];

  if (withoutAuth.length >= 3 && !tried.has(withoutAuth)) {
    tried.add(withoutAuth); tasks.push(searchAllSources(withoutAuth)); labels.push("no-author");
  }
  if (threeWords.length >= 2 && !tried.has(threeWords)) {
    tried.add(threeWords);  tasks.push(searchAllSources(threeWords));  labels.push("3-words");
  }

  if (tasks.length > 0 && !timedOut()) {
    const parallel = await Promise.all(tasks);
    for (let i = 0; i < parallel.length; i++) {
      if (parallel[i].length > 0) {
        L.info("bot", `Fuzzy[${labels[i]}]: "${bookName.slice(0, 40)}"`);
        return { results: parallel[i], usedFuzzy: true };
      }
    }
  }

  if (timedOut()) return { results: [], usedFuzzy: false };

  // ── محاولة 4: اسم المؤلف وحده ────────────────
  if (authorName) {
    const r4 = await trySearch(authorName, "author", bookName, tried);
    if (r4) return { results: r4, usedFuzzy: true };
  }

  if (timedOut()) return { results: [], usedFuzzy: false };

  // ── محاولة 5: أول كلمتين مهمتين ─────────────
  const twoWords = keyWords.slice(0, 2).join(" ");
  const r5 = await trySearch(twoWords, "2-words", bookName, tried);
  if (r5) return { results: r5, usedFuzzy: true };

  if (timedOut()) return { results: [], usedFuzzy: false };

  // ── محاولة 6: prefix رواية/كتاب ─────────────
  // يشتغل لكلمة أو كلمتين — "الأمير الصغير" → "رواية الأمير الصغير"
  if (keyWords.length >= 1 && keyWords.length <= 2) {
    const core = keyWords.join(" ");
    const withRiwaya = `رواية ${core}`;
    const withKitab  = `كتاب ${core}`;

    const rP: Promise<BookResult[]>[] = [];
    const rL: string[] = [];
    if (!tried.has(withRiwaya)) { tried.add(withRiwaya); rP.push(searchAllSources(withRiwaya)); rL.push(withRiwaya); }
    if (!tried.has(withKitab))  { tried.add(withKitab);  rP.push(searchAllSources(withKitab));  rL.push(withKitab);  }

    if (rP.length > 0 && !timedOut()) {
      const prefixR = await Promise.all(rP);
      for (let i = 0; i < prefixR.length; i++) {
        if (prefixR[i].length > 0) {
          L.info("bot", `Fuzzy[prefix]: "${bookName}" → "${rL[i]}"`);
          return { results: prefixR[i], usedFuzzy: true };
        }
      }
    }
  }

  if (timedOut()) return { results: [], usedFuzzy: false };

  // ── محاولة 7: spelling variants ──────────────
  // على withoutAuth — أكثر فائدة من النص الكامل مع اسم المؤلف
  const sourceForVariants = withoutAuth.length >= 2 ? withoutAuth : bookName;
  const variants = generateSpellingVariants(sourceForVariants)
    .filter((v) => !tried.has(v))
    .slice(0, 3);

  for (const variant of variants) {
    if (timedOut()) break;
    tried.add(variant);
    const r = await searchAllSources(variant);
    if (r.length > 0) {
      L.info("bot", `Fuzzy[spelling]: "${bookName.slice(0, 40)}" → "${variant.slice(0, 40)}"`);
      return { results: r, usedFuzzy: true };
    }
  }

  return { results: [], usedFuzzy: false };
}

// ══════════════════════════════════════════════
// generateSpellingVariants
// ══════════════════════════════════════════════
export function generateSpellingVariants(text: string): string[] {
  const variants = new Set<string>();

  if (text.includes("ة")) variants.add(text.replace(/ة/g, "ه"));
  if (text.includes("ه") && !text.includes("ة")) variants.add(text.replace(/ه/g, "ة"));
  if (text.includes("ى")) variants.add(text.replace(/ى/g, "ي"));
  if (text.includes("ي") && !text.includes("ى")) variants.add(text.replace(/ي/g, "ى"));

  const hamzaForms = ["أ", "إ", "آ", "ا"];
  for (const h of hamzaForms) {
    if (text.includes(h)) {
      for (const h2 of hamzaForms) {
        if (h2 !== h) variants.add(text.replace(new RegExp(h, "g"), h2));
      }
    }
  }

  return [...variants].filter((v) => v.length >= 2).slice(0, 5);
}
