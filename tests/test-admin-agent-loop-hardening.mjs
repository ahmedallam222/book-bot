// Deterministic probes for the admin agent's loop-hardening guards
// (server/bot/adminAgent/loopGuards.ts + index.ts wiring).
//
// Background: after PR #150 (forced-final answer), exhausting the
// loop budget no longer leaves users empty-handed — but the budget
// still gets exhausted on real admin queries because Llama 3.3 70B
// occasionally gets stuck re-issuing the SAME tool call instead of
// summarising its result. PR #150 patched the symptom; this PR
// patches the cause:
//
//   1. **Duplicate-call detector**: catches the model after it
//      requests the same (toolName, args) signature 3 times in a row,
//      synthesises a refusal that nudges it to use the previous
//      result. This breaks the loop at iter ≈3 instead of iter 24.
//
//   2. **MAX_LLM_LOOPS bumped 12 → 24**: with the detector in
//      place, the ceiling can be higher to accommodate legitimate
//      long admin workflows (audit chains, multi-tool reports).
//
//   3. **Token-budget guard**: estimates total conversation chars
//      and bails to the forced-final-answer path when a single
//      turn exceeds TOKEN_BUDGET_CHARS, preventing context window
//      blow-ups.
//
// We test:
//   F1 — static markers on index.ts and loopGuards.ts
//   F2 — runtime: callSignature is order-insensitive on args keys
//   F3 — runtime: consecutive-duplicate refusal at threshold 3
//   F4 — runtime: refused calls clear the consecutive streak
//        (model can recover by trying a different tool)
//   F5 — runtime: hard cap blocks interleaved duplicates too
//   F6 — runtime: refusalToolContent is well-formed JSON with
//        Arabic + English instructions
//   F7 — runtime: estimateConversationChars + isOverTokenBudget

import fs   from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); }
}

const ROOT = process.cwd();
const IDX_PATH   = path.join(ROOT, "server", "bot", "adminAgent", "index.ts");
const GUARD_PATH = path.join(ROOT, "server", "bot", "adminAgent", "loopGuards.ts");
const idxSrc   = fs.readFileSync(IDX_PATH, "utf8");
const guardSrc = fs.readFileSync(GUARD_PATH, "utf8");

// ─── F1 — static markers ──────────────────────────────────────────
console.log("F1 — static markers on index.ts + loopGuards.ts");

ok("MAX_LLM_LOOPS bumped to 24",
   /MAX_LLM_LOOPS\s*=\s*24\b/.test(idxSrc));
ok("MAX_LLM_LOOPS comment notes prior value (12)",
   /from\s+12\s*→\s*24|from 12 to 24/.test(idxSrc));
