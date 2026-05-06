// ════════════════════════════════════════════════════════════════
// PROGRESS WATCHDOG — timer arming + clearing semantics
// ════════════════════════════════════════════════════════════════
//
// نتأكد إن:
//   W1: armProgressWatchdog يحتفظ بـ timers active لـ msgId
//   W2: clearProgressWatchdog يمسحها (count = 0)
//   W3: استدعاء arm مرتين على نفس الـ msgId يستبدل (لا يتراكم)
//   W4: arm على msgId=0 لا يفعل شيء
//   W5: clear على msgId غير موجود — idempotent (لا يلقي error)
//   W6: watchdogs مختلفة لـ msgIds مختلفة تتعايش
//
// لاحظ: ما نختبر الـ editMsg الفعلي لأن دا بيتطلب network.
// نختبر بس لوجيك الـ Map + clear semantics. الفعل الـ network هو
// fire-and-forget داخل setTimeout — لو تم استدعاؤه فهو OK، لو
// مالم — clearTimeout يمنعه.

import {
  armProgressWatchdog,
  clearProgressWatchdog,
  _watchdogCount,
} from "./server/bot/progressWatchdog.ts";

let pass = 0, fail = 0;
function check(name, cond, want, got) {
  if (cond) { console.log(`[PASS] ${name}`); pass++; }
  else      { console.log(`[FAIL] ${name} — want=${JSON.stringify(want)} got=${JSON.stringify(got)}`); fail++; }
}

// stub args
const TOKEN = "fake-token";
const CHAT  = 12345;
const BOOK  = "تجربة";

// Clear any state from previous runs.
for (let i = 0; i < 20; i++) clearProgressWatchdog(i);

// ── W1 ─────────────────────────────────────────────────────────
const beforeArm = _watchdogCount();
armProgressWatchdog(TOKEN, CHAT, 1001, 0, BOOK);
check("W1a count after arm(1001) is +1",
  _watchdogCount() === beforeArm + 1, beforeArm + 1, _watchdogCount());

// ── W2 ─────────────────────────────────────────────────────────
clearProgressWatchdog(1001);
check("W2 count after clear(1001) returns to base",
  _watchdogCount() === beforeArm, beforeArm, _watchdogCount());

// ── W3 ─────────────────────────────────────────────────────────
armProgressWatchdog(TOKEN, CHAT, 2001, 0, BOOK);
const afterFirst = _watchdogCount();
armProgressWatchdog(TOKEN, CHAT, 2001, 1, BOOK);
const afterSecond = _watchdogCount();
check("W3 second arm same msgId does not increment count",
  afterSecond === afterFirst, afterFirst, afterSecond);
clearProgressWatchdog(2001);

// ── W4 ─────────────────────────────────────────────────────────
const beforeZero = _watchdogCount();
armProgressWatchdog(TOKEN, CHAT, 0, 0, BOOK);
check("W4 arm with msgId=0 is a no-op",
  _watchdogCount() === beforeZero, beforeZero, _watchdogCount());

// ── W5 ─────────────────────────────────────────────────────────
let threw = false;
try { clearProgressWatchdog(99999); } catch (e) { threw = true; }
check("W5 clear on unknown msgId does not throw", !threw, false, threw);

// ── W6 ─────────────────────────────────────────────────────────
const baseW6 = _watchdogCount();
armProgressWatchdog(TOKEN, CHAT, 3001, 0, BOOK);
armProgressWatchdog(TOKEN, CHAT, 3002, 0, BOOK);
armProgressWatchdog(TOKEN, CHAT, 3003, 0, BOOK);
check("W6 three distinct msgIds → +3 watchdogs",
  _watchdogCount() === baseW6 + 3, baseW6 + 3, _watchdogCount());

clearProgressWatchdog(3001);
clearProgressWatchdog(3002);
clearProgressWatchdog(3003);
check("W6b after clearing all three → back to base",
  _watchdogCount() === baseW6, baseW6, _watchdogCount());

console.log("");
console.log("=".repeat(60));
console.log(`${pass}/${pass + fail} probes passed`);
console.log("=".repeat(60));
if (fail > 0) process.exit(1);
process.exit(0);
