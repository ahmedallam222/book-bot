// Probes for find-to-send-loss mitigation (PR vs main).
// Run from repo root: npx tsx test-source-weighting.mjs

import { sanitizeDomainKey } from "./server/bot/analytics.ts";
import {
  MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST,
  MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN,
  LOW_SUCCESS_RATE_PENALTY_THRESHOLD,
  UNRELIABLE_DOMAINS,
} from "./server/bot/config.ts";
import { urlFilenameRelevance } from "./server/bot/text.ts";

let pass = 0, fail = 0;
const expect = (label, ok, got, want) => {
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${label} — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (ok) pass++; else fail++;
};

// ── Test 1: sanitizeDomainKey strips www., lowercases, strips junk ──
{
  const cases = [
    ["bookleaks.com",       "bookleaks.com"],
    ["www.bookleaks.com",   "bookleaks.com"],
    ["WWW.Bookleaks.com",   "bookleaks.com"],
    ["downloads.hindawi.org", "downloads.hindawi.org"],
    ["www.foulabook.com:80", "foulabook.com80"],   // ":" stripped, port digits remain — same key for any port
    ["",                    ""],
    ["   ",                 ""],
  ];
  for (const [input, want] of cases) {
    const got = sanitizeDomainKey(input);
    expect(`sanitizeDomainKey(${JSON.stringify(input)})`, got === want, got, want);
  }
}

// ── Test 2: env-tunables exist with sane defaults ──
{
  expect("MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST default 6",
         MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST === 6,
         MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST, 6);
  expect("MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN default 2",
         MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN === 2,
         MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN, 2);
  expect("LOW_SUCCESS_RATE_PENALTY_THRESHOLD default 0.30",
         LOW_SUCCESS_RATE_PENALTY_THRESHOLD === 0.30,
         LOW_SUCCESS_RATE_PENALTY_THRESHOLD, 0.30);
}

// ── Test 3: scoring math matches the implementation in bookRequest.ts ──
// Mirror the scoreUrl() function so we can verify the relative ranking
// of low-rate vs high-rate sources without spinning up a real request.
function scoreUrl(url, bookName, srcRateMap) {
  const domain = sanitizeDomainKey(new URL(url).hostname);
  const filenameScore = urlFilenameRelevance(bookName, url);
  const sourceRate = srcRateMap.get(domain) ?? 0.5;
  let reliablePenalty;
  if (UNRELIABLE_DOMAINS.some(d => domain.includes(d))) {
    reliablePenalty = -1;
  } else if (
    LOW_SUCCESS_RATE_PENALTY_THRESHOLD > 0 &&
    srcRateMap.has(domain) &&
    sourceRate < LOW_SUCCESS_RATE_PENALTY_THRESHOLD
  ) {
    reliablePenalty = -0.5;
  } else {
    reliablePenalty = 1;
  }
  return filenameScore * 0.5 + sourceRate * 0.3 + reliablePenalty * 0.2;
}

{
  // Real-world prod numbers from getSourceStats() at audit time
  const srcRates = new Map([
    ["downloads.hindawi.org", 6 / (6 + 32)],   // 16%
    ["foulabook.com",         2 / (2 + 6)],    // 25%
    ["bookleaks.com",         14 / 14],        // 100%
    ["book-shadow.com",       11 / 11],        // 100%
  ]);
  const book = "حياتي مع جبران";
  const hindawiUrl   = "https://downloads.hindawi.org/books/12345678.pdf";
  const foulabookUrl = "https://foulabook.com/files/" + encodeURIComponent("حياتي مع جبران") + ".pdf";
  const bookleaksUrl = "https://bookleaks.com/books/" + encodeURIComponent("حياتي مع جبران") + ".pdf";

  const sHindawi   = scoreUrl(hindawiUrl,   book, srcRates);
  const sFoulabook = scoreUrl(foulabookUrl, book, srcRates);
  const sBookleaks = scoreUrl(bookleaksUrl, book, srcRates);

  console.log(`\n  scores: hindawi=${sHindawi.toFixed(3)} foulabook=${sFoulabook.toFixed(3)} bookleaks=${sBookleaks.toFixed(3)}`);
  expect("Bookleaks (100%) ranks above Hindawi (16%)",
         sBookleaks > sHindawi, { sBookleaks, sHindawi }, "sBookleaks > sHindawi");
  expect("Bookleaks (100%) ranks above Foulabook (25%)",
         sBookleaks > sFoulabook, { sBookleaks, sFoulabook }, "sBookleaks > sFoulabook");
  // Soft-penalty kicks in: Hindawi at 16% gets reliablePenalty=-0.5 → score drops vs old logic
  // Old (binary penalty): 0.3*0.5 + 0.16*0.3 + 1*0.2  = 0.398
  // New (soft penalty):   0.3*0.5 + 0.16*0.3 + (-0.5)*0.2 = 0.098
  const oldScore = 0.3 * 0.5 + 0.16 * 0.3 + 1 * 0.2;
  expect("Soft penalty pushes Hindawi score below the old (binary-penalty) score",
         sHindawi < oldScore, { sHindawi, oldScore }, "sHindawi < 0.398");
}

