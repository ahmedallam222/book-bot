// Tests Bug #21 — `npm test` script + portable runner.
//
// Pre-fix: `npm test` exited with 1 ("Error: no test specified")
// because there was no test script. Local devs and CI workflows had
// to know to run `npx tsx test-foo.mjs` (a plain `node test-foo.mjs`
// fails with ERR_UNKNOWN_FILE_EXTENSION because the .mjs file imports
// `./server/bot/*.ts`). The CI workflow had an inline shell loop
// duplicating that knowledge.
//
// Post-fix: `script/run-tests.mjs` is the single source of truth.
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
ok("invokes tsx for each test",              /spawnSync\("npx", \["tsx", t\]/.test(runner));
ok("globs test-*.mjs",                       /startsWith\("test-"\)\s*&&\s*[^\n]*?endsWith\("\.mjs"\)/.test(runner));
ok("exits non-zero on failure",              /process\.exit\(1\)/.test(runner));
ok("supports TEST_FILTER env",               runner.includes("TEST_FILTER"));
ok("supports --keep-going flag",             runner.includes("--keep-going"));

// CI workflow integration is intentionally NOT asserted here:
// the OAuth app used for these PRs lacks the `workflow` scope so we
// can't modify .github/workflows/ci.yml from CI. The existing inline
// shell loop in CI still works with the new runner; updating CI to
// use `npm test` is an optional follow-up that has to be done in a
// separate PR with proper permissions.

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
