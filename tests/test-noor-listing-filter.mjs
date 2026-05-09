// Deterministic probes for P2 of the 2026-05-09 audit.
//
// Background:
//   For "العادات الذرية" the cache held 15 candidates. 14 of them were
//   noor-book.com /tag/<topic> listing pages (no .download-btn). They
//   ate the per-domain candidate cap and crowded out the real book
//   page. Same class affects /review/, /reviews/, /en/ebook-, /en/tag/,
//   /en/category/, etc.
//
//   noorBookResolver already had `isNonBookNoorUrl` for the *download*
//   path (refuse 30s Playwright wait on a doomed URL), but it was
//   unexported and engine.ts never consulted it during search → these
//   URLs entered the candidate set and ate cap.
//
// Fix:
//   1. Export isNonBookNoorUrl from noorBookResolver.ts.
//   2. Extend NON_BOOK_NOOR_PATTERNS to also cover /review[s], /en/*
//      catalog paths, and Arabic /مراجعة[ات]/ aliases.
//   3. Filter Firecrawl results in unifiedSearch BEFORE candidates
//      land in the ranker.
//   4. Filter cached results in searchAllSources so legacy poisoned
//      cache entries get cleaned passively.
//   5. Telemetry: tel:engine:noor_listing_filtered.

import { readFileSync } from "node:fs";

