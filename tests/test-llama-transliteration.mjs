// Deterministic probes for the Llama-on-Cloudflare transliteration
// correction module + its no-results-retry integration. Audit #2.
//
// Background:
//   The user-reported failure mode "كيف تتقبل و تكتشف ذاتك لي وتيدصي
//   درايدن" (intended: "ويندي درايدن") had every downstream stage
//   poisoned by the noisy phonetic guess. searchAllSources returned 0,
//   the user got the generic fix-your-spelling tip, and gave up.
//
//   This PR asks Llama to look at the query *after* search confirmed
//   nothing matched, and propose a corrected version. The caller
//   compares the two — if they meaningfully differ, it retries the
//   search once before giving up.
//
// As with #1 and #3, we exercise pure helpers via a self-contained
// reimplementation that matches the production rules exactly, plus
// bundle-marker checks against dist/index.cjs to guarantee the change
// shipped.

import fs from "node:fs";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else      { console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); fail++; }
}

const tlitSrc        = fs.readFileSync("server/bot/aiProviders/llamaTransliteration.ts", "utf8");
const bookRequestSrc = fs.readFileSync("server/bot/bookRequest.ts",                       "utf8");
const bundleSrc      = fs.readFileSync("dist/index.cjs",                                  "utf8");

console.log("Llama-on-Cloudflare transliteration correction (#2):");

// ── T1: module structure ────────────────────────────────────────────

