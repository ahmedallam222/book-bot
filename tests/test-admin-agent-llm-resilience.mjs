// Deterministic probes for the admin agent's LLM resilience layer
// (server/bot/adminAgent/llm.ts + llmTelemetry.ts).
//
// Background: on the first day Cloudflare was wired as primary it
// failed with HTTP 400 on the OpenAI-compat endpoint for assistant
// messages carrying tool_calls (`gpt-oss-120b` validator rejects them).
// We:
//   1. Switched the default model to @cf/meta/llama-3.3-70b-instruct-fp8-fast
//   2. Coerce non-string content → string before dispatch (defensive)
//   3. Retry once on transient failures (HTTP 5xx / 429 / network)
//   4. Track per-provider success/failure/latency in Redis
//   5. Soft-demote a provider after 3 consecutive failures in 5 min
//
// We probe via static markers + by importing the test-only normaliser.

import fs   from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); }
}

const ROOT = process.cwd();
const LLM_PATH = path.join(ROOT, "server", "bot", "adminAgent", "llm.ts");
const TEL_PATH = path.join(ROOT, "server", "bot", "adminAgent", "llmTelemetry.ts");
const TOOL_PATH = path.join(ROOT, "server", "bot", "adminAgent", "tools.ts");
const llmSrc  = fs.readFileSync(LLM_PATH, "utf8");
const telSrc  = fs.readFileSync(TEL_PATH, "utf8");
const toolSrc = fs.readFileSync(TOOL_PATH, "utf8");

// ─── R1 — llm.ts wires telemetry + retry + breaker ────────────────
console.log("R1 — llm.ts wires telemetry + retry + breaker");
ok("imports recordSuccess / recordFailure / isDemoted",
   /recordSuccess[\s\S]*?recordFailure[\s\S]*?isDemoted/.test(llmSrc));
ok("imports classifyFailure + isTransient",
   /classifyFailure/.test(llmSrc) && /isTransient/.test(llmSrc));
ok("dispatcher calls recordSuccess on success",
   /recordSuccess\s*\(\s*p\.id\s*,\s*ms\s*\)/.test(llmSrc));
