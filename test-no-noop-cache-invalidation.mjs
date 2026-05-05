// Verify the dead `invalidateRecentSearchesCache()` no-arg calls were
// removed from bookRequest.ts. The function early-returns when called
// without an argument (engine.ts:62-68), so the calls did nothing —
// they were leftover from a refactor that changed the function from a
// global timestamp flag to a Redis cache-key deleter.

import { readFileSync } from "node:fs";

const bookReqSrc = readFileSync("server/bot/bookRequest.ts",   "utf8");
const engineSrc  = readFileSync("server/bot/engine.ts",        "utf8");
const callbackSrc = readFileSync("server/bot/callbacks.ts",    "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}`); }

console.log("Dead invalidateRecentSearchesCache() no-op cleanup:");

// 1. bookRequest.ts no longer calls invalidateRecentSearchesCache at all.
ok(
  "S1 — bookRequest.ts has zero calls to invalidateRecentSearchesCache",
  !/invalidateRecentSearchesCache\s*\(/.test(bookReqSrc),
);

// 2. The import on line 9 is cleaned up — only isFirecrawlDown remains.
ok(
  "S2 — bookRequest.ts engine import only includes isFirecrawlDown",
  /import\s*\{\s*isFirecrawlDown\s*\}\s*from\s*["']\.\/engine\.js["']/.test(bookReqSrc),
);
ok(
  "S2b — bookRequest.ts engine import does NOT include invalidateRecentSearchesCache",
  !/import\s*\{[^}]*invalidateRecentSearchesCache[^}]*\}\s*from\s*["']\.\/engine\.js["']/.test(bookReqSrc),
);

// 3. engine.ts still exports invalidateRecentSearchesCache for the
//    legitimate caller in callbacks.ts (bad_file handler).
ok(
  "S3 — engine.ts still exports invalidateRecentSearchesCache",
  /export\s+function\s+invalidateRecentSearchesCache\s*\(/.test(engineSrc),
);
ok(
  "S3b — engine.ts function still has the no-arg early-return guard",
  /export\s+function\s+invalidateRecentSearchesCache[\s\S]{0,200}?if\s*\(\s*!\s*bookName\s*\)\s*return/.test(engineSrc),
);

// 4. The legitimate caller (bad_file handler) still passes a bookName arg.
ok(
  "S4 — callbacks.ts still calls invalidateRecentSearchesCache(entry.bookName)",
  /invalidateRecentSearchesCache\s*\(\s*entry\.bookName\s*\)/.test(callbackSrc),
);

// 5. logSearch is still called on the success paths (we only removed
//    the no-op invalidate, not surrounding telemetry).
const successSites = bookReqSrc.match(/logSearch\(userId,\s*userName,\s*bookName,\s*true,\s*true,/g) || [];
ok(
  "S5 — bookRequest.ts still has 3 success-path logSearch calls (cache-fileId, cache-sourceUrl, fresh-download)",
  successSites.length === 3,
);

// 6. setLastBook still called on every success path.
const setLastBookSites = bookReqSrc.match(/setLastBook\(userId,\s*bookName\)/g) || [];
ok(
  "S6 — bookRequest.ts still has 3 setLastBook(userId, bookName) calls",
  setLastBookSites.length === 3,
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
