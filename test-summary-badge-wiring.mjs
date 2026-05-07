// ══════════════════════════════════════════════
// SUMMARY BADGE WIRING — regression check
// ══════════════════════════════════════════════
//
// Bug audit (2026-05-07): trackSummaryAndAward كان معرّف في
// badges.ts لكن مش متنادى من أي مكان. النتيجة: شارة 📘 ملخّصاتي
// (summary10) لن تُمنح أبداً.
//
// PR #103 يضيف الاستدعاء في summaryHandler.ts بعد deliverSummary.
// هذا الاختبار يضمن:
//   1. summaryHandler.ts يـ import trackSummaryAndAward
//   2. summaryHandler.ts يـ import buildNewBadgeMessage
//   3. trackSummaryAndAward يُستدعى في الـ handler (بعد deliverSummary)
//   4. buildNewBadgeMessage يُستدعى لو الشارة تم منحها
//
// نقرأ الكود مباشرة (مش imports) عشان الاختبار يبقى static.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT  = resolve(dirname(fileURLToPath(import.meta.url)));
const handler = readFileSync(`${ROOT}/server/bot/summaryHandler.ts`, "utf8");
const badges  = readFileSync(`${ROOT}/server/bot/badges.ts`, "utf8");

let pass = 0, fail = 0;
function check(name, cond, hint = "") {
  if (cond) { console.log(`[PASS] ${name}`); pass++; }
  else      { console.log(`[FAIL] ${name}${hint ? " — " + hint : ""}`); fail++; }
}

// ── S1: Imports present ──────────────────────────
console.log("=== S1: handler imports badge functions ===");
check("imports trackSummaryAndAward from ./badges.js",
  /import\s*\{[^}]*\btrackSummaryAndAward\b[^}]*\}\s*from\s*["']\.\/badges\.js["']/.test(handler),
  "expected `import { trackSummaryAndAward, … } from './badges.js'`");

check("imports buildNewBadgeMessage from ./badges.js",
  /import\s*\{[^}]*\bbuildNewBadgeMessage\b[^}]*\}\s*from\s*["']\.\/badges\.js["']/.test(handler),
  "expected `import { buildNewBadgeMessage, … } from './badges.js'`");

// ── S2: Function exists in badges.ts and exported ──
console.log("=== S2: trackSummaryAndAward is exported ===");
check("badges.ts exports trackSummaryAndAward",
  /export\s+async\s+function\s+trackSummaryAndAward/.test(badges),
  "expected `export async function trackSummaryAndAward(…)`");

check("badges.ts exports buildNewBadgeMessage",
  /export\s+async\s+function\s+buildNewBadgeMessage/.test(badges),
  "expected `export async function buildNewBadgeMessage(…)`");

// ── S3: trackSummaryAndAward is invoked ────────
console.log("=== S3: trackSummaryAndAward is invoked ===");
const callPattern = /trackSummaryAndAward\s*\(\s*userId\s*\)/;
check("handler calls trackSummaryAndAward(userId)",
  callPattern.test(handler),
  "expected `trackSummaryAndAward(userId)` call in handler");

// Should be AFTER deliverSummary (so we don't credit on failure path).
const deliverIdx = handler.indexOf("deliverSummary(bot");
const callIdx    = handler.search(callPattern);
check("trackSummaryAndAward call is after deliverSummary",
  deliverIdx > 0 && callIdx > deliverIdx,
  `deliverIdx=${deliverIdx}, callIdx=${callIdx} — call must follow successful delivery`);

// ── S4: buildNewBadgeMessage is invoked when badge returned ──
console.log("=== S4: buildNewBadgeMessage chained on badge ===");
check("buildNewBadgeMessage invoked",
  /buildNewBadgeMessage\s*\(/.test(handler),
  "expected `buildNewBadgeMessage(…)` call");

// Should be inside a then/await branch that handles a non-null badge.
const trackBlock = handler.split("trackSummaryAndAward")[1] || "";
check("buildNewBadgeMessage in track-and-award block",
  /buildNewBadgeMessage/.test(trackBlock.slice(0, 600)),
  "expected buildNewBadgeMessage in the same block as trackSummaryAndAward");

// ── S5: SUMMARY_THRESHOLD constant value ──────
// Verify the threshold is 10 (per spec).
console.log("=== S5: SUMMARY_THRESHOLD = 10 ===");
const thresholdMatch = badges.match(/SUMMARY_THRESHOLD\s*=\s*(\d+)/);
check("SUMMARY_THRESHOLD constant defined",
  !!thresholdMatch,
  "expected `const SUMMARY_THRESHOLD = N`");
if (thresholdMatch) {
  const n = parseInt(thresholdMatch[1], 10);
  check("SUMMARY_THRESHOLD = 10",
    n === 10,
    `expected 10, got ${n}`);
}

// ── Summary ──────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
