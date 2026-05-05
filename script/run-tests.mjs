#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────
// Runs every `test-*.mjs` deterministic probe in the repo root via
// `tsx` (so the .mjs files can import .ts modules directly without
// pre-compilation). Bug #21 — pre-fix, `npm test` didn't exist and a
// plain `node test-foo.mjs` failed with ERR_UNKNOWN_FILE_EXTENSION
// when the test imported any `./server/bot/*.ts` source. CI worked
// around it via an inline shell loop; this script consolidates that
// into a portable, single-source-of-truth runner.
//
// Behaviour:
//   - Lists `test-*.mjs` in the repo root, alphabetical.
//   - Runs each in-band, prints a banner + a per-test PASS/FAIL line.
//   - Exits 0 only if all tests pass; first failure halts the run
//     unless --keep-going is passed (CI uses default to fail fast).
//   - Honours TEST_FILTER env (substring match) so devs can run a
//     subset locally: `TEST_FILTER=cache npm test`.
// ──────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT       = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP_GOING = process.argv.includes("--keep-going");
const FILTER     = process.env.TEST_FILTER || "";

const tests = readdirSync(ROOT)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
  .filter((f) => !FILTER || f.includes(FILTER))
  .sort();

if (tests.length === 0) {
  console.error(`No test-*.mjs files matched (filter='${FILTER}')`);
  process.exit(1);
}

console.log(`Running ${tests.length} test file${tests.length === 1 ? "" : "s"}` +
            (FILTER ? ` (filter='${FILTER}')` : ""));

const results = [];
const startAll = Date.now();
for (const t of tests) {
  const t0 = Date.now();
  console.log(`\n═══ ${t} ═══`);
  const res = spawnSync("npx", ["tsx", t], {
    cwd:   ROOT,
    stdio: "inherit",
    shell: false,
  });
  const ms     = Date.now() - t0;
  const passed = res.status === 0;
  results.push({ test: t, passed, ms });
  if (!passed && !KEEP_GOING) break;
}

const elapsed = Date.now() - startAll;
const failed  = results.filter((r) => !r.passed);
console.log(`\n────────────────────────────────────────────────`);
console.log(`Total: ${results.length}  ` +
            `pass=${results.length - failed.length}  ` +
            `fail=${failed.length}  ` +
            `elapsed=${(elapsed / 1000).toFixed(1)}s`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL  ${r.test}`);
  process.exit(1);
}
