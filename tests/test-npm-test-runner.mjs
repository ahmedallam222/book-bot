// Tests `npm test` script + portable runner.
//
// History: pre-fix, `npm test` exited with 1 because there was no test
// script. Local devs and CI workflows had to know to run
// `npx tsx test-foo.mjs` (plain `node` fails with
// ERR_UNKNOWN_FILE_EXTENSION because the .mjs files import
// `./server/bot/*.ts`). Post-fix: `script/run-tests.mjs` is the single
// source of truth, and tests live under `tests/` (moved from the repo
// root for a cleaner public-facing layout).
import fs from "fs";

let pass = 0, fail = 0;
function ok(name, cond, info = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? ` (${info})` : ""}`);
}

const pkg    = JSON.parse(fs.readFileSync("package.json", "utf-8"));
const runner = fs.readFileSync("script/run-tests.mjs", "utf-8");

// — package.json —
console.log("package.json scripts");
ok("test script present",        typeof pkg.scripts.test === "string" && pkg.scripts.test.length > 0);
ok("test points at runner",      pkg.scripts.test.includes("script/run-tests.mjs"));
ok("typecheck script present",   pkg.scripts.typecheck === "tsc --noEmit");
ok("test does not call npx tsx", !/npx tsx/.test(pkg.scripts.test),
   "the runner uses spawnSync internally; the script line itself is plain node");

// — runner script —
console.log("\nscript/run-tests.mjs");
ok("uses spawnSync from node:child_process", runner.includes('from "node:child_process"'));
ok("invokes tsx for each test",              /spawnSync\("npx", \["tsx", `tests\/\$\{t\}`\]/.test(runner));
ok("reads from tests/ directory",            /readdirSync\(TESTS_DIR\)/.test(runner));
ok("globs test-*.mjs",                       /startsWith\("test-"\)\s*&&\s*[^\n]*?endsWith\("\.mjs"\)/.test(runner));
ok("exits non-zero on failure",              /process\.exit\(1\)/.test(runner));
ok("supports TEST_FILTER env",               runner.includes("TEST_FILTER"));
ok("supports --keep-going flag",             runner.includes("--keep-going"));

// — CI workflow integration —
// CI now invokes `npm test` directly (the workflow file uses `run: npm test`),
// which delegates to script/run-tests.mjs. The previous root-level shim
// (test-suite.mjs) has been removed for a cleaner public-facing root.
console.log("\nCI workflow uses npm test directly");
const ci = fs.readFileSync(".github/workflows/ci.yml", "utf-8");
ok("workflow runs `npm test`",          /run:\s*npm test/.test(ci));
ok("no inline test-*.mjs glob loop",     !/for t in test-\*\.mjs/.test(ci));
ok("no root-level test-suite.mjs shim",  !fs.existsSync("test-suite.mjs"));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
