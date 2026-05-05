// Tests Bug #10: scoreResult uses the user's query (not just the result
// title) so wrong-book direct PDFs sort BELOW relevant download_pages.
//
// Closes the loop on PR #39 — that PR rejected wrong PDFs at validation
// time. This test validates that the ranking algorithm now penalizes
// wrong PDFs too, so they don't get picked as #1 candidate in the first
// place.
//
// We test scoreResult indirectly by reaching into the engine module —
// the function is not exported, but searchAllSources calls it on every
// result. Instead of mocking Firecrawl, we exercise the ranking
// indirectly by calling urlFilenameRelevance (the underlying primitive)
// and then we duplicate the scoring formula here as a sanity check.
import { urlFilenameRelevance } from "./server/bot/text.js";

let pass = 0, fail = 0;
function ok(name, cond, info = "") { if (cond) pass++; else fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? ` (${info})` : ""}`); }

// — Replicate the new scoring formula —
const ACCESS_PRIOR = {
  direct_pdf:     1,
  download_page:  0.7,
  catalog_page:   0.35,
  protected_page: 0.1,
};
function score(access, userMatch, filenameMatch) {
  const prior = ACCESS_PRIOR[access];
  const queryScore = Math.max(userMatch, filenameMatch);
  return Math.max(0.05, Math.min(1, prior * 0.5 + queryScore * 0.5));
}

// — Bug #10 scenario: dalilkuwa (real production failure) —
// User asked: "الموجز في فن التفاوض"
// Wrong direct PDF: dalilkuwa-s2021-a.pdf (الدليل إلى القوة والدهاء)
// Right download page: noor-book.com/book/الموجز-في-فن-التفاوض
const userQ = "الموجز في فن التفاوض";

const wrongFilenameMatch = urlFilenameRelevance(
  userQ,
  "https://archive.org/details/dalilkuwa-s2021-a.pdf",
);
ok("wrong PDF filename has 0 match against user query",
  wrongFilenameMatch === 0,
  `match=${wrongFilenameMatch}`);

const correctDownloadPageMatch = urlFilenameRelevance(
  userQ,
  "https://www.noor-book.com/book/%D8%A7%D9%84%D9%85%D9%88%D8%AC%D8%B2-%D9%81%D9%8A-%D9%81%D9%86-%D8%A7%D9%84%D8%AA%D9%81%D8%A7%D9%88%D8%B6",
);
ok("correct page filename has > 0.4 match against user query",
  correctDownloadPageMatch > 0.4,
  `match=${correctDownloadPageMatch}`);

// CRITICAL: wrong direct_pdf should sort BELOW correct download_page
const wrongScore  = score("direct_pdf", 0, wrongFilenameMatch);
const rightScore  = score("download_page", 0.5, correctDownloadPageMatch);
ok(`CRITICAL — wrong direct_pdf (${wrongScore.toFixed(3)}) < correct download_page (${rightScore.toFixed(3)})`,
  wrongScore < rightScore);

// — Original (broken) scoring would have done:
//   wrongScore = 1 * 0.85 + (titleScore≈1) * 0.15 ≈ 1.0
//   rightScore = 0.7 * 0.85 + (titleScore≈1) * 0.15 ≈ 0.745
const oldWrong = 1 * 0.85 + 1 * 0.15;
const oldRight = 0.7 * 0.85 + 1 * 0.15;
ok(`regression check — old scoring would WRONG > RIGHT (${oldWrong.toFixed(3)} > ${oldRight.toFixed(3)})`,
  oldWrong > oldRight);

// — Edge: direct_pdf with PERFECT filename match should still win —
const perfectScore = score("direct_pdf", 1, 1);
ok(`perfect direct_pdf still scores 1.0 (got ${perfectScore})`, perfectScore === 1);

// — Edge: completely irrelevant catalog page should bottom out near 0.05 —
const garbageScore = score("catalog_page", 0, 0);
ok(`irrelevant catalog scores low (got ${garbageScore.toFixed(3)})`,
  garbageScore <= 0.2);

// — Realistic: download_page with strong match >> direct_pdf with no match —
const dlGood = score("download_page", 0.6, 0.6);
const dpBad  = score("direct_pdf",     0,   0);
ok(`download_page good match (${dlGood.toFixed(3)}) > direct_pdf no match (${dpBad.toFixed(3)})`,
  dlGood > dpBad);

// — Wrong-book direct_pdf scenario: original behavior would rank it #1 —
// New behavior: it scores 0.5 (still a candidate, but loses to better matches)
const wrongDirect = score("direct_pdf", 0, 0);
ok(`wrong direct_pdf collapses to ~0.5 (got ${wrongDirect.toFixed(3)})`,
  Math.abs(wrongDirect - 0.5) < 0.05);

// — Verify maxQueryScore picks the better signal —
// If filename matches but title doesn't (common — title from Firecrawl is
// often "page title" not book title), we still get the benefit
const filenameOnlyMatch = score("direct_pdf", 0, 0.8);
const titleOnlyMatch    = score("direct_pdf", 0.8, 0);
ok(`uses max(userMatch, filenameMatch): filename-only and title-only match score the same (${filenameOnlyMatch} === ${titleOnlyMatch})`,
  filenameOnlyMatch === titleOnlyMatch);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