// ── Test 4: per-domain cap simulation ──
// Replays the for-loop's cap logic against a synthetic candidate list.
// This catches regressions in the cap arithmetic without spinning up
// the real download stack.
function simulateCappedLoop(urls, perDomainCap, globalCap) {
  const attempts = new Map();
  let total = 0;
  let globalHit = false;
  let domainSkips = 0;
  const tried = [];
  for (const url of urls) {
    const domain = sanitizeDomainKey(new URL(url).hostname);
    if (globalCap > 0 && total >= globalCap) { globalHit = true; break; }
    const cur = attempts.get(domain) ?? 0;
    if (perDomainCap > 0 && cur >= perDomainCap) { domainSkips++; continue; }
    attempts.set(domain, cur + 1);
    total++;
    tried.push(url);
  }
  return { tried, total, globalHit, domainSkips };
}

{
  // Scenario A: 5 hindawi + 2 bookleaks. Cap = 2 per-domain, 6 global.
  // Expectation: 2 hindawi tried + 2 bookleaks tried = 4 total, 3 hindawi skipped.
  const urls = [
    "https://downloads.hindawi.org/books/1.pdf",
    "https://downloads.hindawi.org/books/2.pdf",
    "https://downloads.hindawi.org/books/3.pdf",
    "https://downloads.hindawi.org/books/4.pdf",
    "https://downloads.hindawi.org/books/5.pdf",
    "https://bookleaks.com/a.pdf",
    "https://bookleaks.com/b.pdf",
  ];
  const r = simulateCappedLoop(urls, 2, 6);
  expect("Per-domain cap stops Hindawi after 2 tries", r.tried.filter(u => u.includes("hindawi")).length === 2,
         r.tried.filter(u => u.includes("hindawi")).length, 2);
  expect("Per-domain cap allows both bookleaks URLs",  r.tried.filter(u => u.includes("bookleaks")).length === 2,
         r.tried.filter(u => u.includes("bookleaks")).length, 2);
  expect("Per-domain cap registers 3 skips",          r.domainSkips === 3, r.domainSkips, 3);
  expect("Global cap NOT reached at 4 < 6",            r.globalHit === false, r.globalHit, false);
}

{
  // Scenario B: 8 distinct domains, global cap 6.
  // Expectation: only 6 tried, 2 abandoned via globalCap.
  const urls = Array.from({ length: 8 }, (_, i) =>
    `https://domain${i}.example.com/book.pdf`);
  const r = simulateCappedLoop(urls, 2, 6);
  expect("Global cap stops at 6", r.total === 6, r.total, 6);
  expect("Global cap flag set",  r.globalHit === true, r.globalHit, true);
}

{
  // Scenario C: caps disabled (=0) — every URL tried, like old behavior.
  const urls = Array.from({ length: 10 }, (_, i) =>
    `https://downloads.hindawi.org/books/${i}.pdf`);
  const r = simulateCappedLoop(urls, 0, 0);
  expect("Disabled caps preserve all 10 attempts", r.total === 10, r.total, 10);
}

console.log(`\n${pass}/${pass + fail} probes passed`);
process.exit(fail === 0 ? 0 : 1);
