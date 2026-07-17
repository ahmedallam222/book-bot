// ══════════════════════════════════════════════
// QUERY NORMALIZE — light dialect + common typos
// Runs before parseBookName / search. Safe, conservative.
// ══════════════════════════════════════════════

/** Very common dialect intent prefixes → strip (leading only) */
const DIALECT_LEADING = /^(?:عايز|عاوز|عاوزه|عايزه|أبغى|ابغى|ابي|أبي|أريد|اريد|ممكن|جيب|أجيب|اجيب|بدي|ودي|بغيت|أبغى|ابحث\s*عن|دور\s*على|بدور\s*على|فين|فين\s*كتاب)\s+/i;

/** Phrase-level fixes (applied once, order matters) */
const PHRASE_FIXES: Array<[RegExp, string]> = [
  [/السي\s+الي\s+المكان/gi, "السعي إلى المكان"],
  [/السعي\s+الي\s+المكان/gi, "السعي إلى المكان"],
  [/ازدد\s*ثراء/gi, "ازدد ثراء"],
  [/فكر\s*و\s*ازدد/gi, "فكر وازدد"],
  [/العادات\s*الذرية/gi, "العادات الذرية"],
  [/ارض\s*زيكولا/gi, "أرض زيكولا"],
  [/أماريتا/gi, "أماريتا"],
  [/انا\s*كارنينا/gi, "آنا كارنينا"],
  [/آنا\s*كارينينا/gi, "آنا كارنينا"],
];

/** Single-token typo map (whole-word only) */
const WORD_FIXES: Record<string, string> = {
  "المكانه": "المكانة",
  "روايه": "رواية",
  "قصه": "قصة",
  "الي": "إلى", // careful: only via phrase or when between words - handled below
  "الى": "إلى",
  "الذريه": "الذرية",
  "العاده": "العادة",
  "ثرا": "ثراء",
};

/**
 * Light normalization for search quality. Does NOT invent titles.
 */
export function lightNormalizeQuery(raw: string): string {
  let t = (raw || "").replace(/\s+/g, " ").trim();
  if (!t) return t;

  // Strip dialect intent prefixes iteratively
  for (let i = 0; i < 3; i++) {
    const next = t.replace(DIALECT_LEADING, "").trim();
    if (next === t || next.length < 2) break;
    t = next;
  }

  for (const [re, rep] of PHRASE_FIXES) {
    t = t.replace(re, rep);
  }

  // Word-level fixes
  t = t
    .split(/\s+/)
    .map((w) => {
      const key = w.replace(/[^\u0600-\u06FFa-zA-Z0-9]/g, "");
      if (WORD_FIXES[key]) {
        // preserve trailing punctuation
        const trail = w.slice(key.length);
        return WORD_FIXES[key] + trail;
      }
      // standalone الي/الى → إلى when mid-phrase
      if (w === "الي" || w === "الى") return "إلى";
      return w;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return t;
}