ok("index.ts imports loopGuards helpers",
   /from\s+["']\.\/loopGuards\.js["']/.test(idxSrc) &&
   /createBurstGuard/.test(idxSrc) &&
   /inspectCall/.test(idxSrc) &&
   /refusalToolContent/.test(idxSrc));
ok("index.ts instantiates a burstGuard per turn",
   /const\s+burstGuard\s*=\s*createBurstGuard\(\)/.test(idxSrc));
ok("index.ts checks isOverTokenBudget before each iteration",
   /if\s*\(\s*isOverTokenBudget\s*\(\s*messages\s*\)\s*\)/.test(idxSrc));
ok("index.ts inspects each tool call against the burst guard",
   /inspectCall\s*\(\s*burstGuard\s*,\s*sig\s*\)/.test(idxSrc));
ok("index.ts records a refusal when inspectCall denies",
   /recordRefusal\s*\(\s*burstGuard\s*,\s*sig\s*\)/.test(idxSrc));
ok("index.ts records execution after running a tool",
   /recordExecution\s*\(\s*burstGuard\s*,\s*sig\s*\)/.test(idxSrc));
ok("index.ts handles the token_budget exhaustion path",
   /token_budget/.test(idxSrc));
ok("loopGuards exports DUPLICATE_THRESHOLD = 3",
   /export\s+const\s+DUPLICATE_THRESHOLD\s*=\s*3/.test(guardSrc));
ok("loopGuards exports TOKEN_BUDGET_CHARS",
   /export\s+const\s+TOKEN_BUDGET_CHARS\s*=/.test(guardSrc));

// ─── F2..F7 — runtime ────────────────────────────────────────────
console.log("\nF2..F7 — runtime: loopGuards behaviour");

const mod = await import(path.join(ROOT, "server", "bot", "adminAgent", "loopGuards.ts"));
const {
  createBurstGuard, inspectCall, recordExecution, recordRefusal,
  refusalToolContent, callSignature,
  estimateConversationChars, isOverTokenBudget,
  DUPLICATE_THRESHOLD, DUPLICATE_HARD_CAP, TOKEN_BUDGET_CHARS,
} = mod;

// F2 — callSignature key-order invariance
const s1 = callSignature("foo", { a: 1, b: 2 });
const s2 = callSignature("foo", { b: 2, a: 1 });
const s3 = callSignature("foo", { a: 1, b: 3 });
ok("callSignature is order-insensitive on args keys",
   s1 === s2, `${s1} vs ${s2}`);
ok("callSignature distinguishes different arg values",
   s1 !== s3, `${s1} vs ${s3}`);

// F3 — consecutive duplicate refusal at threshold 3
{
  const g = createBurstGuard();
  const sig = callSignature("get_users", { limit: 5 });
  const d1 = inspectCall(g, sig); recordExecution(g, sig);
  const d2 = inspectCall(g, sig); recordExecution(g, sig);
  const d3 = inspectCall(g, sig); // would be 3rd consecutive
  ok("call #1 allowed", d1.allow === true);
  ok("call #2 allowed", d2.allow === true);
  ok("call #3 refused with consecutive_duplicate",
     d3.allow === false && d3.reason === "consecutive_duplicate",
     `decision=${JSON.stringify(d3)}`);
}

// F4 — refused calls clear the streak; a different tool resets
{
  const g = createBurstGuard();
  const a = callSignature("get_users", { limit: 5 });
  const b = callSignature("get_premium", {});
  recordExecution(g, a);
  recordExecution(g, a);
  // 3rd attempt at a → refused
  const dRef = inspectCall(g, a);
  ok("3rd consecutive 'a' refused", dRef.allow === false);
  recordRefusal(g, a);
  // Now try b → should be allowed (different tool, fresh streak)
  const dB = inspectCall(g, b);
  ok("different tool 'b' is allowed after refusal of 'a'",
     dB.allow === true,
     `decision=${JSON.stringify(dB)}`);
  recordExecution(g, b);
  // Now try a once more — fresh streak too (because lastSig is now b)
  const dA = inspectCall(g, a);
  ok("'a' allowed again once streak is broken by 'b'",
     dA.allow === true,
     `decision=${JSON.stringify(dA)}`);
}

// F5 — hard cap blocks interleaved duplicates too
{
  const g = createBurstGuard();
  const a = callSignature("get_x", {});
  const b = callSignature("get_y", {});
  // Alternate a, b, a, b, ... never 3 in a row, but hit DUPLICATE_HARD_CAP on a
  for (let i = 0; i < DUPLICATE_HARD_CAP; i++) {
    const d = inspectCall(g, a);
    if (!d.allow) { fail++; console.log(`  FAIL  unexpected refusal at i=${i}`); break; }
    recordExecution(g, a);
    const d2 = inspectCall(g, b);
    if (!d2.allow) { fail++; console.log(`  FAIL  unexpected refusal of b at i=${i}`); break; }
    recordExecution(g, b);
  }
  // Now `a` has been executed DUPLICATE_HARD_CAP times, the next call must refuse
  const dCap = inspectCall(g, a);
  ok("hard cap refuses the (DUPLICATE_HARD_CAP+1)th call to same sig",
     dCap.allow === false && dCap.reason === "hard_cap",
     `decision=${JSON.stringify(dCap)}`);
}

// F6 — refusalToolContent shape
{
  const payload = refusalToolContent("get_users", {
    allow: false, reason: "consecutive_duplicate", count: 3,
  });
  let parsed;
  try { parsed = JSON.parse(payload); } catch { parsed = null; }
  ok("refusalToolContent emits valid JSON",
     parsed && typeof parsed === "object");
  ok("refusalToolContent includes error code + Arabic + English instructions",
     parsed?.error === "duplicate_tool_call_refused" &&
     typeof parsed?.instruction_ar === "string" &&
     parsed.instruction_ar.includes("get_users") &&
     typeof parsed?.instruction_en === "string" &&
     parsed.instruction_en.includes("get_users"),
     JSON.stringify(parsed).slice(0, 200));
}

// F7 — token budget
{
  const small = [{ role: "user", content: "hi" }];
  ok("small conversation is under token budget",
     !isOverTokenBudget(small) && estimateConversationChars(small) < 100);
  const big = [
    { role: "system", content: "x".repeat(TOKEN_BUDGET_CHARS / 2 + 10) },
    { role: "user",   content: "y".repeat(TOKEN_BUDGET_CHARS / 2 + 10) },
  ];
  ok("oversized conversation is flagged",
     isOverTokenBudget(big),
     `estimated=${estimateConversationChars(big)}`);
  // assistant tool_calls also contribute to the estimate
  const withTools = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "1",
      type: "function",
      function: { name: "x", arguments: "z".repeat(TOKEN_BUDGET_CHARS + 100) },
    }],
  }];
  ok("tool_calls payload counted toward token budget",
     isOverTokenBudget(withTools),
     `estimated=${estimateConversationChars(withTools)}`);
}

const total = pass + fail;
console.log(`\n${pass}/${total} probes passed`);
process.exit(fail > 0 ? 1 : 0);
