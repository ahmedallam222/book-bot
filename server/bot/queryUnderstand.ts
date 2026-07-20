// ══════════════════════════════════════════════
// QUERY UNDERSTAND — فهم عميق لطلبات الكتب
//
// مسار محلي سريع (بدون شبكة) قبل البحث:
//   1) إزالة حشو المحادثة (عايز، عندك، لو سمحت…)
//   2) نية ملخص / مؤلف / نوع أدبي / «زي كذا»
//   3) استخراج عنوان نظيف للبحث
//
// لا يستبدل AI — يكمل parseBookName + smartBookQuery.
// ══════════════════════════════════════════════

import { L } from "./logger.js";
import { redis } from "./redis.js";
import { sampleBooksForGenre } from "./curated.js";
import { GENRE_LABELS } from "./interests.js";

export type QueryMode =
  | "title"       // بحث عنوان مباشر
  | "author"      // كتب لمؤلف
  | "genre"       // اكتشاف نوع
  | "similar"     // شيء مثل كتاب X
  | "chat";       // دردشة وليست كتاباً

export interface UnderstoodQuery {
  original: string;
  /** النص المُنقَّى للبحث (عنوان أو اسم مؤلف أو كلمات نوع) */
  searchQuery: string;
  mode: QueryMode;
  wantsSummary: boolean;
  author?: string;
  genreId?: string;
  similarTo?: string;
  /** اقتراحات فورية (نوع/مشابه) تُعرض كأزرار إن رغبت الواجهة */
  suggestions?: string[];
  /** هل غيّرنا النص عن الأصل؟ */
  changed: boolean;
  note?: string; // رسالة قصيرة للمستخدم اختياري
}

// حشو محادثة شائع (عربي عامي + فصحى)
const CHAT_PREFIXES: RegExp[] = [
  /^(?:لو\s*سمحت|من\s*فضلك|بالله\s*عليك|يا\s*ريت|ياريت)\s+/i,
  /^(?:ممكن|تقدر|تقدري|تقدّر|اقدر|أقدر)\s+/i,
  /^(?:عايز|عاوز|عايزة|عاوزة|أبي|ابغى|أبغى|أريد|اريد|بدي|ودي|نفسي)\s+/i,
  /^(?:عندك|عندكم|في|فيه|هل\s*عندك|هل\s*يوجد|يوجد)\s+/i,
  /^(?:جبلي|جيبلي|جيب\s*لي|هاتلي|هات\s*لي|ابعتلي|ابعثلي|ابعث\s*لي|ارسللي|ارسل\s*لي|أرسل\s*لي|نزّل|نزل|نزّل\s*لي|نزل\s*لي|حمّل|حمل|حمّل\s*لي)\s+/i,
  /^(?:ابحث(?:\s*لي)?(?:\s*عن)?|دور(?:\s*لي)?(?:\s*على)?|فتّش|فتش)\s+/i,
  /^(?:أحتاج|احتاج|محتاج|محتاجة)\s+(?:إلى\s+)?/i,
  /^(?:بغيت|بَغيت|ودي\s+أجيب|ودي\s+اجيب)\s+/i,
  /^(?:please|pls|can\s+you|i\s+want|find\s+me)\s+/i,
];

// لاحقات شائعة
const CHAT_SUFFIXES: RegExp[] = [
  /\s+(?:لو\s*سمحت|من\s*فضلك|يا\s*ريت|بسرعة|ضروري|الآن|دلوقتي|هلق|هلأ)\s*[.!?؟…]*$/i,
  /\s+(?:pdf|بي\s*دي\s*اف|نسخة\s*كاملة|نسخه\s*كامله)\s*$/i,
  /\s+(?:من\s*فضلك|please)\s*$/i,
];

// كلمات نوع الكتاب في البداية — نُبقي المعنى عبر mode
const TYPE_WORDS = /^(?:كتاب|كتب|رواية|روايه|قصة|قصه|ديوان|مجلد|مرجع)\s+/i;

// نمط مؤلف: "كتب نجيب محفوظ" / "رواية لنجيب محفوظ" / "تأليف طه حسين"
const AUTHOR_PATTERNS: RegExp[] = [
  /^(?:كتب|روايات|مؤلفات|أعمال|اعمال)\s+(?:ل(?:ـ|ِ)?|للمؤلف\s+|للكاتب\s+|بقلم\s+|تأليف\s+|تاليف\s+)?(.+)$/i,
  /^(?:رواية|روايه|كتاب|قصة)\s+ل(?:ـ|ِ)?(.+)$/i,
  /^(?:مؤلف|المؤلف|الكاتب|للكاتب|للمؤلف|بقلم|تأليف|تاليف)\s*[:\-]?\s*(.+)$/i,
  /^(.+?)\s+(?:مؤلف|تأليف|تاليف)$/i,
];

