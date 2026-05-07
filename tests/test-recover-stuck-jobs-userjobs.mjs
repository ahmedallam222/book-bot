// ════════════════════════════════════════════════════════════════
// AUDIT 2026-05-04 — BUG C: recoverStuckJobs preserves USER_JOBS
// ════════════════════════════════════════════════════════════════
//
// السياق: في `queue.ts:recoverStuckJobs` كان `queuedIds` (snapshot
// لطوابير Q_HIGH+Q_NORMAL) محسوب قبل ما الـ stuck jobs يتعادوا
// requeue. النتيجة: بعد الـ requeue، الـ orphan-cleanup pass كان
// يعتبر الـ IDs اللي اتصاد رجعت requeue كـ orphans (لأنها مش في
// `queuedIds` المتخلف) ويحذف USER_JOBS pointer. مع إن الـ job
// لسه في الطابور وهيشتغل.
//
// الإصلاح: بعد كل lpush ناجح للـ requeue، أضيف الـ ID لـ `queuedIds`
// قبل الـ orphan filter.
//
// نختبر:
//   S1: source — `queuedIds.add(id)` موجود بعد lpush
//   S2: نمذجة الـ algorithm محلياً ونتأكد إن مش بيختار orphans غلط

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, cond, want, got) {
  if (cond) { console.log(`[PASS] ${name}`); pass++; }
  else      { console.log(`[FAIL] ${name} — want=${JSON.stringify(want)} got=${JSON.stringify(got)}`); fail++; }
}

// ── S1: source-level assertion ─────────────────────────────────
console.log("=== S1: source: queuedIds.add(id) after lpush ===");

const queueSrc = fs.readFileSync(
  path.join(__dirname, "../server/bot/queue.ts"), "utf8",
);

// We expect: the requeue branch now adds the id back into `queuedIds`
// before the orphan-cleanup loop runs.
const recoverBlock = queueSrc.match(
  /async function recoverStuckJobs[\s\S]*?Q_ACTIVE.*?$/m,
);
check("recoverStuckJobs body present in source",
  !!queueSrc.match(/recoverStuckJobs/), true, !!queueSrc.match(/recoverStuckJobs/));

// requeue path: requeuePipe.lpush(...) followed (within the same
// `else` block) by queuedIds.add(id). We allow up to 1500 chars of
// comment between them.
const lpushIdx = queueSrc.indexOf("requeuePipe.lpush(");
const addIdIdx = queueSrc.indexOf("queuedIds.add(id);");
check("requeue path adds id to queuedIds",
  lpushIdx > 0 && addIdIdx > lpushIdx && addIdIdx - lpushIdx < 1500,
  "queuedIds.add(id) appears after requeuePipe.lpush in same block",
  `lpushIdx=${lpushIdx}, addIdIdx=${addIdIdx}, diff=${addIdIdx - lpushIdx}`);

// ── S2: algorithm reproduction ─────────────────────────────────
console.log("\n=== S2: simulated crash-recovery preserves USER_JOBS ===");

// Reproduce the algorithm locally (just the relevant filter).
// State setup:
//   USER_JOBS(u1) = [j1, j2, j3]
//   Q_ACTIVE      = {j1, j2}      (stuck — workers crashed mid-flight)
//   Q_HIGH        = [j3]
//   Q_NORMAL      = []
//
// Expected after recovery (with fix):
//   - j1, j2 requeued to Q_HIGH (or Q_NORMAL by priority)
//   - queuedIds = {j3, j1, j2}
//   - orphans for u1 = USER_JOBS(u1) \ queuedIds = {} → no del
//
// Without fix:
//   - queuedIds = {j3} (stale)
//   - orphans for u1 = {j1, j2} → 2 orphans → lrem (or full del if all)
//   - User pending count drops to 1 instead of 3.

function simulate({ withFix }) {
  const userJobs = ["j1", "j2", "j3"];
  const qActive  = ["j1", "j2"];
  const qHigh    = ["j3"];
  const qNormal  = [];

  const activeIds = qActive.slice();
  const queuedIds = new Set([...qHigh, ...qNormal]);
  const stuckIds  = activeIds.filter((id) => !queuedIds.has(id));

  // requeue
  for (const id of stuckIds) {
    qHigh.unshift(id); // lpush
    if (withFix) queuedIds.add(id);
  }

  // orphan cleanup pass
  const orphans = userJobs.filter((id) => !queuedIds.has(id));
  return { orphans, finalUserJobs: userJobs.filter((id) => !orphans.includes(id)) };
}

const without = simulate({ withFix: false });
const withv   = simulate({ withFix: true  });

check("Without fix: orphans = [j1, j2] (BUG)",
  JSON.stringify(without.orphans) === JSON.stringify(["j1", "j2"]),
  ["j1", "j2"], without.orphans);

check("Without fix: USER_JOBS shrinks to [j3] only (BUG)",
  JSON.stringify(without.finalUserJobs) === JSON.stringify(["j3"]),
  ["j3"], without.finalUserJobs);

check("With fix: orphans = [] (no spurious cleanup)",
  withv.orphans.length === 0,
  [], withv.orphans);

check("With fix: USER_JOBS preserved as [j1, j2, j3]",
  JSON.stringify(withv.finalUserJobs) === JSON.stringify(["j1", "j2", "j3"]),
  ["j1", "j2", "j3"], withv.finalUserJobs);

// ── S3: real orphans (jobs no longer anywhere) still get cleaned ──
console.log("\n=== S3: real orphans (job dropped) still cleaned ===");

function simulateRealOrphan({ withFix }) {
  const userJobs = ["j1", "j2", "j_dropped"];
  const qActive  = ["j1"];
  const qHigh    = ["j2"];
  const qNormal  = [];

  const activeIds = qActive.slice();
  const queuedIds = new Set([...qHigh, ...qNormal]);
  const stuckIds  = activeIds.filter((id) => !queuedIds.has(id));

  // requeue
  for (const id of stuckIds) {
    qHigh.unshift(id);
    if (withFix) queuedIds.add(id);
  }

  const orphans = userJobs.filter((id) => !queuedIds.has(id));
  return { orphans };
}

const realOrphan = simulateRealOrphan({ withFix: true });
check("Real orphan (j_dropped never queued) still cleaned even with fix",
  JSON.stringify(realOrphan.orphans) === JSON.stringify(["j_dropped"]),
  ["j_dropped"], realOrphan.orphans);

// ════════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(60));
console.log(`${pass}/${pass + fail} probes passed`);
console.log("=".repeat(60));
if (fail > 0) process.exit(1);
process.exit(0);
