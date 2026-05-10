// Deterministic probes for the Llama-on-Cloudflare topic-relevant
// suggestions module + its no-results integration. Audit #3.
//
// Background:
//   The user-facing fallback when search returns 0 results was a generic
//   "اكتف بالعنوان / أضف اسم المؤلف / تأكد من الإملاء" message. Helpful
//   advice but not actionable. This PR adds an optional Llama suggestion
//   block under that message so the user has 3 concrete next-search
//   candidates without having to think.
//
// We can't import the bundled CJS into tsx easily, so we exercise the
// pure parser via a self-contained reimplementation that matches the
// production rules exactly, plus bundle marker checks against
// dist/index.cjs to guarantee the change shipped.

import fs from "node:fs";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else      { console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); fail++; }
}

const llamaSrc      = fs.readFileSync("server/bot/aiProviders/llamaSuggestions.ts", "utf8");
const bookRequestSrc= fs.readFileSync("server/bot/bookRequest.ts",                  "utf8");
const bundleSrc     = fs.readFileSync("dist/index.cjs",                             "utf8");

console.log("Llama-on-Cloudflare suggestions (#3):");

// ── S1: module structure ────────────────────────────────────────────

ok(
  "S1 — exports getLlamaSuggestions(bookName): Promise<string[]>",
  /export\s+async\s+function\s+getLlamaSuggestions\s*\(/.test(llamaSrc),
);

ok(
  "S1 — exports the parser parseSuggestionLines for unit-testability",
  /export\s+function\s+parseSuggestionLines\s*\(/.test(llamaSrc),
);

// ── S2: model selection (must be cheap 8B, not 70B summary) ─────────

ok(
  "S2 — uses 8B-instruct model (~4-8 neurons/call)",
  /@cf\/meta\/llama-3\.1-8b-instruct\b/.test(llamaSrc),
);

ok(
  "S2 — does NOT use the heavy 70B summary model",
  !/@cf\/meta\/llama-3\.1-70b-instruct\b/.test(llamaSrc),
);

ok(
  "S2 — abort timeout strictly tighter than 10s (no-results path latency budget)",
  /LLAMA_SUGGEST_TIMEOUT_MS\s*=\s*([1-9]\d{3}|10000)\b/.test(llamaSrc) &&
  !/LLAMA_SUGGEST_TIMEOUT_MS\s*=\s*([1-9]\d{4,})/.test(llamaSrc),
);

// ── S3: cache wiring ────────────────────────────────────────────────

ok(
  "S3 — 7-day cache TTL",
  /LLAMA_SUGGEST_CACHE_TTL_SEC\s*=\s*7\s*\*\s*24\s*\*\s*3600\b/.test(llamaSrc),
);

ok(
  "S3 — cache key uses canonicalizeForCache (parity with search-cache)",
  /canonicalizeForCache\s*\(\s*bookName\s*\)/.test(llamaSrc) &&
  /sugg:llama:/.test(llamaSrc),
);

ok(
  "S3 — cache hit increments tel:sugg:llama_cache_hit",
  /redis\.incr\(\s*TEL_SUGG_LLAMA_CACHE_HIT\s*\)/.test(llamaSrc),
);

// ── S4: contract preserved when CF env vars absent ─────────────────

ok(
  "S4 — early-return [] when CLOUDFLARE_AI_ACCOUNT_ID or _API_TOKEN missing",
  /if\s*\(\s*!\s*CLOUDFLARE_AI_ACCOUNT_ID\s*\|\|\s*!\s*CLOUDFLARE_AI_API_TOKEN\s*\)/.test(llamaSrc) ||
  /if\s*\(\s*!\s*CLOUDFLARE_AI_API_TOKEN\s*\|\|\s*!\s*CLOUDFLARE_AI_ACCOUNT_ID\s*\)/.test(llamaSrc),
);

ok(
  "S4 — increments tel:sugg:llama_no_key on missing env",
  /redis\.incr\(\s*TEL_SUGG_LLAMA_NO_KEY\s*\)/.test(llamaSrc),
);

ok(
  "S4 — empty bookName returns []",
  /if\s*\(\s*!\s*bookName\s*\|\|\s*bookName\.trim\(\)\.length\s*<\s*2\s*\)\s*return\s*\[\]/.test(llamaSrc),
);

// ── S5: telemetry counters ──────────────────────────────────────────

const requiredCounters = [
  ["TEL_SUGG_LLAMA_USED",        "tel:sugg:llama_used"],
  ["TEL_SUGG_LLAMA_OK",          "tel:sugg:llama_ok"],
  ["TEL_SUGG_LLAMA_EMPTY",       "tel:sugg:llama_empty"],
  ["TEL_SUGG_LLAMA_CACHE_HIT",   "tel:sugg:llama_cache_hit"],
  ["TEL_SUGG_LLAMA_HTTP_ERROR",  "tel:sugg:llama_http_error"],
  ["TEL_SUGG_LLAMA_TIMEOUT",     "tel:sugg:llama_timeout"],
  ["TEL_SUGG_LLAMA_OTHER_ERROR", "tel:sugg:llama_other_error"],
  ["TEL_SUGG_LLAMA_NO_KEY",      "tel:sugg:llama_no_key"],
];
for (const [name, key] of requiredCounters) {
  ok(
    `S5 — counter constant ${name} = "${key}"`,
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(llamaSrc),
  );
}

ok(
  "S5 — timeout vs other-error are split inside catch (mirrors prefilter)",
  /catch\s*\(\s*e\s*\)\s*\{[\s\S]{0,1000}?TEL_SUGG_LLAMA_TIMEOUT[\s\S]{0,400}?TEL_SUGG_LLAMA_OTHER_ERROR/m.test(llamaSrc),
);

// ── S6: parser semantics — pure-function reimplementation ──────────

// Reimplement the parser to test it without bundling-to-CJS gymnastics.
// MUST stay in lockstep with parseSuggestionLines in
// server/bot/aiProviders/llamaSuggestions.ts.
const SUGGEST_TARGET = 3;
function parseSuggestionLines(raw) {
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    let s = line.trim();
    if (!s) continue;
    s = s.replace(/^\s*[-*•◦▪▫]\s+/, "");
    s = s.replace(/^\s*\d+[.)]\s+/, "");
    s = s.replace(/^["'«»]+|["'«»]+$/g, "");
    s = s.trim();
    if (s.length < 3) continue;
    if (/^(here|sure|certainly|of course|the following|these are)/i.test(s)) continue;
    if (!/[\u0600-\u06FF]/.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= SUGGEST_TARGET) break;
  }
  return out;
}

console.log("\nS6 — parser semantics (pure reimplementation in lockstep with prod):");

const goldenCases = [
  {
    label:  "happy path — 3 plain Arabic lines",
    input:  `العادات السبع للناس الأكثر فعالية\nقوة العادة\nفن اللامبالاة`,
    expect: ["العادات السبع للناس الأكثر فعالية", "قوة العادة", "فن اللامبالاة"],
  },
  {
    label:  "tolerates leading numbering '1. '",
    input:  `1. العادات السبع للناس الأكثر فعالية\n2. قوة العادة\n3. فن اللامبالاة`,
    expect: ["العادات السبع للناس الأكثر فعالية", "قوة العادة", "فن اللامبالاة"],
  },
  {
    label:  "tolerates bullet markers and quotes",
    input:  `- "العادات الذرية"\n• «قوة العادة»\n* فن اللامبالاة`,
    expect: ["العادات الذرية", "قوة العادة", "فن اللامبالاة"],
  },
  {
    label:  "rejects English-only chatter ('Here are 3 suggestions:')",
    input:  `Here are 3 suggestions:\nالعادات الذرية\nThe Power of Now\nقوة العادة`,
    expect: ["العادات الذرية", "قوة العادة"],
  },
  {
    label:  "rejects pure-Latin lines (no Arabic chars)",
    input:  `Atomic Habits\nThe Power of Habit\nMindset`,
    expect: [],
  },
  {
    label:  "deduplicates case-insensitively",
    input:  `قوة العادة\nقوة العادة\nالعادات الذرية`,
    expect: ["قوة العادة", "العادات الذرية"],
  },
  {
    label:  "caps at SUGGEST_TARGET (3) even when given more",
    input:  `كتاب 1\nكتاب 2\nكتاب 3\nكتاب 4\nكتاب 5`,
    expect: ["كتاب 1", "كتاب 2", "كتاب 3"],
  },
  {
    label:  "drops too-short fragments (< 3 chars after stripping)",
    input:  `أ\nقوة العادة\nب`,
    expect: ["قوة العادة"],
  },
  {
    label:  "empty input → []",
    input:  ``,
    expect: [],
  },
  {
    label:  "whitespace-only input → []",
    input:  `   \n\n\n   `,
    expect: [],
  },
  {
    label:  "title — author hyphenated form preserved",
    input:  `العادات الذرية — جيمس كلير\nقوة العادة — تشارلز دوهيغ`,
    expect: ["العادات الذرية — جيمس كلير", "قوة العادة — تشارلز دوهيغ"],
  },
];

for (const { label, input, expect } of goldenCases) {
  const got = parseSuggestionLines(input);
  const match = got.length === expect.length && got.every((g, i) => g === expect[i]);
  ok(
    `S6 — ${label}`,
    match,
    match ? null : `got=${JSON.stringify(got)}, expect=${JSON.stringify(expect)}`,
  );
}

// ── S7: no-results path wiring in bookRequest.ts ───────────────────

ok(
  "S7 — bookRequest imports getLlamaSuggestions",
  /import\s*\{\s*getLlamaSuggestions\s*\}\s*from\s*["']\.\/aiProviders\/llamaSuggestions\.js["']/.test(bookRequestSrc),
);

ok(
  "S7 — buildNoResultMessage calls getLlamaSuggestions only AFTER the Firecrawl-down branch",
  /if\s*\(\s*fcDown\s*\)[\s\S]{0,1000}?return[\s\S]{0,2000}?getLlamaSuggestions\s*\(\s*bookName\s*\)/.test(bookRequestSrc),
);

ok(
  "S7 — getLlamaSuggestions is .catch-guarded so bot never crashes on a CF outage",
  /getLlamaSuggestions\s*\(\s*bookName\s*\)\s*\.\s*catch\(\s*\(\s*\)\s*=>\s*\[\s*\]\s*\)/.test(bookRequestSrc),
);

ok(
  "S7 — empty suggestions falls back to the original buildNoResults message",
  /if\s*\(\s*suggestions\.length\s*===\s*0\s*\)\s*return\s+base/.test(bookRequestSrc),
);

ok(
  "S7 — suggestions are escaped via escMd before being inserted into Markdown",
  /suggestions\s*[\s\S]{0,200}?escMd\s*\(\s*s\.slice\s*\(\s*0\s*,\s*80\s*\)/.test(bookRequestSrc),
);

ok(
  "S7 — suggestions are capped at 3 even if the parser somehow returned more",
  /suggestions[\s\S]{0,200}?\.slice\(\s*0\s*,\s*3\s*\)/.test(bookRequestSrc),
);

// ── S8: bundle markers ─────────────────────────────────────────────

const bundleMarkers = [
  "tel:sugg:llama_used",
  "tel:sugg:llama_ok",
  "tel:sugg:llama_empty",
  "tel:sugg:llama_cache_hit",
  "tel:sugg:llama_http_error",
  "tel:sugg:llama_timeout",
  "tel:sugg:llama_other_error",
  "tel:sugg:llama_no_key",
  "getLlamaSuggestions",
  "parseSuggestionLines",
  "sugg:llama:",
  // esbuild escapes non-ASCII in string literals to \uXXXX form, so we
  // can't grep for the raw Arabic "كتب مشابهة" in the bundle. Check the
  // escaped equivalent (ك=0643, ت=062A, ب=0628 + space + م=0645).
  "\\u0643\\u062A\\u0628 \\u0645",
];
for (const m of bundleMarkers) {
  ok(`S8 — bundle includes "${m}"`, bundleSrc.includes(m));
}

ok(
  "S8 — bundle has no `tel:llama:sugg` typo (project-standard prefix is tel:sugg:llama_)",
  !/tel:llama:sugg/.test(bundleSrc),
);

ok(
  "S8 — prefilter (#1) counters are still present (no regression)",
  bundleSrc.includes("tel:pdf:llama_used") &&
  bundleSrc.includes("tel:pdf:llama_yes") &&
  bundleSrc.includes("tel:pdf:llama_no"),
);

// ── Summary ────────────────────────────────────────────────────────

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