// نمط «زي / مثل / شبيه»
const SIMILAR_PATTERNS: RegExp[] = [
  /^(?:حاجة|حاجه|شيء|شئ|كتاب|رواية|شي)\s*(?:زي|مثل|شبه|شبيه(?:ة)?|قريب\s*من|على\s*غرار)\s+(.+)$/i,
  /^(?:زي|مثل|شبه)\s+(.+)$/i,
  /^(?:كتب|روايات)\s*(?:زي|مثل)\s+(.+)$/i,
  /^(?:similar\s+to|like)\s+(.+)$/i,
];

// نوع أدبي بدون عنوان محدد
const GENRE_PATTERNS: { re: RegExp; id: string }[] = [
  { re: /^(?:رواية|روايات|كتب)?\s*(?:رعب|رعبية|مرعبة|horror)\b/i, id: "novel" },
  { re: /^(?:رواية|روايات)?\s*(?:رومانسي|رومانسية|حب|علاقات)\b/i, id: "novel" },
  { re: /^(?:رواية|روايات|كتب)?\s*(?:بوليس|جريمة|غموض|تشويق|detective)\b/i, id: "novel" },
  { re: /^(?:كتاب|كتب)?\s*(?:تطوير\s*ذات|تطوير\s*الذات|تنمية\s*بشرية|تحفيز|نجاح|عادات)\b/i, id: "selfhelp" },
  { re: /^(?:كتاب|كتب)?\s*(?:دين|ديني|إسلام|اسلام|فقه|سيرة\s*نبوية|قران|قرآن)\b/i, id: "religion" },
  { re: /^(?:كتاب|كتب)?\s*(?:تاريخ|تاريخي|سِيَر|سير)\b/i, id: "history" },
  { re: /^(?:كتاب|كتب)?\s*(?:علم\s*نفس|سيكول|psychology)\b/i, id: "psych" },
  { re: /^(?:كتاب|كتب)?\s*(?:فلسفة|فلسفي|philosophy)\b/i, id: "philosophy" },
  { re: /^(?:كتاب|كتب|ديوان)?\s*(?:شعر|شِعر|poetry)\b/i, id: "poetry" },
  { re: /^(?:كتاب|كتب)?\s*(?:علوم?|فيزياء|فضاء|كون|science)\b/i, id: "science" },
  { re: /^(?:رواية|روايات|أدب|ادب)\s*$/i, id: "novel" },
  { re: /^(?:تطوير\s*ذات|تنمية\s*بشرية)\s*$/i, id: "selfhelp" },
];

// مؤلفون مشهورون (مطابقة جزئية) — نُحوّل لوضع author
const FAMOUS_AUTHORS = [
  "نجيب محفوظ", "طه حسين", "إحسان عبد القدوس", "يوسف زيدان",
  "أحمد خالد توفيق", "عباس محمود العقاد", "المنفلوطي", "جبران خليل جبران",
  "دوستويفسكي", "تولستوي", "ماركيز", "أورويل", "هيمنجواي", "كامو",
  "دان براون", "باولو كويلو", "كويلو", "نزار قباني", "محمود درويش",
  "ابن القيم", "ابن تيمية", "الغزالي", "النووي", "الرافعي",
  "مصطفى محمود", "أنيس منصور", "توفيق الحكيم", "يوسف السباعي",
  "أجاثا كريستي", "كونان دويل", "ستيفن كينج",
];

const SUMMARY_HINT =
  /(?:لخص|لخّص|تلخيص|ملخص|ملخّص|اختصر|summary)/i;

function collapseSpaces(s: string): string {
  return s.replace(/\s{2,}/g, " ").trim();
}

/** إزالة حشو المحادثة دون تدمير العنوان */
export function stripConversationalShell(raw: string): string {
  let t = collapseSpaces(raw || "");
  if (!t) return t;

  // كرر بضع مرات للـ nested prefixes
  for (let i = 0; i < 4; i++) {
    let changed = false;
    for (const re of CHAT_PREFIXES) {
      const n = t.replace(re, "");
      if (n !== t && n.length >= 2) {
        t = n;
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const re of CHAT_SUFFIXES) {
    t = t.replace(re, "");
  }

  // "كتاب عن X" / "رواية عن X" → نبقي X أحياناً لكن نترك "عن" للبحث إن كان جزءاً من العنوان
  t = t.replace(/^(?:كتاب|رواية|روايه|قصة)\s+عن\s+/i, "");
  t = t.replace(/^عن\s+/i, "");

  // "تحميل ..." already handled elsewhere; keep light
  t = t.replace(/^(?:تحميل|تنزيل)\s+/i, "");

  return collapseSpaces(t);
}

function matchAuthor(text: string): string | null {
  for (const re of AUTHOR_PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) {
      let a = collapseSpaces(m[1]);
      a = a.replace(/^(?:ال)?(?:كاتب|مؤلف|دكتور|شيخ|أستاذ)\s+/i, "");
      if (a.length >= 3 && a.length <= 60) return a;
    }
  }
  // "نجيب محفوظ" وحده أو مع كلمة كتب
  for (const name of FAMOUS_AUTHORS) {
    if (text === name || text.includes(name)) {
      // لو النص كله المؤلف أو "كتب X"
      const only =
        collapseSpaces(text.replace(name, "").replace(TYPE_WORDS, "").replace(/^(?:ل|بقلم|تأليف)\s*/i, ""));
      if (!only || only.length < 2) return name;
      if (/^(?:كتب|روايات|مؤلفات)?\s*$/i.test(only)) return name;
    }
  }
  return null;
}

function matchSimilar(text: string): string | null {
  for (const re of SIMILAR_PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) {
      let s = collapseSpaces(m[1]);
      s = s.replace(TYPE_WORDS, "");
      if (s.length >= 2) return s;
    }
  }
  return null;
}

