// Deterministic probes for mktbtypdf.com source addition (PR C).
// Does NOT import bot code (Redis init would hang). Replicates the
// resolver regex as a pure function and validates against:
//  1. real fetched HTML from a live mktbtypdf.com book page
//  2. synthetic HTML covering edge cases
//  3. URL pattern matching used by the resolver decision in downloadAndSend

import assert from "node:assert/strict";

// ── Replicated logic (must stay in sync with download.ts) ──

const MKTBTYPDF_LANDING_RE  = /mktbtypdf\.com\/book\//i;
const MKTBTYPDF_DOWNLOAD_RE = /mktbtypdf\.com\/download\/?\?id=(\d+)(?:&|&amp;)external=1/i;

function shouldExpandMktbtypdf(url) {
  return MKTBTYPDF_LANDING_RE.test(url);
}

function extractMktbtypdfId(html) {
  const m = html.match(MKTBTYPDF_DOWNLOAD_RE);
  return m ? m[1] : null;
}

// ── D1: URL pattern (which URLs trigger the resolver) ──

const urlCases = [
  // landing page → expand
  ["https://mktbtypdf.com/book/abc/",                                                    true],
  ["https://mktbtypdf.com/book/%d8%a3%d8%b1%d8%b6-%d8%b2%d9%8a%d9%83%d9%88%d9%84%d8%a7/", true],
  ["http://mktbtypdf.com/book/foo",                                                      true],
  ["https://www.mktbtypdf.com/book/bar",                                                 true],

  // already-resolved direct download URL → don't re-expand (would loop)
  ["https://mktbtypdf.com/download/?id=662&external=1", false],
  ["https://mktbtypdf.com/download?id=662&external=1",  false],

  // unrelated paths
  ["https://mktbtypdf.com/",                  false],
  ["https://mktbtypdf.com/?s=foo",            false],
  ["https://mktbtypdf.com/categories/x/",     false],
  ["https://mktbtypdf.com/author/x/",         false],
  ["https://mktbtypdf.com/library/",          false],

  // unrelated domain
  ["https://foulabook.com/book/abc",          false],
  ["https://hindawi.org/books/12345.pdf",     false],
];

let passed = 0;
let failed = 0;
console.log("─── D1: URL pattern (shouldExpandMktbtypdf) ───");
for (const [url, expected] of urlCases) {
  const actual = shouldExpandMktbtypdf(url);
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${url.slice(0, 75).padEnd(75)} → ${actual}  (expected ${expected})`);
  if (ok) passed++; else failed++;
}

// ── D2: Synthetic HTML extraction ──

const htmlCases = [
  // primary pattern (no slash)
  [`<a href="https://mktbtypdf.com/download?id=662&external=1">تحميل</a>`,           "662"],
  // with trailing slash
  [`<a href="https://mktbtypdf.com/download/?id=662&external=1">تحميل</a>`,          "662"],
  // HTML-escaped ampersand
  [`<a href="https://mktbtypdf.com/download?id=12345&amp;external=1">تحميل</a>`,     "12345"],
  // long id
  [`<a href="https://mktbtypdf.com/download?id=987654321&external=1">x</a>`,         "987654321"],
  // wrapped in noisy markup
  [`<button onclick="loc='https://mktbtypdf.com/download?id=42&external=1'">ت</button>`, "42"],

  // negatives — must NOT match
  [`<a href="https://mktbtypdf.com/download">تحميل</a>`,                              null],
  [`<a href="https://mktbtypdf.com/download?id=99">no external</a>`,                  null],
  [`<a href="https://example.com/download?id=662&external=1">unrelated</a>`,          null],
  [`<a href="https://mktbtypdf.com/download?id=abc&external=1">non-numeric id</a>`,   null],
  [`<a href="https://mktbtypdf.com/download?external=1&id=662">reversed-params</a>`,  null], // resolver only handles canonical order — this is acceptable since the site emits canonical order
  [``,                                                                                null],
];

console.log("\n─── D2: Synthetic HTML extraction (extractMktbtypdfId) ───");
for (const [html, expected] of htmlCases) {
  const actual = extractMktbtypdfId(html);
  const ok = actual === expected;
  const sample = html.length > 60 ? html.slice(0, 57) + "..." : html;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${sample.padEnd(60)} → ${JSON.stringify(actual)}  (expected ${JSON.stringify(expected)})`);
  if (ok) passed++; else failed++;
}

// ── D3: Live HTML probe — real book page ──
// "أرض زيكولا" → known to have id=662 (verified manually in setup).
// Adversarial: if the regex breaks because the site changes its markup,
// this test catches it before deploy.

console.log("\n─── D3: Live HTML probe (mktbtypdf.com/book/أرض-زيكولا) ───");
try {
  const url = "https://mktbtypdf.com/book/%d8%a3%d8%b1%d8%b6-%d8%b2%d9%8a%d9%83%d9%88%d9%84%d8%a7/";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; book-bot probe)" },
    signal: ctrl.signal,
    redirect: "follow",
  }).finally(() => clearTimeout(timer));

  if (!r.ok) {
    console.log(`  FAIL  HTTP ${r.status} — site may be down. Skipping live probe.`);
    failed++;
  } else {
    const html = (await r.text()).slice(0, 200_000);
    const id = extractMktbtypdfId(html);
    if (id && /^\d+$/.test(id)) {
      console.log(`  PASS  Live page → extracted id=${id} (regex matched real markup)`);
      passed++;
    } else {
      console.log(`  FAIL  Live page returned HTML but regex extracted no id. Site markup may have changed.`);
      failed++;
    }
  }
} catch (e) {
  console.log(`  FAIL  Live probe network error: ${String(e).slice(0, 80)}`);
  failed++;
}

// ── D4: Bundle marker check (post-build) ──
// Confirms tsx + esbuild emitted the new function name into dist/index.cjs.
// Catches: dead-code elimination, accidentally-not-imported function,
// build-order issue.

console.log("\n─── D4: Bundle marker check (dist/index.cjs) ───");
try {
  const fs = await import("node:fs");
  const bundle = fs.readFileSync("dist/index.cjs", "utf-8");
  // esbuild emits regex literals with backslash-escaped slashes. Arabic
  // strings (the human-readable source `name`) are tree-shaken out of
  // the production bundle since nothing in download.ts/engine.ts
  // references the name field — only `domain`. We verify the domain
  // string (which IS used at runtime) plus the resolver function name
  // and the regex shape.
  const checks = [
    ["expandMktbtypdfUrl",          1],
    ["mktbtypdf\\.com\\/book\\/",   1], // regex literal in bundled source
    ["mktbtypdf.com/download/?id=", 1], // template literal in bundled source
    ["mktbtypdf",                   3], // SKIP_DIRECT_DOMAINS + sources entry + resolver
  ];
  for (const [marker, minCount] of checks) {
    const count = (bundle.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    const ok = count >= minCount;
    console.log(`  ${ok ? "PASS" : "FAIL"}  marker "${marker}" found ${count} time(s) (expected ≥ ${minCount})`);
    if (ok) passed++; else failed++;
  }
} catch (e) {
  console.log(`  FAIL  bundle marker check error: ${String(e).slice(0, 80)}`);
  failed++;
}

console.log(`\n${passed}/${passed + failed} probes passed`);
process.exit(failed === 0 ? 0 : 1);
