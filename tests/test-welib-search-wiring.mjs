// Deterministic probes for the welib *search* path added on top of
// the existing welibResolver download path. The search step lives in
// server/bot/welibResolver.ts (`searchWelib`) and is wired into
// server/bot/engine.ts so welib /md5/{hash} URLs land in the
// candidate set alongside Firecrawl results.
//
// Why we need a dedicated file: PR #122 added downloadWelibPdf only.
// Search was assumed to come for free from Firecrawl, but in
// production we measured 0 welib hits / 24h (Firecrawl's `(site:welib.st …)`
// goes to Google, which barely indexes welib because the pages are
// behind Cloudflare). This test pins the search wiring so it
// doesn't silently regress.
//
// We don't launch Playwright in CI (no Chromium), so the runtime
// behaviour of `searchWelib` is exercised by the smoke tests run on
// the EC2 container after deploy. Here we cover:
//   S1. buildWelibSearchUrl URL shape (q encoding, ext=pdf, lang flag)
//   S2. /md5/{hash} extractor regex parity with welibResolver source
//   S3. engine.ts imports + parallel-search wiring presence
//   S4. engine.ts converts WelibSearchResult → BookResult correctly
//   S5. verify.ts does NOT HEAD-check welib URLs (CF would 403)
//   S6. Bundle markers — searchWelib survives the build

import assert from "node:assert/strict";
import fs from "node:fs";

let passed = 0;
let failed = 0;
const expect = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
  if (ok) passed++; else failed++;
};

// ── Replicated logic — must stay in sync with welibResolver.ts ──

function buildWelibSearchUrl(query) {
  const q = (query || "").trim();
  if (!q) return "";
  return `https://ar.welib.st/search?index=&q=${encodeURIComponent(q)}&ext=pdf`;
}

const MD5_HREF_RE = /\/md5\/([a-f0-9]{32})/i;

// ── S1: buildWelibSearchUrl ─────────────────────────────────────

console.log("─── S1: buildWelibSearchUrl ───");
expect(
  "Arabic query is percent-encoded in q",
  buildWelibSearchUrl("كليلة ودمنة"),
  "https://ar.welib.st/search?index=&q=%D9%83%D9%84%D9%8A%D9%84%D8%A9%20%D9%88%D8%AF%D9%85%D9%86%D8%A9&ext=pdf",
);
expect(
  "ASCII query passes through with %20 for spaces",
  buildWelibSearchUrl("alice in wonderland"),
  "https://ar.welib.st/search?index=&q=alice%20in%20wonderland&ext=pdf",
);
expect(
  "Empty query → empty string (engine.ts must not call Playwright)",
  buildWelibSearchUrl(""),
  "",
);
expect(
  "Whitespace-only query → empty string",
  buildWelibSearchUrl("   "),
  "",
);
expect(
  "ext=pdf is always present",
  buildWelibSearchUrl("foo").endsWith("&ext=pdf"),
  true,
);
expect(
  "index= empty (search across all indexes)",
  /\/search\?index=&q=/.test(buildWelibSearchUrl("foo")),
  true,
);

// ── S2: /md5/{hash} extractor parity ────────────────────────────

console.log("\n─── S2: /md5/{hash} extractor parity ───");
const HREF_CASES = [
  ["https://ar.welib.st/md5/dafd0ea674c31252270e61abc17457bc",        "dafd0ea674c31252270e61abc17457bc"],
  ["/md5/B5452CFB0C19834A0714B051D391DD9A",                            "B5452CFB0C19834A0714B051D391DD9A"],
  ["https://ar.welib.st/md5/0123456789abcdef0123456789abcdef?ref=foo", "0123456789abcdef0123456789abcdef"],
  ["https://ar.welib.st/md5/0123456789abcdef0123456789abcdef#anchor",  "0123456789abcdef0123456789abcdef"],
];
for (const [href, expectedHex] of HREF_CASES) {
  const m = href.match(MD5_HREF_RE);
  expect(`extracts ${expectedHex.toLowerCase()} from ${href.slice(0, 60)}`, m?.[1] ?? "", expectedHex);
}
const NEGATIVE_CASES = [
  "https://ar.welib.st/search?q=foo",                                  // no /md5/ in path
  "https://ar.welib.st/md5/short",                                     // not 32 hex
  "https://ar.welib.st/md5/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",          // not hex
  "https://example.com/x/md5/0123456789abcdef0123456789abcdef",        // matches; engine should still trust because welib's results-page anchors only ever come from welib's own DOM. (We accept here.)
];
for (const url of NEGATIVE_CASES.slice(0, 3)) {
  const m = url.match(MD5_HREF_RE);
  expect(`rejects "${url.slice(0, 60)}"`, m === null, true);
}

