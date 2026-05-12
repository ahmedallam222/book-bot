// Pinning-test for the stale-cache TTL guard introduced in P0 of the
// 2026-05-09 audit.
//
// Background:
//   Between 2026-05-02 and the fix in commit 312373d, SEARCH_CACHE_TTL_HIT
//   was 3_600_000 (intended as "1h in ms") while Redis SETEX expects
//   seconds. The bug shipped sc:* keys with ~41.66-day TTLs. Audit
//   2026-05-09 found 72 popular queries (العادات الذرية، صحيح مسلم،
//   …) still alive with 33-37 days remaining → all served pre-welib
//   results, locking out the welib search wiring (PR #128) entirely.
//
//   The fix in this PR adds a TTL guard inside getSearchCacheResults
//   that drops any cache entry with TTL > SEARCH_CACHE_TTL_HIT + 60s,
//   forces a fresh search, and increments tel:cache:stale_ttl_dropped.
//
// What we pin (static source-text checks, no runtime imports — Redis
// access at module-load would break test):
//   T1 — getSearchCacheResults reads TTL via redis.ttl(key) before GET.
//   T2 — A constant STALE_CACHE_TTL_THRESHOLD_SEC is derived from
//        SEARCH_CACHE_TTL_HIT (not a hardcoded number) so a future
//        legitimate TTL bump doesn't silently re-enable the guard.
//   T3 — Threshold uses + 60 (the documented safety margin).
//   T4 — The stale branch increments tel:cache:stale_ttl_dropped so
//        operators can grep for recurrence of the bug.
//   T5 — The stale branch DELs the poisoned key (it would otherwise
//        keep poisoning every subsequent call until natural expiry).
//   T6 — Returns [] on stale, equivalent to a cache miss (the caller
//        must run a fresh search and overwrite the key with a correct
//        TTL, not return a degraded result).
//   T7 — explanatory comment context preserved.
//
// code review follow-up (PR #131 → this PR):
//   T8  — hasRecentSearchCache also applies the same TTL guard. Without
//         it the cache warmer (suggestions.ts:warmRelatedCache) sees
//         poisoned keys as "recent" and skips re-searching them — the
//         very queries the guard was meant to unblock would never get
//         proactively healed.
//   T9  — hasRecentSearchCache also DELs the poisoned key.
//   T10 — hasRecentSearchCache returns false (= "not recent") on stale,
//         equivalent semantics to the [] cache-miss return in
//         getSearchCacheResults.

import { readFileSync } from "node:fs";

const engineSrc = readFileSync("server/bot/engine.ts", "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}`); }

console.log("Stale-cache TTL guard (P0):");

// T1 — TTL read before GET inside getSearchCacheResults.
ok(
  "T1 — getSearchCacheResults reads ttl via redis.ttl(key) before redis.get",
  /export\s+async\s+function\s+getSearchCacheResults\s*\([\s\S]*?redis\.ttl\(\s*key\s*\)[\s\S]*?redis\.get\(\s*key\s*\)/m.test(engineSrc),
);

// T2 — threshold derives from SEARCH_CACHE_TTL_HIT (not a hardcoded literal).
ok(
  "T2 — STALE_CACHE_TTL_THRESHOLD_SEC derived from SEARCH_CACHE_TTL_HIT",
  /STALE_CACHE_TTL_THRESHOLD_SEC\s*=\s*SEARCH_CACHE_TTL_HIT\s*\+\s*60/.test(engineSrc),
);

// T3 — comparison against TTL is `> THRESHOLD`, not `>=` (boundary
// hygiene: a freshly-written 3600s key reads as 3600 or 3599 depending
// on race; the guard must let it through).
ok(
  "T3 — guard uses `ttl > STALE_CACHE_TTL_THRESHOLD_SEC`",
  /ttl\s*>\s*STALE_CACHE_TTL_THRESHOLD_SEC/.test(engineSrc),
);

// T4 — telemetry counter for stale drops.
ok(
  "T4 — tel:cache:stale_ttl_dropped counter incremented on drop",
  /redis\.incr\(\s*["']tel:cache:stale_ttl_dropped["']\s*\)/.test(engineSrc),
);

// T5 — poisoned key deleted (not just bypassed).
ok(
  "T5 — poisoned key deleted via redis.del(key) on stale path",
  /if\s*\(\s*ttl\s*>\s*STALE_CACHE_TTL_THRESHOLD_SEC\s*\)[\s\S]{0,400}?redis\.del\(\s*key\s*\)/.test(engineSrc),
);

// T6 — stale path returns [] (cache miss semantics).
ok(
  "T6 — stale branch returns [] (cache-miss fallback)",
  /if\s*\(\s*ttl\s*>\s*STALE_CACHE_TTL_THRESHOLD_SEC\s*\)[\s\S]{0,500}?return\s*\[\s*\]\s*;/.test(engineSrc),
);

// T7 — the comment block that documents *why* this guard exists is
// preserved. Future-proofs against someone deleting it during a
// refactor without realizing it's load-bearing context for ops.
ok(
  "T7 — explanatory comment mentions the 312373d ms-vs-seconds bug context",
  /312373d/.test(engineSrc) && /41\.66/.test(engineSrc),
);

// T8 — hasRecentSearchCache mirrors the TTL guard. The cache warmer
// uses this gate; without parity it skips re-warming poisoned queries.
ok(
  "T8 — hasRecentSearchCache reads ttl and applies STALE_CACHE_TTL_THRESHOLD_SEC guard",
  /export\s+async\s+function\s+hasRecentSearchCache\s*\([\s\S]*?redis\.ttl\(\s*key\s*\)[\s\S]*?ttl\s*>\s*STALE_CACHE_TTL_THRESHOLD_SEC/m.test(engineSrc),
);

// T9 — hasRecentSearchCache deletes the poisoned key on the stale path.
ok(
  "T9 — hasRecentSearchCache deletes poisoned key on stale path",
  /export\s+async\s+function\s+hasRecentSearchCache\s*\([\s\S]{0,1000}?if\s*\(\s*ttl\s*>\s*STALE_CACHE_TTL_THRESHOLD_SEC\s*\)[\s\S]{0,400}?redis\.del\(\s*key\s*\)/m.test(engineSrc),
);

// T10 — hasRecentSearchCache returns false on stale (cache-miss
// semantics: warmer must proceed to searchAllSources, which will
// overwrite with the correct TTL).
ok(
  "T10 — hasRecentSearchCache returns false on stale (cache-miss semantics)",
  /export\s+async\s+function\s+hasRecentSearchCache\s*\([\s\S]{0,1000}?if\s*\(\s*ttl\s*>\s*STALE_CACHE_TTL_THRESHOLD_SEC\s*\)[\s\S]{0,500}?return\s+false\s*;/m.test(engineSrc),
);

// T11 — hasRecentSearchCache also handles the "no key" / "no TTL"
// cases (ttl < 0) without misclassifying them as stale.
ok(
  "T11 — hasRecentSearchCache returns false on ttl < 0 (no key / persistent)",
  /export\s+async\s+function\s+hasRecentSearchCache\s*\([\s\S]{0,500}?if\s*\(\s*ttl\s*<\s*0\s*\)\s*return\s+false/m.test(engineSrc),
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
