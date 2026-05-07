#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────
// Root-level shim that delegates to the real test runner.
//
// Why this file exists:
//   - All deterministic tests live in `tests/test-*.mjs`.
//   - `npm test` (script/run-tests.mjs) is the authoritative runner.
//   - The CI workflow currently uses an inline shell loop:
//       `for t in test-*.mjs; do npx tsx "$t"; done`
//     Since there are no test-*.mjs at the repo root anymore, this
//     single-file shim keeps that loop functional: bash matches it,
//     CI invokes `npx tsx test-suite.mjs`, and we hand off to the
//     real runner.
//
// When the workflow file is updated to use `npm test` directly
// (requires the `workflow` OAuth scope to commit), this shim should
// be deleted in a follow-up PR.
// ──────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const res  = spawnSync("node", ["script/run-tests.mjs", ...process.argv.slice(2)], {
  cwd:   ROOT,
  stdio: "inherit",
  shell: false,
});
process.exit(res.status ?? 1);
