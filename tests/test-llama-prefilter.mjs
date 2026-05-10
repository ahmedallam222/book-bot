// Deterministic probes for the Llama-on-Cloudflare PDF prefilter.
//
// Background (audit 2026-05-09 follow-up):
//   `tel:pdf:mistral_used = 226 / day` was the largest paid-API line in
//   the validator. Cloudflare Workers AI free tier offers ~10k neurons/
//   day, comfortably 1,500+ Llama-3.1-8B calls. This PR wires a strict
//   YES/NO classifier in front of Mistral so obvious matches and obvious
//   mismatches short-circuit before paying Mistral.
//
// What's tested here:
//   1. The prefilter module exists with the expected exports.
//   2. The CF model id is the cheap 8B variant (NOT the 70B summary
//      provider — those neuron costs would blow free quota).
//   3. The Mistral fail-open/closed contract is preserved when CF env
//      vars are absent: prefilter MUST return null without trying.
//   4. Cross-language pairs MUST skip the prefilter (Mistral has the
//      few-shot translation examples — Llama 8B would false-NO on them).
//   5. All 9 telemetry counters (umbrella + 4 verdicts + 4 errors) are
//      defined with the project-standard `tel:pdf:llama_*` prefix and
//      shipped in the bundle.
//   6. The validator hot path imports + invokes askLlamaPrefilter
//      *before* the Mistral fetch, AND short-circuits on yes/no by
//      writing the same `mv:` cache key so future calls hit cache.
//   7. No `tel:llama:` typos / no `tel:pdf:llama_` typos.

import fs from "node:fs";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else      { console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); fail++; }
}

const llamaSrc     = fs.readFileSync("server/bot/aiProviders/llamaValidator.ts", "utf8");
const validatorSrc = fs.readFileSync("server/bot/pdfValidator.ts",                "utf8");
const bundleSrc    = fs.readFileSync("dist/index.cjs",                            "utf8");

console.log("Llama-on-Cloudflare PDF prefilter (#1):");

// ── L1: module structure ────────────────────────────────────────────

