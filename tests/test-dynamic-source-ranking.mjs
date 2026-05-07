// Tests dynamic source ranking — engine.ts now sorts ARABIC_SOURCES by
// recent rolling-window trustRate before passing the OR-list to Firecrawl.
//
// Sources with fewer than SOURCE_RANK_MIN_SAMPLES samples retain their
// static priority — protects new/quiet sources from being promoted or
// demoted on a single noisy attempt.
//
// Run from repo root: npx tsx test-dynamic-source-ranking.mjs
import fs from "fs";
import { rankSourcesByTrust } from "../server/bot/analytics.ts";
import { SOURCE_RANK_MIN_SAMPLES } from "../server/bot/config.ts";

let pass = 0, fail = 0;
const expect = (label, ok, got, want) => {
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${label} — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (ok) pass++; else fail++;
};

// ── Test 1: env-tunable default ───────────────────────────────────
{
  expect("SOURCE_RANK_MIN_SAMPLES default 3",
         SOURCE_RANK_MIN_SAMPLES === 3,
         SOURCE_RANK_MIN_SAMPLES, 3);
}

// ── Test 2: ranks by trustRate when samples ≥ minSamples ──────────
{
  const sources = [
    { domain: "low.com",    priority: 1 }, // bad veteran
    { domain: "mid.com",    priority: 2 },
    { domain: "high.com",   priority: 3 }, // best
  ];
  const stats = [
    { domain: "low.com",  trustRate: 0.10, totalWithRejects: 30 },
    { domain: "mid.com",  trustRate: 0.55, totalWithRejects: 30 },
    { domain: "high.com", trustRate: 0.95, totalWithRejects: 30 },
  ];
  const ranked = rankSourcesByTrust(sources, stats, 3).map(s => s.domain);
  expect("trust-ranked: high → mid → low",
         JSON.stringify(ranked) === JSON.stringify(["high.com", "mid.com", "low.com"]),
         ranked, ["high.com", "mid.com", "low.com"]);
}

// ── Test 3: insufficient-samples sources keep static priority ─────
{
  const sources = [
    { domain: "veteran-bad.com", priority: 5 }, // 12% over 30 samples
    { domain: "newcomer.com",    priority: 2 }, // 100% over 1 sample → unranked
    { domain: "veteran-ok.com",  priority: 1 }, // 90% over 30 samples
  ];
  const stats = [
    { domain: "veteran-bad.com", trustRate: 0.12, totalWithRejects: 30 },
    { domain: "newcomer.com",    trustRate: 1.00, totalWithRejects: 1  }, // below minSamples=3
    { domain: "veteran-ok.com",  trustRate: 0.90, totalWithRejects: 30 },
  ];
  const ranked = rankSourcesByTrust(sources, stats, 3).map(s => s.domain);
  // Expected order:
  //   ranked sources first (sorted by trustRate desc): veteran-ok, veteran-bad
  //   then unranked sources (static priority):         newcomer
  expect("low-samples newcomer NOT promoted above ranked veterans",
         JSON.stringify(ranked) === JSON.stringify(["veteran-ok.com", "veteran-bad.com", "newcomer.com"]),
         ranked, ["veteran-ok.com", "veteran-bad.com", "newcomer.com"]);
}

// ── Test 4: no stats at all → static priority preserved ───────────
{
  const sources = [
    { domain: "c.com", priority: 3 },
    { domain: "a.com", priority: 1 },
    { domain: "b.com", priority: 2 },
  ];
  const ranked = rankSourcesByTrust(sources, [], 3).map(s => s.domain);
  expect("empty stats → static priority order",
         JSON.stringify(ranked) === JSON.stringify(["a.com", "b.com", "c.com"]),
         ranked, ["a.com", "b.com", "c.com"]);
}