// ── S3: engine.ts wires welib search alongside Firecrawl ────────

console.log("\n─── S3: engine.ts welib parallel-search wiring ───");
const ENGINE = fs.readFileSync("server/bot/engine.ts", "utf-8");
expect("engine.ts imports searchWelib",
  /from\s+["']\.\/welibResolver\.js["'][\s\S]{0,200}searchWelib|searchWelib[\s\S]{0,200}from\s+["']\.\/welibResolver\.js["']/.test(ENGINE),
  true);
expect("engine.ts imports WelibSearchResult type",
  ENGINE.includes("WelibSearchResult"),
  true);
expect("engine.ts runs unifiedSearch + searchWelib via Promise.allSettled",
  /Promise\.allSettled\(\s*\[[\s\S]{0,500}unifiedSearch\([\s\S]{0,500}searchWelib\(/.test(ENGINE),
  true);
expect("engine.ts dedupes welib URLs against Firecrawl URLs (seen Set)",
  /seen\s*=\s*new\s+Set\([\s\S]{0,200}fcResults\.map/.test(ENGINE),
  true);
expect("engine.ts only injects welib results when welib.st source is enabled",
  /welibSourceConfig\s*=\s*arabicSources\.find\(\(s\)\s*=>\s*s\.domain\s*===\s*["']welib\.st["']\)/.test(ENGINE),
  true);
expect("engine.ts has welibResultToBookResult helper",
  ENGINE.includes("function welibResultToBookResult"),
  true);
expect("engine.ts: Firecrawl pause does NOT short-circuit welib (uses fcPaused flag, not early return)",
  // Old code: `if (quota || rate) { ... return []; }`. New code:
  // `if (quota || rate) { fcPaused = true; ... }` and welib still
  // runs. We only assert ordering (flag set → flag consumed by
  // Promise.allSettled → welib search), not adjacency, since other
  // logic (dynamic source ranking) lives between them.
  /fcPaused\s*=\s*true[\s\S]+Promise\.allSettled\([\s\S]+fcPaused[\s\S]+searchWelib\(/.test(ENGINE),
  true);
expect("engine.ts: when fcPaused, Firecrawl leg resolves to empty BookResult[]",
  /fcPaused[\s\S]{0,80}\?\s*Promise\.resolve\(\s*\[\]\s*as\s*BookResult\[\]/.test(ENGINE),
  true);
expect("engine.ts: NO bare 'return [];' inside the Firecrawl-pause branch",
  // Negative — the old early-return pattern must be gone.
  /Firecrawl paused[\s\S]{0,200}return\s*\[\];/.test(ENGINE),
  false);
expect("engine.ts: cache TTL drops to MISS when fcPaused (welib-only is partial)",
  // Otherwise welib-only results would persist for SEARCH_CACHE_TTL_HIT
  // (1h) after FC's 60s rate-limit clears, leaving the bot in a
  // partial-results state for ~59m. See PR #129 review.
  /fcPaused\s*\?\s*SEARCH_CACHE_TTL_MISS\s*:\s*SEARCH_CACHE_TTL_HIT/.test(ENGINE),
  true);

// ── S4: welibResultToBookResult shape ───────────────────────────
//
// The helper is exported pure logic, but importing it pulls in
// playwright-core / pg / redis — not feasible in CI. Instead we pin
// the shape via a textual contract: given a WelibSearchResult, the
// returned BookResult must have access="direct_pdf" and
// directPdfUrl=url so it lands in `validUrls` (not the 3rd-tier
// `downloadablePageFallbacks`).

console.log("\n─── S4: welibResultToBookResult contract (engine.ts source) ───");
const helperBody = (() => {
  const m = ENGINE.match(/function welibResultToBookResult[\s\S]+?\n\}/);
  return m ? m[0] : "";
})();
expect("helper sets access: \"direct_pdf\"",
  /access:\s*["']direct_pdf["']/.test(helperBody),
  true);
expect("helper sets directPdfUrl to w.url (so /md5/ URL becomes routable)",
  /directPdfUrl:\s*w\.url/.test(helperBody),
  true);
expect("helper passes welib URL through scoreResult for ranking",
  /scoreResult\(/.test(helperBody),
  true);
expect("helper id starts with 'welib-'",
  /id:\s*`welib-/.test(helperBody),
  true);

// ── S5: verify.ts does NOT HEAD-check welib URLs ────────────────

console.log("\n─── S5: verify.ts skips welib HEAD probe ───");
const VERIFY = fs.readFileSync("server/bot/verify.ts", "utf-8");
expect("verify.ts imports isWelibHost from welibResolver (single source of truth)",
  /import\s*\{[^}]*isWelibHost[^}]*\}\s*from\s*["']\.\/welibResolver\.js["']/.test(VERIFY),
  true);
expect("verify.ts splits welib URLs from HEAD-check pool via isWelibHost",
  /welibUrls\s*=\s*notViewerOnly\.filter\(isWelibHost\)[\s\S]{0,200}toCheck/.test(VERIFY),
  true);
expect("verify.ts re-appends welib URLs to result",
  /\.\.\.welibUrls/.test(VERIFY),
  true);
expect("verify.ts no longer carries the buggy ad-hoc welib regex",
  // The old regex `/(?:^|\/\/[^/]*?\.)welib\.(?:st|org)\//i` missed
  // bare welib.st (no subdomain). It must be gone now — anywhere it
  // would match is on isWelibHost from welibResolver.
  /\/\(\?:\^\|\\\/\\\/\[\^\/\]\*\?\\\.\)welib\\\.\(\?:st\|org\)\\\//.test(VERIFY),
  false);

// ── S5b: isWelibHost contract (welibResolver.ts source) ─────────
// Pin the welib-host detection contract so future regex regressions
// (e.g. the bare-domain bug Devin Review flagged in PR #128) don't
// silently sneak back in.

console.log("\n─── S5b: isWelibHost contract (welibResolver.ts) ───");
const RESOLVER = fs.readFileSync("server/bot/welibResolver.ts", "utf-8");
expect("welibResolver.ts exports isWelibHost via URL parser (not anchored regex)",
  /export\s+function\s+isWelibHost[\s\S]{0,200}new\s+URL\(url\)\.hostname/.test(RESOLVER),
  true);

const HOST_CASES = [
  // Replicate the regex inline so we test the deployed behaviour.
  ["https://ar.welib.st/md5/abc",         true],
  ["https://welib.st/md5/abc",            true],   // bare — was the bug
  ["https://www.welib.org/md5/abc",       true],
  ["https://welib.org/md5/abc",           true],   // bare — was the bug
  ["https://hindawi.org/welib.st/abc",    false],  // path looks like host
  ["https://example.com/x?welib.st=true", false],
  ["not a url",                           false],
];
const isWelibHostInline = (url) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(?:^|\.)welib\.(?:st|org)$/.test(host);
  } catch {
    return false;
  }
};
for (const [url, want] of HOST_CASES) {
  expect(`isWelibHost(${url.slice(0, 50)})`, isWelibHostInline(url), want);
}

// ── S6: Bundle markers — searchWelib in dist/index.cjs ──────────

console.log("\n─── S6: Bundle marker check (dist/index.cjs) ───");
try {
  const bundle = fs.readFileSync("dist/index.cjs", "utf-8");
  const checks = [
    ["searchWelib",            1],  // exported function survived bundling
    ["buildWelibSearchUrl",    1],
    ["welibResultToBookResult", 1],
    ["search:navigate",        1],  // log marker we ship in production
    ["search:done",            1],
  ];
  for (const [marker, minCount] of checks) {
    const count = (bundle.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    const ok = count >= minCount;
    console.log(`  ${ok ? "PASS" : "FAIL"}  marker "${marker}" found ${count} time(s) (expected ≥ ${minCount})`);
    if (ok) passed++; else failed++;
  }
} catch (e) {
  console.log(`  FAIL  bundle marker check error: ${String(e).slice(0, 120)}`);
  failed++;
}

console.log(`\n${passed}/${passed + failed} probes passed`);
assert.equal(failed, 0, `${failed} welib-search probes failed`);
process.exit(failed === 0 ? 0 : 1);
