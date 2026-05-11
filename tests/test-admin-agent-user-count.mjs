// Deterministic probes for the admin-agent's new `get_user_count`
// tool + the SYSTEM_PROMPT clarification, plus the refusal-storm
// early-break in loopGuards.
//
// Background: prod showed the model calling `get_total_stats` 23
// times in a row when the admin asked "كم مستخدم في البوت لحد
// الآن؟" — because that tool's `users` field actually means
// `distinctSearchers` (90), not the real DB count (137). The model
// kept retrying the same tool because no other tool seemed
// appropriate, and the refusal messages from PR #151 were ignored.
//
// Fix:
//   1. New `get_user_count` tool that returns total_users_db
//      (from Postgres `users` table) alongside distinct_searchers
//      (Redis) and premium_users.
//   2. `get_total_stats` description warns the model that `users`
//      there ≠ total bot users, points it at `get_user_count`.
//   3. SYSTEM_PROMPT has an explicit Schema note about the same.
//   4. `MAX_REFUSALS_BEFORE_BAIL` in loopGuards — when the model
//      ignores N refusals in a single turn, bail to the
//      forced-final-answer path instead of wasting more iterations.

import fs   from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); }
}

const ROOT = process.cwd();
const TOOLS_PATH  = path.join(ROOT, "server", "bot", "adminAgent", "tools.ts");
const PROMPT_PATH = path.join(ROOT, "server", "bot", "adminAgent", "prompt.ts");
const GUARD_PATH  = path.join(ROOT, "server", "bot", "adminAgent", "loopGuards.ts");
const IDX_PATH    = path.join(ROOT, "server", "bot", "adminAgent", "index.ts");
const toolsSrc  = fs.readFileSync(TOOLS_PATH,  "utf8");
const promptSrc = fs.readFileSync(PROMPT_PATH, "utf8");
const guardSrc  = fs.readFileSync(GUARD_PATH,  "utf8");
const idxSrc    = fs.readFileSync(IDX_PATH,    "utf8");

// ─── F1 — static markers on tools.ts ──────────────────────────
console.log("F1 — get_user_count tool wired in tools.ts");

ok("get_user_count tool is defined",
   /name:\s*"get_user_count"/.test(toolsSrc));
ok("get_user_count is registered in TOOLS array",
   /TOOL_GET_USER_COUNT,?/.test(toolsSrc));
ok("get_user_count uses storage.getAllUsersWithDetails(1, 0)",
   /storage\.getAllUsersWithDetails\(\s*1\s*,\s*0\s*\)/.test(toolsSrc));
ok("get_user_count reads premiumCount()",
   /premiumCount\s*\(\s*\)/.test(toolsSrc));
ok("get_user_count returns total_users_db + distinct_searchers + premium_users",
   /total_users_db:/.test(toolsSrc) &&
   /distinct_searchers:/.test(toolsSrc) &&
   /premium_users:/.test(toolsSrc));
ok("get_user_count returns a human-readable summary_ar",
   /summary_ar:/.test(toolsSrc) &&
   /إجمالي المستخدمين في قاعدة البيانات/.test(toolsSrc));

ok("get_total_stats description warns the model about user count semantics",
   /distinctSearchers/.test(toolsSrc) &&
   /get_user_count/.test(toolsSrc) &&
   /name:\s*"get_total_stats"/.test(toolsSrc));

// ─── F2 — static markers on prompt.ts ─────────────────────────
console.log("\nF2 — system prompt clarification");

ok("SYSTEM_PROMPT references get_user_count",
   /get_user_count/.test(promptSrc));
ok("SYSTEM_PROMPT explains distinctSearchers ≠ total bot users",
   /distinctSearchers/.test(promptSrc));
ok("SYSTEM_PROMPT tells the model not to spam-retry the same tool",
   /لا تتعاد على نفس الأداة|جرّب أداة مختلفة/.test(promptSrc));

// ─── F3 — static markers on loopGuards.ts + index.ts ─────────
console.log("\nF3 — refusal-storm early-break wiring");

ok("loopGuards exports MAX_REFUSALS_BEFORE_BAIL",
   /export\s+const\s+MAX_REFUSALS_BEFORE_BAIL\s*=\s*\d+/.test(guardSrc));
ok("index.ts imports MAX_REFUSALS_BEFORE_BAIL",
   /MAX_REFUSALS_BEFORE_BAIL/.test(idxSrc));
ok("index.ts widens abortedReason to include refusal_storm",
   /abortedReason:\s*"loop_budget"\s*\|\s*"token_budget"\s*\|\s*"refusal_storm"/.test(idxSrc));
ok("index.ts breaks the loop when refusedCount ≥ MAX_REFUSALS_BEFORE_BAIL",
   /burstGuard\.refusedCount\s*>=\s*MAX_REFUSALS_BEFORE_BAIL/.test(idxSrc) &&
   /abortedReason\s*=\s*"refusal_storm"/.test(idxSrc));
ok("index.ts logs the refusal-storm bail-out",
   /refusal storm at iter/.test(idxSrc));
ok("forced-final-answer message has a refusal_storm branch",
   /reason\s*===\s*"refusal_storm"/.test(idxSrc));

// ─── F4 — runtime: MAX_REFUSALS_BEFORE_BAIL constant ─────────
console.log("\nF4 — runtime: MAX_REFUSALS_BEFORE_BAIL constant");

const guardMod = await import(path.join(ROOT, "server", "bot", "adminAgent", "loopGuards.ts"));
ok("MAX_REFUSALS_BEFORE_BAIL is a small positive integer",
   typeof guardMod.MAX_REFUSALS_BEFORE_BAIL === "number" &&
   guardMod.MAX_REFUSALS_BEFORE_BAIL >= 2 &&
   guardMod.MAX_REFUSALS_BEFORE_BAIL <= 10,
   `value=${guardMod.MAX_REFUSALS_BEFORE_BAIL}`);
ok("MAX_REFUSALS_BEFORE_BAIL is less than DUPLICATE_HARD_CAP (so it fires first)",
   guardMod.MAX_REFUSALS_BEFORE_BAIL < guardMod.DUPLICATE_HARD_CAP);

// ─── F5 — runtime: simulate refusal counter rising ───────────
console.log("\nF5 — runtime: burstGuard.refusedCount tracks refusals correctly");

const { createBurstGuard, callSignature, inspectCall, recordExecution, recordRefusal } = guardMod;
{
  const g = createBurstGuard();
  const sig = callSignature("get_total_stats", {});
  // Drive the same call through the burst guard repeatedly,
  // recording refusals each time inspectCall denies.
  let refusalsObserved = 0;
  for (let i = 0; i < 12; i++) {
    const d = inspectCall(g, sig);
    if (d.allow) {
      recordExecution(g, sig);
    } else {
      recordRefusal(g, sig);
      refusalsObserved++;
    }
  }
  ok("after 12 attempts, refusedCount equals the number of refusals observed",
     g.refusedCount === refusalsObserved,
     `refusedCount=${g.refusedCount} observed=${refusalsObserved}`);
  ok("refusedCount is enough to trip the early-break threshold",
     g.refusedCount >= guardMod.MAX_REFUSALS_BEFORE_BAIL,
     `refusedCount=${g.refusedCount} threshold=${guardMod.MAX_REFUSALS_BEFORE_BAIL}`);
}

const total = pass + fail;
console.log(`\n${pass}/${total} probes passed`);
process.exit(fail > 0 ? 1 : 0);