// ── Test 5: tiebreak on equal trustRate falls back to priority ────
{
  const sources = [
    { domain: "y.com", priority: 5 },
    { domain: "x.com", priority: 1 },
    { domain: "z.com", priority: 9 },
  ];
  const stats = [
    { domain: "y.com", trustRate: 0.50, totalWithRejects: 10 },
    { domain: "x.com", trustRate: 0.50, totalWithRejects: 10 },
    { domain: "z.com", trustRate: 0.50, totalWithRejects: 10 },
  ];
  const ranked = rankSourcesByTrust(sources, stats, 3).map(s => s.domain);
  expect("equal trustRate → tiebreak by static priority",
         JSON.stringify(ranked) === JSON.stringify(["x.com", "y.com", "z.com"]),
         ranked, ["x.com", "y.com", "z.com"]);
}

// ── Test 6: minSamples=0 disables threshold ────────────────────────
{
  const sources = [
    { domain: "veteran.com", priority: 1 },
    { domain: "lucky.com",   priority: 9 },
  ];
  const stats = [
    { domain: "veteran.com", trustRate: 0.80, totalWithRejects: 50 },
    { domain: "lucky.com",   trustRate: 1.00, totalWithRejects: 1  },
  ];
  const ranked = rankSourcesByTrust(sources, stats, 0).map(s => s.domain);
  expect("minSamples=0 → trustRate dominates regardless of sample count",
         JSON.stringify(ranked) === JSON.stringify(["lucky.com", "veteran.com"]),
         ranked, ["lucky.com", "veteran.com"]);
}

// ── Test 7: input array is not mutated ────────────────────────────
{
  const sources = [
    { domain: "b.com", priority: 2 },
    { domain: "a.com", priority: 1 },
  ];
  const before = sources.map(s => s.domain);
  rankSourcesByTrust(sources, [], 3);
  const after  = sources.map(s => s.domain);
  expect("input array unchanged after sort",
         JSON.stringify(before) === JSON.stringify(after),
         after, before);
}

// ── Test 8: production scenario (real domains observed in audit) ─
{
  // Approximate trust rates from prod audit: bookleaks 100%, foulabook 25%,
  // hindawi 17%, noor-book 33%, archive.org disabled (filtered out earlier).
  const sources = [
    { domain: "noor-book.com", priority: 2 },
    { domain: "hindawi.org",   priority: 3 },
    { domain: "foulabook.com", priority: 8 },
    { domain: "bookleaks.com", priority: 99 },
  ];
  const stats = [
    { domain: "noor-book.com", trustRate: 0.33, totalWithRejects: 12 },
    { domain: "hindawi.org",   trustRate: 0.17, totalWithRejects: 76 },
    { domain: "foulabook.com", trustRate: 0.25, totalWithRejects: 8  },
    { domain: "bookleaks.com", trustRate: 1.00, totalWithRejects: 14 },
  ];
  const ranked = rankSourcesByTrust(sources, stats, 3).map(s => s.domain);
  expect("prod scenario: bookleaks (100%) > noor (33%) > foulabook (25%) > hindawi (17%)",
         JSON.stringify(ranked) === JSON.stringify(["bookleaks.com", "noor-book.com", "foulabook.com", "hindawi.org"]),
         ranked, ["bookleaks.com", "noor-book.com", "foulabook.com", "hindawi.org"]);
}

// ── Test 9: engine.ts wires it through searchAllSources ───────────
{
  const ENGINE = fs.readFileSync("server/bot/engine.ts", "utf-8");
  expect("engine.ts imports rankSourcesByTrust",
         ENGINE.includes("rankSourcesByTrust"),
         ENGINE.includes("rankSourcesByTrust"), true);
  expect("engine.ts imports SOURCE_RANK_MIN_SAMPLES",
         ENGINE.includes("SOURCE_RANK_MIN_SAMPLES"),
         ENGINE.includes("SOURCE_RANK_MIN_SAMPLES"), true);
  expect("engine.ts calls getSourceStatsCached() before unifiedSearch",
         /getSourceStatsCached\(\)[\s\S]{0,300}rankSourcesByTrust[\s\S]{0,300}unifiedSearch/.test(ENGINE),
         true, true);
  expect("engine.ts wraps ranking in try/catch (graceful fallback)",
         /try\s*{[\s\S]{0,200}rankSourcesByTrust[\s\S]{0,200}}\s*catch/.test(ENGINE),
         true, true);
}

console.log(`\n────────────────`);
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