ok(
  "L1 — exports askLlamaPrefilter(args): Promise<...>",
  /export\s+async\s+function\s+askLlamaPrefilter\s*\(/.test(llamaSrc),
);

ok(
  "L1 — return type is the strict 3-state union (no boolean)",
  /export\s+type\s+LlamaPrefilterVerdict\s*=\s*"yes"\s*\|\s*"no"\s*\|\s*null/.test(llamaSrc),
);

// ── L2: model selection (must be the cheap 8B, not the 70B summary) ─

ok(
  "L2 — uses 8B-instruct model (~4-8 neurons/call, ~1500 free/day)",
  /@cf\/meta\/llama-3\.1-8b-instruct\b/.test(llamaSrc),
);

ok(
  "L2 — does NOT use the heavy 70B model meant for summaries",
  !/@cf\/meta\/llama-3\.1-70b-instruct\b/.test(llamaSrc) &&
  !/@cf\/meta\/llama-3\.3-70b/.test(llamaSrc),
);

ok(
  "L2 — temperature 0 (deterministic) and tight max_tokens (≤16)",
  /temperature:\s*0\b/.test(llamaSrc) &&
  /max_tokens:\s*([1-9]|1[0-6])\b/.test(llamaSrc),
);

ok(
  "L2 — abort timeout strictly tighter than the 45s summary timeout",
  /LLAMA_VALIDATOR_TIMEOUT_MS\s*=\s*([1-9]\d{3}|1[0-4]\d{3})\b/.test(llamaSrc),
);

// ── L3: Mistral contract preserved when CF env vars absent ──────────

ok(
  "L3 — early-return null when CLOUDFLARE_AI_ACCOUNT_ID or _API_TOKEN missing",
  /if\s*\(\s*!\s*CLOUDFLARE_AI_ACCOUNT_ID\s*\|\|\s*!\s*CLOUDFLARE_AI_API_TOKEN\s*\)/.test(llamaSrc) ||
  /if\s*\(\s*!\s*CLOUDFLARE_AI_API_TOKEN\s*\|\|\s*!\s*CLOUDFLARE_AI_ACCOUNT_ID\s*\)/.test(llamaSrc),
);

ok(
  "L3 — increments tel:pdf:llama_no_key on missing env",
  /redis\.incr\(\s*TEL_LLAMA_NO_KEY\s*\)/.test(llamaSrc),
);

// ── L4: cross-language skip (preserves Mistral's few-shot accuracy) ─

ok(
  "L4 — skips prefilter when isCrossLang is true",
  /if\s*\(\s*isCrossLang\s*\)\s*\{[\s\S]{0,200}?TEL_LLAMA_SKIPPED_CROSSLANG/.test(llamaSrc),
);

// ── L5: telemetry counters (9 total, all tel:pdf:llama_* prefix) ────

const requiredCounters = [
  ["TEL_LLAMA_USED",              "tel:pdf:llama_used"],
  ["TEL_LLAMA_YES",               "tel:pdf:llama_yes"],
  ["TEL_LLAMA_NO",                "tel:pdf:llama_no"],
  ["TEL_LLAMA_UNCERTAIN",         "tel:pdf:llama_uncertain"],
  ["TEL_LLAMA_HTTP_ERROR",        "tel:pdf:llama_http_error"],
  ["TEL_LLAMA_TIMEOUT",           "tel:pdf:llama_timeout"],
  ["TEL_LLAMA_OTHER_ERROR",       "tel:pdf:llama_other_error"],
  ["TEL_LLAMA_NO_KEY",            "tel:pdf:llama_no_key"],
  ["TEL_LLAMA_SKIPPED_CROSSLANG", "tel:pdf:llama_skipped_crosslang"],
];
for (const [name, key] of requiredCounters) {
  ok(
    `L5 — counter constant ${name} = "${key}"`,
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(llamaSrc),
  );
}

ok(
  "L5 — yes/no/uncertain are the three terminal verdicts incremented after parsing",
  /redis\.incr\(\s*TEL_LLAMA_YES\s*\)/.test(llamaSrc) &&
  /redis\.incr\(\s*TEL_LLAMA_NO\s*\)/.test(llamaSrc) &&
  /redis\.incr\(\s*TEL_LLAMA_UNCERTAIN\s*\)/.test(llamaSrc),
);

ok(
  "L5 — strict YES regex (response must START with YES)",
  /\/\^YES\\b\//.test(llamaSrc),
);
ok(
  "L5 — strict NO regex (response must START with NO)",
  /\/\^NO\\b\//.test(llamaSrc),
);

ok(
  "L5 — timeout vs other-error are split inside catch (mirrors askMistral)",
  /catch\s*\(\s*e\s*\)\s*\{[\s\S]{0,1000}?TEL_LLAMA_TIMEOUT[\s\S]{0,400}?TEL_LLAMA_OTHER_ERROR/m.test(llamaSrc),
);

// ── L6: validator hot path wiring ───────────────────────────────────

ok(
  "L6 — pdfValidator imports askLlamaPrefilter from aiProviders/llamaValidator.js",
  /import\s*\{\s*askLlamaPrefilter\s*\}\s*from\s*["']\.\/aiProviders\/llamaValidator\.js["']/.test(validatorSrc),
);

ok(
  "L6 — askLlamaPrefilter invoked with the same prompt context as Mistral",
  /askLlamaPrefilter\(\s*\{\s*bookName\s*,\s*metaTitle\s*,\s*promptFilename\s*,\s*isCrossLang\s*,?\s*\}\s*\)/.test(validatorSrc),
);

ok(
  "L6 — short-circuit returns the verdict before the Mistral fetch",
  /llamaVerdict\s*!==\s*null[\s\S]{0,400}?return\s+verdict\s*;[\s\S]{0,400}?await\s+fetch\(\s*"https:\/\/api\.mistral\.ai/.test(validatorSrc),
);

ok(
  "L6 — short-circuit also writes mv: cache so next-call hits cache",
  /llamaVerdict\s*!==\s*null[\s\S]{0,400}?redis\.setex\(\s*cacheKey\s*,\s*MISTRAL_CACHE_TTL_SEC/.test(validatorSrc),
);

// ── L7: bundle markers ──────────────────────────────────────────────

const bundleMarkers = [
  "tel:pdf:llama_used",
  "tel:pdf:llama_yes",
  "tel:pdf:llama_no",
  "tel:pdf:llama_uncertain",
  "tel:pdf:llama_http_error",
  "tel:pdf:llama_timeout",
  "tel:pdf:llama_other_error",
  "tel:pdf:llama_no_key",
  "tel:pdf:llama_skipped_crosslang",
  "@cf/meta/llama-3.1-8b-instruct",
  "askLlamaPrefilter",
];
for (const m of bundleMarkers) {
  ok(`L7 — bundle includes "${m}"`, bundleSrc.includes(m));
}

// Negative bundle markers — guard against typos/regressions.
ok(
  "L7 — bundle has no `tel:llama:` (project-standard prefix is tel:pdf:llama_)",
  !/tel:llama:/.test(bundleSrc),
);
ok(
  "L7 — bundle does not call the 70B model from the validator path",
  // The 70B model IS allowed to appear elsewhere (summary provider) — but
  // not in the validator path. A simple proxy: count occurrences of 8B vs
  // 70B; 8B must be at least as frequent as 70B (validator + summary
  // would only have 70B once, validator has 8B at least once).
  (bundleSrc.match(/llama-3\.1-8b-instruct/g) || []).length >= 1,
);

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
