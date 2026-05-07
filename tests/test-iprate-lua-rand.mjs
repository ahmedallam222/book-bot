// Probes for the ipRateLimit RNG-determinism fix.
//
// Background: Redis resets the Lua RNG seed before every EVAL (so scripts
// stay deterministic for replication). The previous slidingWindowGuardLua
// in ipRateLimit.ts called math.random() *inside* the Lua script, which
// meant every invocation produced the same number. Combined with a
// millisecond-precision `now`, concurrent requests landing in the same
// millisecond would all generate the SAME ZSET member, the second+ ZADD
// would be a no-op, and the IP rate limiter could be silently bypassed.
//
// We can't run real Redis here, but we can validate two things by reading
// the file:
//   I1 — The Lua script no longer calls math.random() (the source of the
//        non-uniqueness).
//   I2 — The Lua script reads `rand` from ARGV and uses it in the ZADD
//        member string (matches the pattern in rateLimit.ts).
//   I3 — The Node-side eval call passes a 4th argument (the random) to
//        the Lua script.
//
// This is the same testing style the repo already uses for other static
// guarantees (see test-cache-poison-defense.mjs).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here  = dirname(fileURLToPath(import.meta.url));
const path  = join(here, "../server/bot/ipRateLimit.ts");
const src   = readFileSync(path, "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.log(`  ✗ ${name} — ${detail}`); }
}

console.log("ipRateLimit Lua-RNG determinism fix:");

// I1: math.random must NOT appear inside the Lua script body. We allow
// the word in comments (Math.random in Node, e.g.) but not as a Lua call.
const luaBodyMatch = src.match(/const\s+slidingWindowGuardLua\s*=\s*`([\s\S]*?)`/);
check(
  "I1a — Lua script literal exists",
  Boolean(luaBodyMatch),
  "couldn't locate slidingWindowGuardLua template literal",
);
const luaBody = luaBodyMatch ? luaBodyMatch[1] : "";
check(
  "I1b — Lua body does not call math.random",
  !/math\.random\s*\(/.test(luaBody),
  "math.random( found inside Lua body — RNG would be deterministic across EVAL calls",
);

// I2: Lua reads ARGV[4] into a `rand` local and uses it in ZADD.
check(
  "I2a — Lua reads ARGV[4] into a local",
  /local\s+rand\s*=\s*ARGV\[4\]/.test(luaBody),
  "Lua script doesn't bind ARGV[4] → rand",
);
check(
  "I2b — Lua ZADD uses `rand` (not math.random)",
  /ZADD["'].*tostring\(now\)\s*\.\.\s*"-"\s*\.\.\s*rand/.test(luaBody),
  "ZADD member doesn't concatenate the Node-supplied rand",
);

// I3: Node call site passes 4th ARGV (the random) — matches rateLimit.ts.
check(
  "I3  — Node eval call passes Math.random as 4th ARGV",
  /String\(opts\.max\),\s*\n\s*String\(Math\.floor\(Math\.random\(\)\s*\*\s*1_000_000\)\)/.test(src),
  "the eval(...) call doesn't include Math.floor(Math.random() * 1_000_000) as the 4th ARGV",
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
