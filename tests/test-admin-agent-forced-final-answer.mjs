// Deterministic probes for the admin agent's "forced final answer"
// fallback (server/bot/adminAgent/index.ts + llm.ts).
//
// Background: Llama 3.3 70B occasionally keeps re-issuing the same
// tool call instead of summarising the result it already received,
// hitting MAX_LLM_LOOPS without ever producing a text reply. Before,
// the admin agent gave up and told the user "وصلت لحد الـ tool calls
// (8 دورات). جرّب سؤال أبسط." which is a poor UX (and the number was
// stale: the constant was bumped from 8 to 12 but the message text
// wasn't).
//
// Fix: when the loop budget exhausts, do ONE last LLM call without
// tools (forceText=true) and an Arabic system nudge to summarise.
// This guarantees the user always gets a real reply.
//
// We test:
//   F1 — static markers on the source files
//   F2 — runtime: runLLM(opts.forceText) omits tools from dispatch
//   F3 — runtime: opts is optional (back-compat: existing callers
//        without opts still work)

import fs   from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); }
}

const ROOT = process.cwd();
const IDX_PATH = path.join(ROOT, "server", "bot", "adminAgent", "index.ts");
const LLM_PATH = path.join(ROOT, "server", "bot", "adminAgent", "llm.ts");
const idxSrc  = fs.readFileSync(IDX_PATH, "utf8");
const llmSrc  = fs.readFileSync(LLM_PATH, "utf8");

// ─── F1 — static markers ──────────────────────────────────────────
console.log("F1 — static markers on index.ts + llm.ts");

ok("llm.ts exports RunLLMOpts type",
   /export\s+interface\s+RunLLMOpts\s*\{/.test(llmSrc));
ok("llm.ts runLLM accepts a third (opts) parameter",
   /export\s+async\s+function\s+runLLM\s*\(\s*messages:[\s\S]{0,80}?tools:[\s\S]{0,80}?opts/.test(llmSrc));
ok("llm.ts respects opts.forceText by zeroing tools",
   /opts\.forceText\s*\?\s*\[\]/.test(llmSrc));
ok("llm.ts uses effectiveTools (not raw tools) inside dispatch loop",
   /callWithRetry\s*\(\s*p\s*,\s*normalized\s*,\s*effectiveTools\s*\)/.test(llmSrc));

ok("index.ts no longer hard-codes 8 in the user-facing exhaustion message",
   !/تول calls \(8/.test(idxSrc) && !/الـ tool calls \(8 دورات\)/.test(idxSrc));
ok("index.ts uses MAX_LLM_LOOPS dynamically in the exhaustion path",
   /\$\{MAX_LLM_LOOPS\}/.test(idxSrc));
ok("index.ts calls forced text-only LLM (runLLM forceText or streamFinalResponse) after the loop",
   /runLLM\s*\([^)]*\{\s*forceText:\s*true\s*\}\s*\)/.test(idxSrc) ||
   /streamFinalResponse\s*\(/.test(idxSrc));
ok("index.ts injects an Arabic system nudge before the forced call",
   /وصلت للحد الأقصى من استدعاءات الأدوات/.test(idxSrc) &&
   /أجِب المستخدم الآن بشكل مباشر/.test(idxSrc));
ok("index.ts logs *_exhausted forced final answer for observability",
   /_exhausted forced final answer/.test(idxSrc));
ok("index.ts saves the forced-answer turn back to conversation history",
   /forced[\s\S]{0,400}?saveConversation/.test(idxSrc) ||
   /finalReply[\s\S]{0,400}?saveConversation/.test(idxSrc));

// ─── F2 — runtime: forceText behaviour ────────────────────────────
console.log("\nF2 — runtime: opts.forceText behaviour");
process.env.CLOUDFLARE_AI_ACCOUNT_ID = process.env.CLOUDFLARE_AI_ACCOUNT_ID || "test-account-id";
process.env.CLOUDFLARE_AI_API_TOKEN  = process.env.CLOUDFLARE_AI_API_TOKEN  || "test-token-xxxxxxxxxxxx";

// Stub global fetch so we can inspect what runLLM dispatches.
let lastBody = null;
const origFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  try { lastBody = JSON.parse(init.body); } catch { lastBody = null; }
  return new Response(JSON.stringify({
    choices: [{ message: { content: "ok", tool_calls: [] } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const llmMod = await import(path.join(ROOT, "server", "bot", "adminAgent", "llm.ts"));
const { runLLM } = llmMod;

const sampleTools = [
  {
    type: "function",
    function: { name: "noop", description: "test", parameters: { type: "object", properties: {} } },
  },
];
const sampleMessages = [{ role: "user", content: "test" }];

// Default call (no opts) should include tools.
await runLLM(sampleMessages, sampleTools).catch(() => null);
ok("default runLLM includes tools in dispatched body",
   Array.isArray(lastBody?.tools) && lastBody.tools.length === 1 &&
   lastBody?.tool_choice === "auto",
   `tools=${JSON.stringify(lastBody?.tools)?.slice(0, 60)} tool_choice=${lastBody?.tool_choice}`);

// forceText:true should omit tools + tool_choice entirely.
lastBody = null;
await runLLM(sampleMessages, sampleTools, { forceText: true }).catch(() => null);
ok("runLLM(opts.forceText=true) OMITS tools from dispatched body",
   lastBody && !("tools" in lastBody) && !("tool_choice" in lastBody),
   `tools_in_body=${lastBody && "tools" in lastBody} tool_choice_in_body=${lastBody && "tool_choice" in lastBody}`);

// Back-compat: explicit empty tools array also omits the tools key.
lastBody = null;
await runLLM(sampleMessages, []).catch(() => null);
ok("runLLM(messages, []) still omits tools (backward compat)",
   lastBody && !("tools" in lastBody),
   `tools_in_body=${lastBody && "tools" in lastBody}`);

globalThis.fetch = origFetch;

console.log(`\n${pass}/${pass + fail} probes passed`);
// Module chain opens Redis connection; force-exit so test runner doesn't hang.
process.exit(fail > 0 ? 1 : 0);