ok("dispatcher calls recordFailure on terminal failure",
   /recordFailure\s*\(\s*p\.id\s*,/.test(llmSrc));
ok("dispatcher reorders providers via breaker (reorderForBreaker)",
   /reorderForBreaker/.test(llmSrc));
ok("retry wrapper exists (callWithRetry)",
   /async\s+function\s+callWithRetry/.test(llmSrc));
ok("retry wrapper sleeps RETRY_BACKOFF_MS between attempts",
   /RETRY_BACKOFF_MS/.test(llmSrc) && /sleep\s*\(\s*RETRY_BACKOFF_MS/.test(llmSrc));
ok("retry only on transient errors (isTransient gate)",
   /isTransient\s*\(\s*kind\s*\)/.test(llmSrc));
ok("HTTP error attaches __httpStatus for downstream classification",
   /__httpStatus\s*=\s*r\.status/.test(llmSrc));

// ─── R2 — content normalisation (the actual CF 400 fix) ──────────
console.log("\nR2 — content normalisation");
ok("normalizeMessages function exists",
   /function\s+normalizeMessages/.test(llmSrc));
ok("dispatcher normalises messages before per-provider loop",
   /const\s+normalized\s*=\s*normalizeMessages/.test(llmSrc));
ok("non-string content → JSON.stringify (defensive)",
   /JSON\.stringify\s*\(\s*m\.content\s*\)/.test(llmSrc));
ok("assistant+tool_calls keeps empty string content (not null)",
   /isAssistantToolCall\s*\?\s*""/.test(llmSrc));

// ─── R3 — telemetry module shape ─────────────────────────────────
console.log("\nR3 — llmTelemetry.ts shape");
ok("exports recordSuccess / recordFailure / isDemoted / getProviderStats",
   /export\s+async\s+function\s+recordSuccess/.test(telSrc) &&
   /export\s+async\s+function\s+recordFailure/.test(telSrc) &&
   /export\s+async\s+function\s+isDemoted/.test(telSrc)    &&
   /export\s+async\s+function\s+getProviderStats/.test(telSrc));
ok("classifyFailure + isTransient are exported",
   /export\s+function\s+classifyFailure/.test(telSrc) &&
   /export\s+function\s+isTransient/.test(telSrc));
ok("uses Redis pipeline for atomic counter updates",
   /redis\.pipeline\s*\(\s*\)/.test(telSrc));
ok("streak threshold is 3",
   /STREAK_THRESHOLD\s*=\s*3/.test(telSrc));
ok("streak window is 5 minutes",
   /STREAK_WINDOW_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(telSrc));
ok("demote duration is 10 minutes",
   /DEMOTE_DURATION_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/.test(telSrc));
ok("isDemoted self-clears expired markers",
   /if\s*\(\s*Date\.now\(\)\s*>=\s*until\s*\)/.test(telSrc));
ok("classifyFailure recognises 429",
   /httpStatus\s*===\s*429/.test(telSrc));
ok("classifyFailure recognises 5xx",
   /httpStatus\s*>=\s*500/.test(telSrc));
ok("classifyFailure recognises network/abort/timeout",
   /abort\|timeout/.test(telSrc));

// ─── R4 — tools.ts exposes llm_provider_stats + reset ────────────
console.log("\nR4 — tools.ts exposes new admin tools");
ok("imports getProviderStats + resetProviderTelemetry",
   /getProviderStats[\s\S]*?resetProviderTelemetry/.test(toolSrc));
ok("registers llm_provider_stats (read tool)",
   /name:\s*"llm_provider_stats"/.test(toolSrc));
ok("registers reset_llm_provider_stats (write tool)",
   /name:\s*"reset_llm_provider_stats"/.test(toolSrc));
ok("reset_llm_provider_stats is marked isWrite (confirm flow)",
   /TOOL_RESET_LLM_STATS:\s*Tool\s*=\s*\{[\s\S]{0,500}?isWrite:\s*true/.test(toolSrc));
ok("registry lists both new tools",
   /TOOL_LLM_PROVIDER_STATS/.test(toolSrc) && /TOOL_RESET_LLM_STATS/.test(toolSrc));

// ─── R5 — runtime behaviour of normalizeMessages ────────────────
console.log("\nR5 — runtime: normalizeMessages behaviour");
// We need env stubs so the module chain can import (config.ts).
process.env.CLOUDFLARE_AI_ACCOUNT_ID = process.env.CLOUDFLARE_AI_ACCOUNT_ID || "test-account-id";
process.env.CLOUDFLARE_AI_API_TOKEN  = process.env.CLOUDFLARE_AI_API_TOKEN  || "test-token-xxxxxxxxxxxx";

const llmMod = await import(path.join(ROOT, "server", "bot", "adminAgent", "llm.ts"));
const { __test } = llmMod;
const norm = __test.normalizeMessages;

const out1 = norm([{ role: "system", content: "you are an agent" }]);
ok("string content passes through unchanged",
   out1[0].content === "you are an agent");

const out2 = norm([
  { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }] },
]);
ok("assistant with tool_calls + null content → \"\"",
   out2[0].content === "" && Array.isArray(out2[0].tool_calls));

const arrayContent = [{ type: "text", text: "hello" }];
const out3 = norm([{ role: "user", content: arrayContent }]);
ok("array content → JSON.stringify(array)",
   typeof out3[0].content === "string" &&
   out3[0].content === JSON.stringify(arrayContent),
   out3[0].content);

const objContent = { type: "text", text: "obj" };
const out4 = norm([{ role: "tool", tool_call_id: "x", content: objContent }]);
ok("object content → JSON.stringify(object)",
   typeof out4[0].content === "string" &&
   out4[0].content === JSON.stringify(objContent));

const out5 = norm([{ role: "user", content: null }]);
ok("non-assistant null content stays null",
   out5[0].content === null,
   String(out5[0].content));

// classifyFailure / isTransient runtime
const telMod = await import(path.join(ROOT, "server", "bot", "adminAgent", "llmTelemetry.ts"));
const { classifyFailure, isTransient } = telMod;
ok("classifyFailure(429) → '429'",       classifyFailure(new Error("x"), 429) === "429");
ok("classifyFailure(503) → '5xx'",       classifyFailure(new Error("x"), 503) === "5xx");
ok("classifyFailure(AbortError) → 'timeout'",
   classifyFailure(Object.assign(new Error("aborted"), { name: "AbortError" })) === "timeout");
ok("classifyFailure(generic) → 'other'",
   classifyFailure(new Error("bad json")) === "other");
ok("isTransient('429') → true",          isTransient("429") === true);
ok("isTransient('5xx') → true",          isTransient("5xx") === true);
ok("isTransient('timeout') → true",      isTransient("timeout") === true);
ok("isTransient('other') → false",       isTransient("other") === false);

console.log(`\n${pass}/${pass + fail} probes passed`);
// Module chain opens Redis connection; force-exit so test runner doesn't hang.
process.exit(fail > 0 ? 1 : 0);
