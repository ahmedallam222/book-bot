// Verify summaryHandler refunds the per-user quota on upstream errors.
//
// Static probes only — Redis/AI providers aren't available in CI, so
// we just confirm the wiring (refund function exists, is imported,
// and the catch block calls it on the right preconditions).

import { readFileSync } from "node:fs";

const summarySrc = readFileSync("server/bot/summary.ts", "utf8");
const handlerSrc = readFileSync("server/bot/summaryHandler.ts", "utf8");

let pass = 0, fail = 0;
function ok(name, cond)  { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}`); }

console.log("summaryHandler quota-refund on upstream failure:");

// 1. summary.ts exports the refund helper with the right signature.
ok(
  "S1a — summary.ts exports refundUserSummaryUsage",
  /export\s+async\s+function\s+refundUserSummaryUsage\s*\(/.test(summarySrc),
);
ok(
  "S1b — refundUserSummaryUsage takes (userId, premium)",
  /refundUserSummaryUsage\s*\(\s*[^)]*userId[^)]*premium/s.test(summarySrc),
);
ok(
  "S1c — refund early-returns for premium / disabled-cap",
  /refundUserSummaryUsage[\s\S]{0,500}?if\s*\(\s*premium\s*\|\|\s*SUMMARY_DAILY_LIMIT_FREE\s*<=\s*0\s*\)\s*return/.test(summarySrc),
);
ok(
  "S1d — refund decrements the same USAGE_PREFIX key",
  /refundUserSummaryUsage[\s\S]{0,500}?USAGE_PREFIX[\s\S]{0,200}?redis\.decr/.test(summarySrc),
);

// 2. summaryHandler.ts imports refundUserSummaryUsage from ./summary.
ok(
  "S2a — handler imports refundUserSummaryUsage",
  /from\s+["']\.\/summary\.js["'][\s\S]{0,500}?refundUserSummaryUsage/s.test(handlerSrc) ||
  /import[\s\S]{0,300}?refundUserSummaryUsage[\s\S]{0,200}?from\s+["']\.\/summary\.js["']/s.test(handlerSrc),
);

// 3. handler hoists `premium` and `usageConsumed` flags so catch can use them.
ok(
  "S3a — handler hoists `premium` outside try",
  /let\s+premium\s*(:\s*boolean)?\s*=\s*false\s*;[\s\S]{0,500}?try\s*{/.test(handlerSrc),
);
ok(
  "S3b — handler hoists `usageConsumed` flag",
  /let\s+usageConsumed\s*(:\s*boolean)?\s*=\s*false\s*;/.test(handlerSrc),
);
ok(
  "S3c — usageConsumed set true only when consume succeeded",
  /if\s*\(\s*!usage\.blocked\s*\)\s*usageConsumed\s*=\s*true/.test(handlerSrc),
);

// 4. catch block refunds when consumed.
ok(
  "S4a — catch refunds via refundUserSummaryUsage",
  /catch\s*\([^)]*\)\s*{[\s\S]{0,800}?if\s*\(\s*usageConsumed\s*\)[\s\S]{0,200}?refundUserSummaryUsage\s*\(\s*userId\s*,\s*premium\s*\)/.test(handlerSrc),
);
ok(
  "S4b — refund call is fire-and-forget (catch attached)",
  /refundUserSummaryUsage\s*\(\s*userId\s*,\s*premium\s*\)\s*\.catch\s*\(/.test(handlerSrc),
);

// 5. refund must be inside catch, not in the try / finally.
const catchBlock = handlerSrc.match(/catch\s*\([^)]*\)\s*{([\s\S]{0,1500}?)\n\s*}\s*finally/);
ok(
  "S5  — refund call is inside the catch (not finally)",
  !!catchBlock && /refundUserSummaryUsage/.test(catchBlock[1]),
);

// 6. premium-success path is NOT refunded — refund hides behind usageConsumed,
//    which is only flipped when consume succeeded for a non-premium user.
//    Premium callers go through checkAndConsumeUsage's early-return branch
//    (used=0, blocked=false) — they never set usageConsumed=true because
//    the flag is set right after consume returns blocked=false. Hmm —
//    actually premium WOULD set the flag too, but refund itself short-
//    circuits on premium=true so it's a no-op. Verify both halves:
ok(
  "S6a — refund early-return makes premium calls a no-op",
  /export\s+async\s+function\s+refundUserSummaryUsage[\s\S]{0,400}?if\s*\(\s*premium\s*\|\|/.test(summarySrc),
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