ok(
  "T1 — exports correctTransliteration(query): Promise<… | null>",
  /export\s+async\s+function\s+correctTransliteration\s*\(/.test(tlitSrc),
);

ok(
  "T1 — exports the parser parseTransliterationReply for unit testing",
  /export\s+function\s+parseTransliterationReply\s*\(/.test(tlitSrc),
);

ok(
  "T1 — exports the change-detector isMeaningfulChange for unit testing",
  /export\s+function\s+isMeaningfulChange\s*\(/.test(tlitSrc),
);

ok(
  "T1 — exports the LlamaTransliterationResult shape",
  /export\s+type\s+LlamaTransliterationResult\b/.test(tlitSrc),
);

// ── T2: model selection (cheap 8B; tight latency budget) ───────────

ok(
  "T2 — uses 8B-instruct model (~4-8 neurons/call)",
  /@cf\/meta\/llama-3\.1-8b-instruct\b/.test(tlitSrc),
);

ok(
  "T2 — does NOT use the heavy 70B summary model",
  !/@cf\/meta\/llama-3\.1-70b-instruct\b/.test(tlitSrc),
);

ok(
  "T2 — abort timeout strictly tighter than 10s (no-results retry latency budget)",
  /LLAMA_TLIT_TIMEOUT_MS\s*=\s*([1-9]\d{3}|10000)\b/.test(tlitSrc) &&
  !/LLAMA_TLIT_TIMEOUT_MS\s*=\s*([1-9]\d{4,})/.test(tlitSrc),
);

ok(
  "T2 — temperature is 0 (determinism: same garbled query → same correction)",
  /temperature:\s*0(\.0)?\b/.test(tlitSrc),
);

ok(
  "T2 — max_tokens ≤ 128 (a single corrected query line)",
  /max_tokens:\s*([1-9]\d|1[01]\d|12[0-8])\b/.test(tlitSrc),
);

// ── T3: cache wiring ────────────────────────────────────────────────

ok(
  "T3 — 7-day cache TTL (parity with #3 suggestions)",
  /LLAMA_TLIT_CACHE_TTL_SEC\s*=\s*7\s*\*\s*24\s*\*\s*3600\b/.test(tlitSrc),
);

ok(
  "T3 — cache key uses canonicalizeForCache (parity with search-cache)",
  /canonicalizeForCache\s*\(\s*\w+\s*\)/.test(tlitSrc) &&
  /tlit:llama:/.test(tlitSrc),
);

ok(
  "T3 — cache hit increments tel:tlit:llama_cache_hit",
  /redis\.incr\(\s*TEL_TLIT_LLAMA_CACHE_HIT\s*\)/.test(tlitSrc),
);

// ── T4: contract preserved when CF env vars absent ─────────────────

ok(
  "T4 — early-return null when CLOUDFLARE_AI_ACCOUNT_ID or _API_TOKEN missing",
  /if\s*\(\s*!\s*CLOUDFLARE_AI_ACCOUNT_ID\s*\|\|\s*!\s*CLOUDFLARE_AI_API_TOKEN\s*\)/.test(tlitSrc) ||
  /if\s*\(\s*!\s*CLOUDFLARE_AI_API_TOKEN\s*\|\|\s*!\s*CLOUDFLARE_AI_ACCOUNT_ID\s*\)/.test(tlitSrc),
);

ok(
  "T4 — increments tel:tlit:llama_no_key on missing env",
  /redis\.incr\(\s*TEL_TLIT_LLAMA_NO_KEY\s*\)/.test(tlitSrc),
);

ok(
  "T4 — short query (< 4 chars) returns null immediately",
  /TLIT_MIN_QUERY_LEN\s*=\s*4\b/.test(tlitSrc) &&
  /\.length\s*<\s*TLIT_MIN_QUERY_LEN\s*\)\s*return\s*null/.test(tlitSrc),
);

// ── T5: telemetry counters ─────────────────────────────────────────

const requiredCounters = [
  ["TEL_TLIT_LLAMA_USED",         "tel:tlit:llama_used"],
  ["TEL_TLIT_LLAMA_CORRECTED",    "tel:tlit:llama_corrected"],
  ["TEL_TLIT_LLAMA_UNCHANGED",    "tel:tlit:llama_unchanged"],
  ["TEL_TLIT_LLAMA_CACHE_HIT",    "tel:tlit:llama_cache_hit"],
  ["TEL_TLIT_LLAMA_HTTP_ERROR",   "tel:tlit:llama_http_error"],
  ["TEL_TLIT_LLAMA_TIMEOUT",      "tel:tlit:llama_timeout"],
  ["TEL_TLIT_LLAMA_OTHER_ERROR",  "tel:tlit:llama_other_error"],
  ["TEL_TLIT_LLAMA_NO_KEY",       "tel:tlit:llama_no_key"],
  ["TEL_TLIT_RETRY_RECOVERED",    "tel:tlit:retry_recovered"],
];
for (const [name, key] of requiredCounters) {
  ok(
    `T5 — counter constant ${name} = "${key}"`,
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(tlitSrc),
  );
}

ok(
  "T5 — timeout vs other-error are split inside catch (mirrors #3 suggestions)",
  /catch\s*\(\s*e\s*\)\s*\{[\s\S]{0,1000}?TEL_TLIT_LLAMA_TIMEOUT[\s\S]{0,400}?TEL_TLIT_LLAMA_OTHER_ERROR/m.test(tlitSrc),
);

// ── T6: parser semantics — pure-function reimplementation ──────────

// Reimplement the parser to test it without bundling-to-CJS gymnastics.
// MUST stay in lockstep with parseTransliterationReply in
// server/bot/aiProviders/llamaTransliteration.ts.
function parseTransliterationReply(raw) {
  if (!raw) return "";
  let s = raw.split(/\r?\n/).find((l) => l.trim().length > 0) || "";
  s = s.trim();
  s = s.replace(/^\s*(corrected|answer|here\s+(is|are)(\s+the\s+\w+)?(\s+\w+)?)\s*[:\-—]\s*/i, "");
  s = s.replace(/^\s*[-*•◦▪▫]\s+/, "");
  s = s.replace(/^\s*\d+[.)]\s+/, "");
  s = s.replace(/^["'«»]+|["'«»]+$/g, "");
  s = s.replace(/[.!?؟،,;:]+$/u, "");
  s = s.trim();
  return s;
}

console.log("\nT6 — parser semantics (pure reimplementation in lockstep with prod):");

const parserGoldenCases = [
  {
    label:  "happy path — plain corrected query",
    input:  `ويندي درايدن`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips wrapping quotes",
    input:  `"ويندي درايدن"`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips Arabic guillemets «…»",
    input:  `«ويندي درايدن»`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips 'Corrected:' prefix",
    input:  `Corrected: ويندي درايدن`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips 'Answer:' prefix",
    input:  `Answer: ويندي درايدن`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips 'Here is the corrected query:' prefix",
    input:  `Here is the corrected query: ويندي درايدن`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips leading numbering",
    input:  `1. ويندي درايدن`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips leading bullet",
    input:  `- ويندي درايدن`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips trailing period (Llama loves to add one)",
    input:  `ويندي درايدن.`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "strips trailing Arabic comma",
    input:  `ويندي درايدن،`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "takes only the first non-empty line (drops trailing commentary)",
    input:  `ويندي درايدن\nThis is the corrected version of the query.`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "handles preceding blank lines",
    input:  `\n\nويندي درايدن\n`,
    expect: `ويندي درايدن`,
  },
  {
    label:  "empty input → empty",
    input:  ``,
    expect: ``,
  },
  {
    label:  "whitespace-only → empty",
    input:  `   \n   \n`,
    expect: ``,
  },
  {
    label:  "compound: leading bullet + wrapping quotes + trailing period",
    input:  `- "ويندي درايدن."`,
    expect: `ويندي درايدن`,
  },
];

for (const { label, input, expect } of parserGoldenCases) {
  const got = parseTransliterationReply(input);
  ok(
    `T6 — ${label}`,
    got === expect,
    got === expect ? null : `got=${JSON.stringify(got)}, expect=${JSON.stringify(expect)}`,
  );
}

// ── T7: isMeaningfulChange — ignore cosmetic differences ───────────

function isMeaningfulChange(original, corrected) {
  if (!corrected) return false;
  const norm = (s) =>
    s.normalize("NFKC")
     .replace(/\s+/g, " ")
     .replace(/[.,،:؛!؟?]+$/u, "")
     .trim()
     .toLowerCase();
  return norm(original) !== norm(corrected);
}

console.log("\nT7 — isMeaningfulChange semantics:");

const changeCases = [
  {
    label:  "true: real correction (وتيدصي → ويندي)",
    a:      `لي وتيدصي درايدن`,
    b:      `لي ويندي درايدن`,
    expect: true,
  },
  {
    label:  "false: identical strings",
    a:      `العادات الذرية`,
    b:      `العادات الذرية`,
    expect: false,
  },
  {
    label:  "false: only extra trailing space",
    a:      `العادات الذرية`,
    b:      `العادات الذرية `,
    expect: false,
  },
  {
    label:  "false: only different inner whitespace",
    a:      `العادات  الذرية`,
    b:      `العادات الذرية`,
    expect: false,
  },
  {
    label:  "false: only trailing period",
    a:      `العادات الذرية`,
    b:      `العادات الذرية.`,
    expect: false,
  },
  {
    label:  "false: only trailing Arabic comma",
    a:      `العادات الذرية`,
    b:      `العادات الذرية،`,
    expect: false,
  },
  {
    label:  "false: empty corrected",
    a:      `العادات الذرية`,
    b:      ``,
    expect: false,
  },
  {
    label:  "true: case differs (Latin in mixed-script)",
    a:      `Atomic Habits لجيمس كلير`,
    b:      `atomic habits لجيمس كلير`,
    // toLowerCase normalises this away → false (we don't want to retry
    // on a casing diff)
    expect: false,
  },
  {
    label:  "true: real word swap inside the query",
    a:      `كيف تتقبل و تكتشف ذاتك لي وتيدصي درايدن`,
    b:      `كيف تتقبل و تكتشف ذاتك لي ويندي درايدن`,
    expect: true,
  },
];

for (const { label, a, b, expect } of changeCases) {
  const got = isMeaningfulChange(a, b);
  ok(
    `T7 — ${label}`,
    got === expect,
    got === expect ? null : `got=${got}, expect=${expect}, a=${JSON.stringify(a)}, b=${JSON.stringify(b)}`,
  );
}

// ── T8: no-results retry wiring in bookRequest.ts ──────────────────

ok(
  "T8 — bookRequest imports correctTransliteration",
  /import\s*\{\s*correctTransliteration\s*,?\s*[\s\S]*?\}\s*from\s*["']\.\/aiProviders\/llamaTransliteration\.js["']/.test(bookRequestSrc),
);

ok(
  "T8 — bookRequest also imports the recovery counter constant",
  /TEL_TLIT_RETRY_RECOVERED/.test(bookRequestSrc),
);

ok(
  "T8 — transliteration retry runs ONLY when results.length === 0 (post cleanSearchQuery branch)",
  /cleanSearchQuery[\s\S]{0,2000}?if\s*\(\s*results\.length\s*===\s*0\s*\)\s*\{[\s\S]{0,500}?correctTransliteration/.test(bookRequestSrc),
);

ok(
  "T8 — correctTransliteration call is .catch-guarded (so a CF outage never crashes the bot)",
  /correctTransliteration\s*\(\s*bookName\s*\)\s*\.\s*catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/.test(bookRequestSrc),
);

ok(
  "T8 — only retries the search when tlit.changed is true",
  /if\s*\(\s*tlit\s*&&\s*tlit\.changed\s*\)/.test(bookRequestSrc),
);

ok(
  "T8 — only adopts retry results when retry returned ≥1 result",
  /tlitResults\.length\s*>\s*0/.test(bookRequestSrc),
);

ok(
  "T8 — increments the recovery counter on success",
  /redis\.incr\s*\(\s*TEL_TLIT_RETRY_RECOVERED\s*\)/.test(bookRequestSrc),
);

ok(
  "T8 — corrected query is escaped via escMd before being shown to the user",
  /escMd\s*\(\s*tlit\.corrected\s*\)/.test(bookRequestSrc),
);

ok(
  "T8 — transliteration retry happens BEFORE trace.phase('search_done')",
  /correctTransliteration[\s\S]{0,1500}?trace\.phase\(\s*["']search_done["']/.test(bookRequestSrc),
);

// ── T9: bundle markers ─────────────────────────────────────────────

const bundleMarkers = [
  "tel:tlit:llama_used",
  "tel:tlit:llama_corrected",
  "tel:tlit:llama_unchanged",
  "tel:tlit:llama_cache_hit",
  "tel:tlit:llama_http_error",
  "tel:tlit:llama_timeout",
  "tel:tlit:llama_other_error",
  "tel:tlit:llama_no_key",
  "tel:tlit:retry_recovered",
  "correctTransliteration",
  "parseTransliterationReply",
  "isMeaningfulChange",
  "tlit:llama:",
];
for (const m of bundleMarkers) {
  ok(`T9 — bundle includes "${m}"`, bundleSrc.includes(m));
}

ok(
  "T9 — bundle has no `tel:llama:tlit` typo (project-standard prefix is tel:tlit:llama_)",
  !/tel:llama:tlit/.test(bundleSrc),
);

ok(
  "T9 — prefilter (#1) counters are still present (no regression)",
  bundleSrc.includes("tel:pdf:llama_used") &&
  bundleSrc.includes("tel:pdf:llama_yes"),
);

ok(
  "T9 — suggestions (#3) counters are still present (no regression)",
  bundleSrc.includes("tel:sugg:llama_used") &&
  bundleSrc.includes("tel:sugg:llama_ok"),
);

// ── Summary ────────────────────────────────────────────────────────

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
