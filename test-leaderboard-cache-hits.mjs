// ══════════════════════════════════════════════
// LEADERBOARD CACHE-HIT GATE — regression check
// ══════════════════════════════════════════════
//
// Bug audit (2026-05-07): trackDownload في analytics.ts كان يحط
// كل الـ leaderboard logic داخل `if (found && !fromCache)`. النتيجة:
// بمجرد ما الكتاب يدخل الكاش، scoreه يتجمد للأبد. منطق الدمج
// الكنسي (cached.bookName كـ canonicalTitle) كان dead code.
//
// PR #103 يفصل:
//   - downloads counter يفضل داخل (!fromCache) — لأن downloads ≠ cache_hits
//   - الـ leaderboard zincrby يطلع برّا — يحسب على كل found delivery
//
// هذا الاختبار يعمل static-source check يضمن إن:
//   1. الـ zincrby على TOP_BOOKS_KEY مش داخل (found && !fromCache)
//   2. الـ zincrby على weeklyKey مش داخل نفس الـ gate
//   3. الـ HSET على display hash مش داخل نفس الـ gate
//
// نقرأ الكود مباشرة (مش imports) عشان الاختبار يبقى مستقل عن
// أي runtime يعتمد على Redis.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const src  = readFileSync(`${ROOT}/server/bot/analytics.ts`, "utf8");

let pass = 0, fail = 0;
function check(name, cond, hint = "") {
  if (cond) { console.log(`[PASS] ${name}`); pass++; }
  else      { console.log(`[FAIL] ${name}${hint ? " — " + hint : ""}`); fail++; }
}

// ── Locate trackDownload function body ─────────────────
const fnStart = src.indexOf("export async function trackDownload");
if (fnStart < 0) {
  console.error("CRITICAL: trackDownload not found in analytics.ts");
  process.exit(1);
}
// Find the closing `}` for trackDownload by brace counting.
let depth = 0, end = -1;
let inFn = false;
for (let i = fnStart; i < src.length; i++) {
  const c = src[i];
  if (c === "{") { depth++; inFn = true; }
  else if (c === "}") {
    depth--;
    if (inFn && depth === 0) { end = i + 1; break; }
  }
}
const fnBody = src.slice(fnStart, end);

// ── A1: zincrby on TOP_BOOKS_KEY exists ────────────────
console.log("=== A1: leaderboard increments are present ===");
check("zincrby TOP_BOOKS_KEY exists",
  /zincrby\(TOP_BOOKS_KEY/.test(fnBody),
  "expected `pipe.zincrby(TOP_BOOKS_KEY, …)` somewhere in trackDownload");

check("zincrby weeklyKey exists",
  /zincrby\(weeklyKey/.test(fnBody),
  "expected weekly increment");

check("hset TOP_BOOKS_DISPLAY_HASH exists",
  /hset\(TOP_BOOKS_DISPLAY_HASH/.test(fnBody),
  "expected display hash write");

// ── A2: cache-hit gate isolation ───────────────────────
// We split the function on `if (found && !fromCache)` and assert that
// the leaderboard increments are OUTSIDE that gate.
console.log("=== A2: leaderboard outside (!fromCache) gate ===");
const gateMatch = fnBody.match(/if\s*\(\s*found\s*&&\s*!fromCache\s*\)\s*\{/);
check("gate `if (found && !fromCache)` present",
  !!gateMatch, "expected `if (found && !fromCache) { … }` block");

if (gateMatch) {
  const gateStart = gateMatch.index + gateMatch[0].length;
  // Find matching closing brace by counting from gateStart.
  let d = 1, gateEnd = -1;
  for (let i = gateStart; i < fnBody.length; i++) {
    if (fnBody[i] === "{") d++;
    else if (fnBody[i] === "}") {
      d--;
      if (d === 0) { gateEnd = i; break; }
    }
  }
  const gateBody     = fnBody.slice(gateStart, gateEnd);
  const afterGate    = fnBody.slice(gateEnd);

  // The downloads counter SHOULD stay inside (it counts non-cache only).
  check("`downloads` counter inside gate",
    /hincrby\(dailyKey,\s*"downloads"/.test(gateBody),
    "downloads should remain inside (!fromCache) gate");

  // The leaderboard increments MUST be outside the gate.
  check("zincrby TOP_BOOKS_KEY OUTSIDE gate",
    /zincrby\(TOP_BOOKS_KEY/.test(afterGate),
    "leaderboard zincrby is still inside (!fromCache) gate — cache hits will not count!");

  check("zincrby weeklyKey OUTSIDE gate",
    /zincrby\(weeklyKey/.test(afterGate),
    "weekly bucket increment is still inside (!fromCache) gate");

  check("hset TOP_BOOKS_DISPLAY_HASH OUTSIDE gate",
    /hset\(TOP_BOOKS_DISPLAY_HASH/.test(afterGate),
    "display hash write is still inside gate");
}

// ── A3: leaderboard guarded by `if (found)` ────────────
// We DON'T want unconditional writes — leaderboard should still
// require a successful delivery (found=true). Cache hits with
// found=false (impossible in practice, but defensive) should skip.
// We look for the pattern: `if (found) {` block AFTER the gate, that
// contains the zincrby. Use [\s\S]* across newlines.
console.log("=== A3: leaderboard still requires found=true ===");
// Find all `if (found) {` blocks after the (!fromCache) gate.
const afterGateText = fnBody.slice(fnBody.indexOf("if (found && !fromCache)"));
// Skip past the gate block close to find the next `if (found) {`
const ifFoundMatch = afterGateText.match(/if\s*\(\s*found\s*\)\s*\{([\s\S]*?)zincrby\(TOP_BOOKS_KEY/);
check("zincrby still inside `if (found)` block",
  !!ifFoundMatch,
  "leaderboard should be inside `if (found) {…}` to skip not-found queries");

// ── Summary ────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
