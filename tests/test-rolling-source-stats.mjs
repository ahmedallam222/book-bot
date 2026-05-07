// Tests Bug #11 — rolling-window source stats. The legacy all-time
// `stats:source:{domain}` keys had no TTL, so a domain that failed
// 100 times last month + recovered to 100% ok this month was still
// auto-disabled forever (50% all-time success rate).
//
// Post-fix: per-day buckets `stats:source:day:{domain}:{YYYY-MM-DD}`
// with 14-day TTL, aggregated over the trailing 7 days on read. After
// 7+ days of clean traffic, a previously-disabled source naturally
// rolls back to clean.
import fs from "fs";
const SRC    = fs.readFileSync("server/bot/analytics.ts", "utf-8");
const BUNDLE = fs.readFileSync("dist/index.cjs",          "utf-8");

let pass = 0, fail = 0;
function ok(name, cond, info = "") {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? ` (${info})` : ""}`);
}

// — Source structure markers —
console.log("Source structure");
ok("WINDOW_DAYS = 7",                      /SOURCE_STATS_WINDOW_DAYS\s*=\s*7/.test(SRC));
ok("TTL = 14 days",                        /SOURCE_STATS_TTL_SEC\s*=\s*\(SOURCE_STATS_WINDOW_DAYS\s*\+\s*7\)\s*\*\s*24\s*\*\s*3600/.test(SRC));
ok("DOMAINS_INDEX = stats:source:domains", SRC.includes('SOURCE_DOMAINS_INDEX     = "stats:source:domains"'));
ok("per-day key shape",                    SRC.includes("`stats:source:day:${domain}:${day}`"));
ok("lastNDays helper exported (private)",  /function lastNDays\(n: number\): string\[\]/.test(SRC));

// — Writers updated —
console.log("\nWriters updated");
ok("recordSourceCounter pipeline",         /recordSourceCounter[^{]*?{[\s\S]*?sadd\(SOURCE_DOMAINS_INDEX[\s\S]*?hincrby\([^)]*?dayKey[\s\S]*?expire\([^)]*?dayKey/.test(SRC));
ok("trackDownload uses recordSourceCounter", /trackDownload[\s\S]*?recordSourceCounter\(domain,\s*"ok"\)/.test(SRC));
ok("trackDownload fail path uses helper",  /trackDownload[\s\S]*?recordSourceCounter\(domain,\s*"fail"\)/.test(SRC));
ok("trackSourceAttempt uses helper",       /trackSourceAttempt[\s\S]*?recordSourceCounter\(domain,\s*ok\s*\?\s*"ok"\s*:\s*"fail"\)/.test(SRC));
ok("trackSourceMistralReject uses helper", /trackSourceMistralReject[\s\S]*?recordSourceCounter\(domain,\s*"mistral_rejected"\)/.test(SRC));
ok("legacy all-time HINCRBY removed",      !/hincrby\(`stats:source:\$\{[^}]+\}`/.test(SRC));

// — Reader updated —
console.log("\nReader updated");
ok("getSourceStats reads from index",      /getSourceStats[\s\S]*?smembers\(SOURCE_DOMAINS_INDEX\)/.test(SRC));
ok("aggregates over lastNDays(7)",         /lastNDays\(SOURCE_STATS_WINDOW_DAYS\)/.test(SRC));
ok("getSourceStats no longer SCANs keys",  !/scanKeys\("stats:source:\*"\)/.test(SRC));
ok("GCs stale domains via SREM",           /srem\(SOURCE_DOMAINS_INDEX,\s*\.\.\.stale\)/.test(SRC));

// — Bundle markers —
console.log("\nBundle markers");
ok("bundle ships per-day key prefix",      BUNDLE.includes("stats:source:day:"));
ok("bundle ships domains-index key",       BUNDLE.includes("stats:source:domains"));
ok("legacy stats:source:domain not written", !/hincrby\(`stats:source:\$\{[^}]+\}`/.test(BUNDLE));

// — Behavioral simulation ————————————————————————————
// Reproduce the rolling-window math the way getSourceStats does it.
console.log("\nBehavioral: rolling window aggregates last 7 of 30 days");
function aggregate(window, history /* {day → {ok, fail, mistral_rejected}} */) {
  let ok = 0, fail = 0, mistralRejected = 0;
  for (const day of window) {
    const e = history[day];
    if (!e) continue;
    ok              += e.ok || 0;
    fail            += e.fail || 0;
    mistralRejected += e.mistral_rejected || 0;
  }
  const total = ok + fail;
  const totalWithRejects = ok + fail + mistralRejected;
  const successRate = total ? ok / total : 0;
  const trustRate   = totalWithRejects ? ok / totalWithRejects : 0;
  return { ok, fail, mistralRejected, total, totalWithRejects, successRate, trustRate };
}

function dayString(daysAgo) {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

const allTimeWindow = Array.from({length: 30}, (_, i) => dayString(i));
const recentWindow  = Array.from({length: 7},  (_, i) => dayString(i));

// Scenario A: domain failed catastrophically 30→8 days ago, perfect
// since. All-time would auto-disable; rolling 7 should NOT.
const scenarioA = {};
for (let i = 8; i < 30; i++) scenarioA[dayString(i)] = { ok: 0, fail: 5, mistral_rejected: 0 };
for (let i = 0; i < 7;  i++) scenarioA[dayString(i)] = { ok: 10, fail: 0, mistral_rejected: 0 };

const aAll    = aggregate(allTimeWindow, scenarioA);
const aRecent = aggregate(recentWindow, scenarioA);
ok("[A] all-time rate looks bad",          aAll.successRate < 0.4);
ok("[A] CRITICAL — rolling rate is 100%",  aRecent.successRate >= 0.99);
ok("[A] rolling totalWithRejects = 70",    aRecent.totalWithRejects === 70);

// Scenario B: domain was great + got worse. Rolling reflects current.
const scenarioB = {};
for (let i = 8; i < 30; i++) scenarioB[dayString(i)] = { ok: 100, fail: 0,  mistral_rejected: 0 };
for (let i = 0; i < 7;  i++) scenarioB[dayString(i)] = { ok: 0,   fail: 5,  mistral_rejected: 0 };

const bAll    = aggregate(allTimeWindow, scenarioB);
const bRecent = aggregate(recentWindow, scenarioB);
ok("[B] all-time rate looks fine",         bAll.successRate > 0.95);
ok("[B] CRITICAL — rolling rate is 0%",    bRecent.successRate === 0);

// Scenario C: stale domain (no activity in last 7 days) → not counted
const scenarioC = {};
for (let i = 10; i < 30; i++) scenarioC[dayString(i)] = { ok: 50, fail: 50, mistral_rejected: 0 };
const cRecent = aggregate(recentWindow, scenarioC);
ok("[C] stale domain has 0 attempts in window", cRecent.totalWithRejects === 0);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
