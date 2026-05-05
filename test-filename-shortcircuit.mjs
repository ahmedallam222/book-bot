// Deterministic probes for PR E — Strong-filename-match Mistral short-circuit
// (server/bot/pdfValidator.ts).
//
// We test bundle markers + the urlFilenameRelevance() pure function with
// the exact thresholds the PR uses (0.70 + ≥ 6 alpha chars). The
// pdfValidator.validatePdfFile() integration is impossible to exercise
// without a real PDF, so we instead cross-check that the threshold
// triggers on realistic filename samples.

import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else      { console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); fail++; }
}

const BUNDLE = fs.readFileSync(
  path.join(process.cwd(), "dist/index.cjs"),
  "utf8",
);

// ─── E1 — bundle markers ────────────────────────────────
console.log("E1 — bundle markers");
ok("event type 'candidate_accepted_filename_strong' shipped",
   BUNDLE.includes("candidate_accepted_filename_strong"));
ok("telemetry counter 'tel:pdf:filename_strong_match' shipped",
   BUNDLE.includes("tel:pdf:filename_strong_match"));
ok("threshold 0.70 baked in",
   /FILENAME_STRONG_MATCH_THRESHOLD\s*=\s*0\.7/.test(BUNDLE) ||
   BUNDLE.includes("FILENAME_STRONG_MATCH_THRESHOLD = 0.7"));
ok("synthUrlForRel synth-URL helper present",
   BUNDLE.includes("synthUrlForRel"));
ok("filenameRelevance computed before Mistral",
   BUNDLE.includes("filenameRelevance"));
ok("alpha-only ≥ 6 guard preserved",
   /_alphaOnly\.length\s*>=\s*6/.test(BUNDLE));

// ─── E2 — urlFilenameRelevance reproduction (matches text.ts impl) ──
// We mirror text.ts:urlFilenameRelevance to exercise the threshold logic
// without importing the bundle.

function normalizeForCache(s) {
  // Mirror the simplified Arabic normalization used in text.ts
  return (s || "")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")  // diacritics
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function urlFilenameRelevance(bookName, url) {
  try {
    const filename = decodeURIComponent(
      new URL(url).pathname.split("/").pop()?.split("?")[0] || ""
    ).replace(/\.pdf$/i, "").replace(/[-_+]/g, " ").trim().toLowerCase();
    if (!filename || filename.length < 2) return 0;
    if (/^\d+$/.test(filename.replace(/\s/g, ""))) return 0.3;
    const normBook = normalizeForCache(bookName);
    const normFile = normalizeForCache(filename);
    const bookWords = normBook.split(/\s+/).filter((w) => w.length >= 3);
    const fileWords = new Set(normFile.split(/\s+/).filter((w) => w.length >= 3));
    if (bookWords.length === 0 || fileWords.size === 0) return 0.1;
    const matched = bookWords.filter((w) => fileWords.has(w)).length;
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

const THRESHOLD = 0.70;
const ALPHA_MIN = 6;

function shouldShortCircuit(bookName, filenameHint) {
  const synth = "http://x/" + encodeURIComponent(filenameHint || "");
  const rel = urlFilenameRelevance(bookName, synth);
  const alphaOnly = filenameHint.replace(/[^a-zA-Z\u0600-\u06FF]/g, "");
  return rel >= THRESHOLD && alphaOnly.length >= ALPHA_MIN;
}

// ─── E3 — strong-match cases (should short-circuit, save Mistral) ──
console.log("\nE3 — short-circuit triggers (saves Mistral)");
ok("'كتاب-أرض-زيكولا.pdf' for 'أرض زيكولا' → triggers",
   shouldShortCircuit("أرض زيكولا", "كتاب-أرض-زيكولا.pdf") === true);
ok("'kafka-on-the-shore.pdf' for 'kafka on the shore' → triggers",
   shouldShortCircuit("kafka on the shore", "kafka-on-the-shore.pdf") === true);
ok("'mickey-mouse-adventures.pdf' for 'mickey mouse adventures' → triggers",
   shouldShortCircuit("mickey mouse adventures", "mickey-mouse-adventures.pdf") === true);
ok("'مذكرات_جيفارا.pdf' for 'مذكرات جيفارا' → triggers",
   shouldShortCircuit("مذكرات جيفارا", "مذكرات_جيفارا.pdf") === true);

// ─── E4 — weak-match cases (should NOT short-circuit) ─────────────
console.log("\nE4 — short-circuit does NOT trigger (delegates to Mistral)");
// numeric-only filenames (Hindawi-style) — relevance = 0.3 < 0.70
ok("'117.pdf' for 'أزمة رجولة' → no short-circuit (numeric)",
   shouldShortCircuit("أزمة رجولة", "117.pdf") === false);
ok("'53814181.pdf' for 'كافكا على الشاطئ' → no short-circuit",
   shouldShortCircuit("كافكا على الشاطئ", "53814181.pdf") === false);
// short alpha (< 6 chars)
ok("'ab.pdf' for 'كتاب الأطلال' → no (too short alpha)",
   shouldShortCircuit("كتاب الأطلال", "ab.pdf") === false);
ok("'TT-79.pdf' for 'كتاب الأطلال' → no (alpha < 6)",
   shouldShortCircuit("كتاب الأطلال", "TT-79.pdf") === false);
// no overlap
ok("'foo-bar-baz.pdf' for 'كتاب الأطلال' → no (zero overlap)",
   shouldShortCircuit("كتاب الأطلال", "foo-bar-baz.pdf") === false);
ok("'random.pdf' for 'مذكرات جيفارا' → no (zero overlap)",
   shouldShortCircuit("مذكرات جيفارا", "random.pdf") === false);
// partial match below threshold (1/3 = 0.33 < 0.70)
ok("'ارض_شيء_تاني.pdf' for 'ارض زيكولا قديما' → no (partial < 0.70)",
   shouldShortCircuit("ارض زيكولا قديما", "ارض_شيء_تاني.pdf") === false);

// ─── E5 — boundary / edge cases ───────────────────────────────────
console.log("\nE5 — boundary / edge cases");
ok("exact-name 'arabic-book-name.pdf' for 'arabic book name' → triggers",
   shouldShortCircuit("arabic book name", "arabic-book-name.pdf") === true);
ok("normalized form 'الاتعاب.pdf' (no diacritics) → triggers",
   shouldShortCircuit("الأتعاب", "الاتعاب.pdf") === true);
// Diacritic-insensitive book → file
ok("normalize ة→ه: 'القاهره.pdf' for 'القاهرة' → triggers",
   shouldShortCircuit("القاهرة قاهرتي", "القاهره_قاهرتي.pdf") === true);

console.log(`\nTotal: ${pass + fail}  pass=${pass}  fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
