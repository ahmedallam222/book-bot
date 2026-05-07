// Tests Bugs #12, #13, #16 — queue robustness fixes.
//
// We can't easily spin up a real Redis here, so we reason about the
// emitted CommonJS bundle markers + the source file shape. Each bug
// fix has a unique, stable string we can assert on.
import fs from "fs";
const SRC    = fs.readFileSync("server/bot/queue.ts", "utf-8");
const BUNDLE = fs.readFileSync("dist/index.cjs",      "utf-8");

let pass = 0, fail = 0;
function ok(name, cond, info = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? ` (${info})` : ""}`);
}

// ─── Bug #12 — recoverStuckJobs requeue ─────────────────
console.log("\nBug #12 — Crash recovery requeue");
ok("Q_ACTIVE_JSON hash declared",        SRC.includes("Q_ACTIVE_JSON"));
ok("dequeue stores JSON copy",           SRC.includes("hset(Q_ACTIVE_JSON, job.id"));
ok("completeJob frees JSON",             /completeJob[^]*?hdel\(Q_ACTIVE_JSON/.test(SRC));
ok("failJob frees JSON before retry",    /failJob[^]*?hdel\(Q_ACTIVE_JSON/.test(SRC));
ok("recoverStuckJobs reads JSON hash",   /recoverStuckJobs[^]*?hgetall\(Q_ACTIVE_JSON/.test(SRC));
ok("recoverStuckJobs requeues to lpush", /recoverStuckJobs[^]*?lpush\(queue/.test(SRC));
ok("retries++ on requeue (poison pill)", /recoverStuckJobs[^]*?retries\s*=\s*\(job\.retries\s*\?\?\s*0\)\s*\+\s*1/.test(SRC));
ok("recoverStuckJobs DLQ overflow path", /recoverStuckJobs[^]*?MAX_RETRIES[^]*?zadd\(Q_DLQ/.test(SRC));
ok("recoverStuckJobs clears both keys",  SRC.includes("redis.del(Q_ACTIVE, Q_ACTIVE_JSON)"));
ok("bundle ships JSON hash key",         BUNDLE.includes("queue:active:json"));

// ─── Bug #13 — accurate cancel count ──────────────────
console.log("\nBug #13 — Accurate cancelUserJobs count");
ok("cancel sums LREM return values",     /res\)\s*\{[\s\S]*?for\s*\(const\s*\[err,\s*removed\]\s*of\s*res\)/.test(SRC));
ok("cancel checks numeric removed > 0",  /typeof\s+removed\s*===\s*"number"\s*&&\s*removed\s*>\s*0/.test(SRC));
ok("cancel no longer pre-increments",    !/cancelled\+\+;[^\n]*\n[\s\S]{0,200}exec\(\)/.test(SRC));

// ─── Bug #16 — DLQ entry-level TTL ──────────────────
console.log("\nBug #16 — DLQ entry-level TTL");
ok("DLQ uses zadd with expireAt",        SRC.includes("zadd(Q_DLQ, expireAt"));
// The list-level expire pattern only existed inside failJob's pipeline.
// (A comment still mentions the pre-fix verbatim — that's fine.)
ok("DLQ no longer rpush-then-expire-list", !/rpush\(Q_DLQ[\s\S]{0,80}expire\(Q_DLQ/.test(SRC));
ok("DLQ GC on push (zremrangebyscore)",  /zadd\(Q_DLQ[\s\S]*?zremrangebyscore\(Q_DLQ/.test(SRC));
ok("DLQ stats use zcount with cutoff",   SRC.includes("redis.zcount(Q_DLQ, Date.now()"));
ok("getDLQJobs uses zrevrangebyscore",   SRC.includes("zrevrangebyscore"));
ok("getDLQJobs GCs before read",         /getDLQJobs[\s\S]*?zremrangebyscore\(Q_DLQ,\s*0,\s*Date\.now/.test(SRC));
ok("clearQueues includes Q_ACTIVE_JSON", SRC.includes("redis.del(Q_HIGH, Q_NORMAL, Q_ACTIVE, Q_ACTIVE_JSON)"));

// ─── Behavioral simulation ─────────────────────────────
// Simulate Bug #13's accurate count with the new pipe-result semantics.
console.log("\nBehavioral: cancelled count math");
function countActualCancellations(pipeResults) {
  let cancelled = 0;
  for (const [err, removed] of pipeResults) {
    if (!err && typeof removed === "number" && removed > 0) cancelled += removed;
  }
  return cancelled;
}
// All deletions succeed → returns N
ok("all 3 deletes succeed → 3",     countActualCancellations([[null, 1], [null, 1], [null, 1]]) === 3);
// 2 succeed, 1 fails (already dequeued) → returns 2
ok("2/3 deletes succeed → 2",       countActualCancellations([[null, 1], [null, 0], [null, 1]]) === 2);
// All fail → returns 0 (pre-fix would have returned 3!)
ok("0/3 deletes succeed → 0",       countActualCancellations([[null, 0], [null, 0], [null, 0]]) === 0);
ok("error in pipe slot → not counted", countActualCancellations([[new Error("boom"), null], [null, 1]]) === 1);

// Simulate Bug #16's per-entry expiry semantics.
console.log("\nBehavioral: DLQ per-entry expiry");
const entries = [
  { score: 100,                   name: "old1" },  // should expire
  { score: 200,                   name: "old2" },  // should expire
  { score: Date.now() + 60000,    name: "new1" },  // alive
  { score: Date.now() + 86400000, name: "new2" },  // alive
];
const NOW = Date.now();
const alive = entries.filter((e) => e.score > NOW).map((e) => e.name).sort();
ok("only newly-pushed entries survive", alive.join(",") === "new1,new2");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