const noorSrc   = readFileSync("server/bot/noorBookResolver.ts", "utf8");
const engineSrc = readFileSync("server/bot/engine.ts",           "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}`); }

console.log("Noor-book listing filter (P2):");

// ── Export + behavioural probes ─────────────────────────────────────

ok(
  "T1 — isNonBookNoorUrl is exported (was internal)",
  /export\s+function\s+isNonBookNoorUrl\s*\(/.test(noorSrc),
);

// Replicate the logic locally — cheaper than importing (which would
// boot the bot's Redis / Playwright / Postgres).
const NON_BOOK_NOOR_PATTERNS = [
  /^\/tag\//i,
  /^\/category\//i,
  /^\/user\//i,
  /^\/author\//i,
  /^\/search(?:\?|\/|$)/i,
  /^\/البحث/,
  /^\/بحث(?:\?|\/|$)/,
  /^\/أحدث-/,
  /^\/الفئة\//,
  /^\/المستخدم\//,
  /^\/review(?:\/|$)/i,
  /^\/reviews(?:\/|$)/i,
  /^\/en\/ebook-/i,
  /^\/en\/category\//i,
  /^\/en\/tag\//i,
  /^\/en\/author\//i,
  /^\/en\/search(?:\?|\/|$)/i,
  /^\/مراجعة\//,
  /^\/مراجعات(?:\/|$)/,
];
function isNonBookNoorUrl(url) {
  try {
    const path = new URL(url).pathname;
    let decoded = path;
    try { decoded = decodeURIComponent(path); } catch {}
    return NON_BOOK_NOOR_PATTERNS.some((re) => re.test(decoded));
  } catch { return false; }
}

const reject = [
  // Pre-existing patterns (already covered, keep as regression):
  ["https://www.noor-book.com/tag/تنمية-بشرية",                  "tag listing"],
  ["https://www.noor-book.com/category/روايات-عربية",            "category listing"],
  ["https://www.noor-book.com/user/12345",                        "user profile"],
  ["https://www.noor-book.com/author/جمال-غيطاني",                "author profile"],
  ["https://www.noor-book.com/search?q=العادات الذرية",          "ascii search"],
  ["https://www.noor-book.com/البحث?q=الذرية",                   "Arabic search path"],
  ["https://www.noor-book.com/أحدث-الكتب",                       "newest-books page"],
  // P2 additions:
  ["https://www.noor-book.com/review/1234",                       "single review"],
  ["https://www.noor-book.com/review/12345/atomic-habits",        "review with slug"],
  ["https://www.noor-book.com/reviews",                           "reviews index"],
  ["https://www.noor-book.com/reviews/recent",                    "reviews subpath"],
  ["https://www.noor-book.com/en/ebook-self-help",                "English ebook listing"],
  ["https://www.noor-book.com/en/category/fiction",               "English category"],
  ["https://www.noor-book.com/en/tag/popular",                    "English tag"],
  ["https://www.noor-book.com/en/author/john-smith",              "English author"],
  ["https://www.noor-book.com/en/search?q=atomic",                "English search"],
  ["https://www.noor-book.com/مراجعة/كتاب-العادات-الذرية",       "Arabic review path"],
  ["https://www.noor-book.com/مراجعات",                           "Arabic reviews index"],
  // URL-encoded forms must also be caught:
  ["https://www.noor-book.com/%D8%A7%D9%84%D8%A8%D8%AD%D8%AB?q=x", "encoded /البحث"],
];

const accept = [
  ["https://www.noor-book.com/كتاب-العادات-الذرية-pdf",          "real book page (Arabic slug)"],
  ["https://www.noor-book.com/book/12345",                        "/book/<id> path (not listing)"],
  ["https://www.noor-book.com/كتاب-العادات-الذرية",              "real book page no -pdf suffix"],
  ["https://www.noor-book.com/",                                  "homepage (no path → not listing)"],
  // Note: isNonBookNoorUrl itself is host-agnostic (it would still
  // match /tag/* on a non-noor URL). The host gate lives upstream in
  // engine.ts (the wrapper isNoorListing). We only test the wrapper's
  // host-gating via T8 below.
];

for (const [url, label] of reject) {
  ok(`T2-reject — ${label}`, isNonBookNoorUrl(url) === true);
}
for (const [url, label] of accept) {
  ok(`T3-accept — ${label}`, isNonBookNoorUrl(url) === false);
}

// ── Engine wiring ────────────────────────────────────────────────────

ok(
  "T4 — engine.ts imports isNonBookNoorUrl from noorBookResolver",
  /import\s*\{[^}]*\bisNonBookNoorUrl\b[^}]*\}\s*from\s*["']\.\/noorBookResolver\.js["']/.test(engineSrc),
);

ok(
  "T5 — unifiedSearch drops noor-book listing URLs *before* the .map",
  /\.filter\(\s*\(\s*doc\s*\)\s*=>\s*\{[\s\S]{0,500}?host\s*!==?\s*["']noor-book\.com["'][\s\S]{0,300}?isNonBookNoorUrl/m.test(engineSrc) ||
  /noor-book\.com[\s\S]{0,500}?isNonBookNoorUrl[\s\S]{0,200}?return\s+false/m.test(engineSrc),
);

ok(
  "T6 — searchAllSources cache-read also filters noor-book listings",
  /cached\.length[\s\S]{0,1500}?isNoorListing/m.test(engineSrc),
);

ok(
  "T7 — telemetry counter `tel:engine:noor_listing_filtered` incremented",
  /tel:engine:noor_listing_filtered/.test(engineSrc),
);

ok(
  "T7b — counter is attributed only to noor drops (not all cache filter drops)",
  // Regression for Devin Review #134: must compute drop count from
  // isNoorListingResult specifically, not from the total filter
  // shrink which also includes isDisabled drops.
  /noorDropped\s*=\s*cached\.filter\(\s*isNoorListingResult\s*\)\.length/.test(engineSrc) &&
  /incrby\(\s*["']tel:engine:noor_listing_filtered["']\s*,\s*noorDropped/.test(engineSrc),
);

ok(
  "T8 — host gate ensures filter only applies to noor-book.com (no false positives on /tag on other sites)",
  /host\s*!==?\s*["']noor-book\.com["']/.test(engineSrc),
);

// ── Sanity: the real fix point inside unifiedSearch lives in the
//    Firecrawl filter chain, not somewhere else.

ok(
  "T9 — filter sits between isSlowDomain filter and .map (i.e. inside unifiedSearch)",
  /isSlowDomain\([\s\S]{0,1500}?noor-book\.com[\s\S]{0,1500}?\.map\(/m.test(engineSrc),
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
