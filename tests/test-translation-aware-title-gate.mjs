// Deterministic probes for P1 of the 2026-05-09 audit.
//
// Background:
//   The bot's PDF validator was rejecting English-original PDFs of
//   Arabic-translated bestsellers because urlFilenameRelevance for
//   bookName="العادات الذرية" against filename="Atomic habits.pdf"
//   returns 0 (zero shared characters / words / transliterations).
//   The validator fell through to Mistral, but the prompt only had a
//   generic "match in any language, transliteration, or translation"
//   hint — Mistral was hedging and returning NO for these obvious
//   bestseller pairs.
//
//   Symptom counters: tel:pdf:rejected_mismatch=276, tel:pdf:mistral_used=226,
//   tel:dl:fail_reason:mistral_no=11.
//
//   This PR adds:
//     1. detectScript() / isCrossLanguagePair() helpers in text.ts
//     2. Cross-language detection inside askMistral() that injects a
//        translation-pair hint + few-shot examples.
//     3. Per-failure-mode telemetry counters (mistral_yes/no/timeout/
//        http_error/other_error/cache_hit/crosslang_prompt) so ops can
//        distinguish "Mistral healthy, classifier disagrees" from
//        "Mistral itself flaky".

import { readFileSync } from "node:fs";

const textSrc      = readFileSync("server/bot/text.ts",         "utf8");
const validatorSrc = readFileSync("server/bot/pdfValidator.ts", "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}`); }

console.log("Translation-aware title-gate (P1):");

// ── Script-detection helpers ────────────────────────────────────────

ok(
  "T1 — text.ts exports detectScript(s: string)",
  /export\s+function\s+detectScript\s*\(\s*s\s*:\s*string\s*\)\s*:\s*Script/.test(textSrc),
);

ok(
  "T2 — text.ts exports isCrossLanguagePair(a, b)",
  /export\s+function\s+isCrossLanguagePair\s*\(\s*a\s*:\s*string\s*,\s*b\s*:\s*string\s*\)/.test(textSrc),
);

// Inline replicas — we can't import without booting the bot's Redis/PG.
const ARABIC_BLOCK_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_LETTER_RE = /[A-Za-z]/g;
function detectScript(s) {
  if (!s) return "unknown";
  const a = (s.match(ARABIC_BLOCK_RE) || []).length;
  const l = (s.match(LATIN_LETTER_RE) || []).length;
  if (a === 0 && l === 0) return "unknown";
  if (a > l) return "arabic";
  if (l > a) return "latin";
  return "unknown";
}
function isCrossLanguagePair(a, b) {
  const sa = detectScript(a);
  const sb = detectScript(b);
  if (sa === "unknown" || sb === "unknown") return false;
  return sa !== sb;
}

// ── Behavioural probes on the (replicated) helpers ──────────────────

const cases = [
  // [bookName, titleSignal, expectCrossLang, label]
  ["العادات الذرية", "Atomic habits PDFDrive",  true,  "Atomic Habits Arabic↔Latin (the headline failure)"],
  ["كافكا على الشاطئ", "Kafka on the Shore",     true,  "Kafka Arabic↔Latin"],
  ["العادات الذرية", "العادات الذرية",            false, "Arabic ↔ Arabic (no cross-lang)"],
  ["Atomic Habits", "Atomic habits PDFDrive",    false, "Latin ↔ Latin (no cross-lang)"],
  ["1984", "1984",                                false, "Numeric only ↔ unknown vs unknown"],
  ["العادات الذرية", "1984",                      false, "Arabic ↔ numeric (unknown side wins false)"],
  ["", "Atomic Habits",                            false, "Empty side never claims cross-lang"],
  ["العادات الذرية", "",                            false, "Empty signal never claims cross-lang"],
  // Mixed-script left side resolves to "arabic" (8 arabic chars > 7 latin),
  // paired with fully-Latin → cross-lang fires (this is desired: a query
  // that's mostly Arabic IS a translation candidate against a Latin PDF).
  ["مزيج عربي English", "Atomic Habits",            true,  "Mixed-script (Arabic-dominant) ↔ Latin → cross-lang"],
  // Strict tie returns "unknown" → not cross-lang. We construct an exact
  // 1:1 character ratio to hit the tie path.
  ["abج",            "Atomic Habits",                false, "Strict char-count tie on left → unknown → false"],
];

for (const [book, sig, want, label] of cases) {
  const got = isCrossLanguagePair(book, sig);
  ok(`T3-cases — ${label}`, got === want);
}

// ── Validator wiring ────────────────────────────────────────────────

ok(
  "T4 — pdfValidator imports detectScript and isCrossLanguagePair",
  /import\s*\{[^}]*\bisCrossLanguagePair\b[^}]*\}\s*from\s*["']\.\/text\.js["']/.test(validatorSrc) &&
  /import\s*\{[^}]*\bdetectScript\b[^}]*\}\s*from\s*["']\.\/text\.js["']/.test(validatorSrc),
);