function matchGenre(text: string): string | null {
  for (const { re, id } of GENRE_PATTERNS) {
    if (re.test(text)) return id;
  }
  return null;
}

/**
 * فهم عميق محلي لاستعلام المستخدم.
 */
export function understandBookQuery(raw: string): UnderstoodQuery {
  const original = collapseSpaces(raw || "");
  if (!original) {
    return {
      original: "",
      searchQuery: "",
      mode: "title",
      wantsSummary: false,
      changed: false,
    };
  }

  const wantsSummary = SUMMARY_HINT.test(original);
  let t = stripConversationalShell(original);

  // ملخص: أزل كلمات الملخص من العنوان
  if (wantsSummary) {
    t = t
      .replace(/(?:لخص(?:لي)?|لخّص(?:\s*لي)?|تلخيص|ملخص|ملخّص|اختصر(?:لي)?)\s*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    t = stripConversationalShell(t);
  }

  // ── Similar ──
  const similarTo = matchSimilar(t);
  if (similarTo) {
    const suggestions = sampleBooksForGenre(
      // try genre of similar title later; use novel as soft default mix
      "novel",
      4,
    );
    // also put the similar title itself first for search
    redis.incr("tel:intent:similar").catch(() => {});
    return {
      original,
      searchQuery: similarTo,
      mode: "similar",
      wantsSummary,
      similarTo,
      suggestions: [similarTo, ...suggestions.filter((x) => x !== similarTo)].slice(0, 5),
      changed: true,
      note: `كتب مشابهة لـ «${similarTo.slice(0, 40)}»`,
    };
  }

  // ── Author ──
  const author = matchAuthor(t);
  if (author && (t.length <= author.length + 12 || /^(?:كتب|روايات|مؤلفات|رواية|كتاب)/i.test(t))) {
    redis.incr("tel:intent:author").catch(() => {});
    return {
      original,
      searchQuery: author,
      mode: "author",
      wantsSummary,
      author,
      changed: true,
      note: `كتب لـ «${author.slice(0, 40)}»`,
    };
  }

  // ── Genre discovery (no specific title) ──
  const genreId = matchGenre(t);
  if (genreId) {
    // لو فيه عنوان بعد النوع: "رواية أرض زيكولا" → title
    const withoutType = t.replace(TYPE_WORDS, "").trim();
    const looksLikeBareGenre =
      withoutType.length <= 18 ||
      /^(?:رعب|رومانسي|رومانسية|بوليس|جريمة|تطوير|تنمية|دين|ديني|تاريخ|علم\s*نفس|فلسفة|شعر|علوم?|أدب|ادب)/i.test(
        withoutType,
      );
    if (looksLikeBareGenre) {
      const suggestions = sampleBooksForGenre(genreId, 5);
      redis.incr("tel:intent:genre").catch(() => {});
      const label = GENRE_LABELS[genreId] || genreId;
      return {
        original,
        searchQuery: suggestions[0] || withoutType || t,
        mode: "genre",
        wantsSummary,
        genreId,
        suggestions,
        changed: true,
        note: `اقتراحات: ${label}`,
      };
    }
  }

  // ── Title path: strip type word only ──
  let title = t;
  // "رواية الخيميائي" → "الخيميائي" when remainder is long enough
  const strippedType = title.replace(TYPE_WORDS, "").trim();
  if (strippedType.length >= 3) title = strippedType;

  const changed = collapseSpaces(title) !== original;
  if (changed) redis.incr("tel:intent:stripped").catch(() => {});

  return {
    original,
    searchQuery: title || original,
    mode: "title",
    wantsSummary,
    changed,
  };
}

/** دمج فهم الاستعلام مع اسم موجود (idempotent) */
export function refineBookName(raw: string): {
  bookName: string;
  wantsSummary: boolean;
  mode: QueryMode;
  note?: string;
  suggestions?: string[];
  changed: boolean;
} {
  const u = understandBookQuery(raw);
  L.info("queryUnderstand", u.mode, {
    from: u.original.slice(0, 50),
    to: u.searchQuery.slice(0, 50),
    changed: u.changed,
  });
  return {
    bookName: u.searchQuery,
    wantsSummary: u.wantsSummary,
    mode: u.mode,
    note: u.note,
    suggestions: u.suggestions,
    changed: u.changed,
  };
}
