// Deterministic probes for the Mistral-only catastrophic auto-disable tier
// (PR D — server/bot/analytics.ts mistralOnlyAutoDisabled).
//
// We can't import the bundled CJS into tsx easily, so we exercise the
// pure logic via a self-contained reimplementation that matches the
// production rules exactly, plus bundle marker checks against
// dist/index.cjs to guarantee the change shipped.

import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else      { console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); fail++; }
}

const BUNDLE = fs.readFileSync(
  path.join(process.cwd(), "dist/index.cjs"),
  "utf8",
);

// ─── D1 — bundle markers ────────────────────────────────
console.log("D1 — bundle markers");
ok("config: SOURCE_AUTO_DISABLE_MISTRAL_ONLY_MIN_REJECTS",
   BUNDLE.includes("SOURCE_AUTO_DISABLE_MISTRAL_ONLY_MIN_REJECTS"));
ok("config: SOURCE_AUTO_DISABLE_MISTRAL_ONLY_REJECT_RATIO",
   BUNDLE.includes("SOURCE_AUTO_DISABLE_MISTRAL_ONLY_REJECT_RATIO"));
ok("analytics: mistralOnlyAutoDisabled field exposed",
   BUNDLE.includes("mistralOnlyAutoDisabled"));
// esbuild escapes non-ASCII in output as \u{XXXX}; check for either form.
ok("admin: 💛 badge wired (yellow-heart for mistralOnly tier)",
   BUNDLE.includes("💛") || BUNDLE.includes("\\u{1F49B}"));
ok("env default 5 (MIN_REJECTS) baked in",
   /SOURCE_AUTO_DISABLE_MISTRAL_ONLY_MIN_REJECTS\s*\|\|\s*"5"/.test(BUNDLE));
ok("env default 2.0 (REJECT_RATIO) baked in",
   /SOURCE_AUTO_DISABLE_MISTRAL_ONLY_REJECT_RATIO\s*\|\|\s*"2\.0"/.test(BUNDLE));

// ─── D2 — pure logic (mirror of production rule) ─────────
//   rule = mr >= MIN_REJECTS && mr >= ok * REJECT_RATIO
console.log("\nD2 — disable logic (default thresholds: MIN=5, RATIO=2)");

const MIN_REJECTS = 5;
const REJECT_RATIO = 2.0;

function shouldMistralOnlyDisable(ok_, mr) {
  return mr >= MIN_REJECTS && mr >= ok_ * REJECT_RATIO;
}

// Real-prod-data cases (from /api/admin/stats/sources snapshot):
ok("dn790009.ca.archive.org (ok=0, mr=7)  → disabled",
   shouldMistralOnlyDisable(0, 7) === true);
ok("dn790006.ca.archive.org (ok=2, mr=5)  → disabled (5 >= 0, 5 >= 4)",
   shouldMistralOnlyDisable(2, 5) === true);
ok("dn790003.ca.archive.org (ok=0, mr=3)  → kept (3 < MIN)",
   shouldMistralOnlyDisable(0, 3) === false);
ok("dn790007.ca.archive.org (ok=4, mr=0)  → kept (0 rejects)",
   shouldMistralOnlyDisable(4, 0) === false);
ok("dn720806.ca.archive.org (ok=2, mr=0)  → kept (0 rejects)",
   shouldMistralOnlyDisable(2, 0) === false);
ok("hindawi.org (ok=15, mr=50)            → disabled (50 >= 30)",
   shouldMistralOnlyDisable(15, 50) === true);
ok("noor-book.com (ok=3, mr=3)            → kept (3 < MIN even with low ok)",
   shouldMistralOnlyDisable(3, 3) === false);
ok("foulabook.com (ok=11, mr=0)           → kept",
   shouldMistralOnlyDisable(11, 0) === false);

// Edge cases:
ok("ok=10, mr=5  → kept (5 < 10×2=20)",
   shouldMistralOnlyDisable(10, 5) === false);
ok("ok=2, mr=4   → kept (4 < MIN)",
   shouldMistralOnlyDisable(2, 4) === false);
ok("ok=0, mr=5   → disabled (boundary, 5 == MIN, 5 >= 0)",
   shouldMistralOnlyDisable(0, 5) === true);
ok("ok=2, mr=4   → kept (4 < MIN, even though ratio met)",
   shouldMistralOnlyDisable(2, 4) === false);
ok("ok=2.5, mr=5 → disabled (5 >= 5)",
   shouldMistralOnlyDisable(2.5, 5) === true);

// ─── D3 — independence from existing tiers ───────────────
console.log("\nD3 — orthogonality to existing tiers");

// HARD tier: total >= 5 AND rate = 0
function hardDisable(ok_, fail) {
  const total = ok_ + fail;
  return total >= 5 && (total > 0 ? ok_ / total : 0) <= 0.0;
}
// TRUST tier: totalWithRejects >= 10 AND mr > 0 AND trust <= 0.20
function trustDisable(ok_, fail, mr) {
  const tot = ok_ + fail + mr;
  const trust = tot > 0 ? ok_ / tot : 0;
  return tot >= 10 && mr > 0 && trust <= 0.20;
}

// Case dn790009: 0 ok, 0 fail, 7 mr
ok("dn790009 NOT caught by HARD (total=0)", hardDisable(0, 0) === false);
ok("dn790009 NOT caught by TRUST (totalWithRejects=7 < 10)",
   trustDisable(0, 0, 7) === false);
ok("dn790009 caught ONLY by Mistral-only tier",
   shouldMistralOnlyDisable(0, 7) === true);

// Case Hindawi: 15 ok, 34 fail, 50 mr
ok("Hindawi caught by TRUST (existing)", trustDisable(15, 34, 50) === true);
ok("Hindawi ALSO caught by Mistral-only (consistent)",
   shouldMistralOnlyDisable(15, 50) === true);

// Case archive.org: 37 ok, 0 fail, 0 mr (golden source)
ok("archive.org NOT caught by HARD",  hardDisable(37, 0) === false);
ok("archive.org NOT caught by TRUST", trustDisable(37, 0, 0) === false);
ok("archive.org NOT caught by Mistral-only (no rejects)",
   shouldMistralOnlyDisable(37, 0) === false);

// ─── D4 — env var override behavior (string defaults in bundle) ──
console.log("\nD4 — env var defaults in bundle");
ok("default MIN_REJECTS string is \"5\"",
   /MISTRAL_ONLY_MIN_REJECTS[\s\S]{0,80}"5"/.test(BUNDLE));
ok("default REJECT_RATIO string is \"2.0\"",
   /MISTRAL_ONLY_REJECT_RATIO[\s\S]{0,80}"2\.0"/.test(BUNDLE));

console.log(`\nTotal: ${pass + fail}  pass=${pass}  fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