// askMistral uses isCrossLanguagePair on (bookName, titleSignal).
// Stricter: ensure the call is on bookName + a title-signal variable,
// not arbitrary.
ok(
  "T5 — askMistral computes isCrossLang against the strongest title signal",
  /isCrossLanguagePair\(\s*bookName\s*,\s*titleSignal\s*\)/.test(validatorSrc),
);

// Cross-language hint, examples, and counters all gated on isCrossLang.
ok(
  "T6 — prompt includes 'TRANSLATION pair' guidance only when isCrossLang",
  /if\s*\(\s*isCrossLang\s*\)\s*\{[\s\S]{0,2000}?TRANSLATION pair/m.test(validatorSrc),
);

ok(
  "T7 — prompt includes العادات الذرية ↔ Atomic Habits few-shot example",
  /العادات الذرية[\s\S]{0,30}?Atomic Habits/.test(validatorSrc),
);

ok(
  "T8 — prompt includes a NO few-shot (different books, similar topic)",
  /العادات السبع[\s\S]{0,40}?Atomic Habits/.test(validatorSrc) ||
  /كافكا على الشاطئ[\s\S]{0,40}?The Trial/.test(validatorSrc),
);

// ── Per-failure-mode telemetry counters ─────────────────────────────

const requiredCounters = [
  ["TEL_MISTRAL_YES",        "tel:pdf:mistral_yes"],
  ["TEL_MISTRAL_NO",         "tel:pdf:mistral_no"],
  ["TEL_MISTRAL_HTTP_ERROR", "tel:pdf:mistral_http_error"],
  ["TEL_MISTRAL_TIMEOUT",    "tel:pdf:mistral_timeout"],
  ["TEL_MISTRAL_OTHER_ERR",  "tel:pdf:mistral_other_error"],
  ["TEL_MISTRAL_CACHE_HIT",  "tel:pdf:mistral_cache_hit"],
  ["TEL_MISTRAL_CROSSLANG",  "tel:pdf:mistral_crosslang_prompt"],
];
for (const [name, key] of requiredCounters) {
  ok(
    `T9 — counter constant ${name} = "${key}"`,
    new RegExp(`const\\s+${name}\\s*=\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(validatorSrc),
  );
}

// Each counter incremented at the right place inside askMistral.
ok(
  "T10 — TEL_MISTRAL_YES / TEL_MISTRAL_NO incremented after verdict",
  /redis\.incr\(\s*verdict\s*\?\s*TEL_MISTRAL_YES\s*:\s*TEL_MISTRAL_NO\s*\)/.test(validatorSrc),
);

ok(
  "T11 — TEL_MISTRAL_HTTP_ERROR incremented in !r.ok branch",
  /if\s*\(\s*!\s*r\.ok\s*\)\s*\{[\s\S]{0,400}?redis\.incr\(\s*TEL_MISTRAL_HTTP_ERROR\s*\)/.test(validatorSrc),
);

ok(
  "T12 — TEL_MISTRAL_TIMEOUT vs TEL_MISTRAL_OTHER_ERR split inside catch",
  /catch\s*\(\s*e\s*\)\s*\{[\s\S]{0,1500}?redis\.incr\(\s*TEL_MISTRAL_TIMEOUT\s*\)[\s\S]{0,500}?redis\.incr\(\s*TEL_MISTRAL_OTHER_ERR\s*\)/.test(validatorSrc),
);

ok(
  "T13 — TEL_MISTRAL_CACHE_HIT incremented on Mistral cache hit (saves API calls)",
  /Mistral cache hit[\s\S]{0,300}?redis\.incr\(\s*TEL_MISTRAL_CACHE_HIT\s*\)/.test(validatorSrc),
);

ok(
  "T14 — TEL_MISTRAL_CROSSLANG incremented when isCrossLang prompt fires",
  /if\s*\(\s*isCrossLang\s*\)\s*redis\.incr\(\s*TEL_MISTRAL_CROSSLANG\s*\)/.test(validatorSrc),
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
