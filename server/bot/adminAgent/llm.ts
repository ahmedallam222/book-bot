// ══════════════════════════════════════════════════════════
// Admin Agent — LLM dispatch with tool calling
// ══════════════════════════════════════════════════════════
// Calls OpenAI-compatible Chat Completions endpoints with function-
// calling. Provider list is loaded **dynamically** from Redis via
// llmProviders.ts so the admin can hot-swap API keys at runtime via
// the admin bot (`add_llm_provider`, `update_llm_provider`,
// `remove_llm_provider`, `set_llm_priority`).
//
// Resilience (added 2026-05-11):
//   - Single retry on transient failures (HTTP 5xx / 429 / network)
//     with a short backoff before falling through to the next provider.
//   - Per-provider telemetry counters (ok / err / latency p50,p95) in
//     Redis, surfaced via the `llm_provider_stats` tool.
//   - Soft circuit breaker: providers that fail 3 times within 5 min
//     get demoted to the end of the chain for 10 min, then re-tried
//     automatically. This stops a quota-exhausted provider (e.g.
//     Cloudflare hitting its daily neurons cap) from being hammered
//     before every fallback.
//
// Message hygiene: the OpenAI spec allows `content` to be a string OR
// an array of typed parts. Cloudflare's compat endpoint accepts only
// strings, so we coerce non-string content to a string just before
// dispatch — defensive against any caller that hands us an object
// (or any future tool that returns multimodal content).

import { L } from "../logger.js";
import { loadProviders, markUsed, type LLMProvider } from "./llmProviders.js";
import {
  recordSuccess,
  recordFailure,
  isDemoted,
  classifyFailure,
  isTransient,
} from "./llmTelemetry.js";

const TIMEOUT_MS      = 30_000;
const RETRY_BACKOFF_MS = 500;

// ── OpenAI tool-calling types (subset we use) ──────────────
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  // assistant-only
  tool_calls?: LLMToolCall[];
  // tool-only
  tool_call_id?: string;
  name?: string;
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LLMToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  providerUsed: string;
  ms: number;
}

// ── Public dispatch ──────────────────────────────────────────────

export interface RunLLMOpts {
  /** When true, dispatch WITHOUT `tools` / `tool_choice` so the model
   * is forced to emit a plain text answer. Used by the admin agent
   * after exhausting its tool-call loop budget to guarantee the user
   * always gets a final reply (Llama models occasionally keep
   * re-issuing the same tool call instead of summarising the result). */
  forceText?: boolean;
}

export async function runLLM(
  messages: LLMMessage[],
  tools: LLMToolDef[],
  opts: RunLLMOpts = {},
): Promise<LLMResponse> {
  const all = await loadProviders();
  if (all.length === 0) {
    throw new Error("No LLM providers configured (set CEREBRAS_API_KEY/GROQ_API_KEY or use add_llm_provider)");
  }

  // Reorder so demoted providers sink to the end of the chain. We don't
  // remove them entirely — last-resort use is still better than failing
  // the whole call if every other provider is also down.
  const ordered = await reorderForBreaker(all);

  // Normalize content once per call (cheap; same array gets dispatched
  // to multiple providers on fallback).
  const normalized = normalizeMessages(messages);
  const effectiveTools = opts.forceText ? [] : tools;

  const errors: string[] = [];
  for (const p of ordered) {
    const t0 = Date.now();
    try {
      const res = await callWithRetry(p, normalized, effectiveTools);
      const ms  = Date.now() - t0;
      markUsed(p.id).catch(() => { /* best-effort */ });
      recordSuccess(p.id, ms).catch(() => { /* best-effort */ });
      return { ...res, providerUsed: p.id, ms };
    } catch (e) {
      const ms  = Date.now() - t0;
      const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
      const kind = (e as { __kind?: ReturnType<typeof classifyFailure> }).__kind
        ?? classifyFailure(e);
      L.warn("adminAgent", `${p.id} failed`, { err: msg, ms, kind });
      recordFailure(p.id, kind, msg, ms).catch(() => { /* best-effort */ });
      errors.push(`${p.id}: ${msg}`);
    }
  }
  throw new Error(`All LLM providers failed: ${errors.join(" | ")}`);
}

// ── Retry wrapper ────────────────────────────────────────────────

async function callWithRetry(
  cfg: LLMProvider,
  messages: LLMMessage[],
  tools: LLMToolDef[],
): Promise<{ content: string | null; toolCalls: LLMToolCall[] }> {
  try {
    return await callOpenAICompat(cfg, messages, tools);
  } catch (e) {
    const status = (e as { __httpStatus?: number }).__httpStatus;
    const kind   = classifyFailure(e, status);
    if (!isTransient(kind)) {
      // Tag the error with the classification so the dispatcher can
      // record telemetry without re-classifying.
      (e as { __kind?: typeof kind }).__kind = kind;
      throw e;
    }
    // Transient → wait briefly and retry once.
    await sleep(RETRY_BACKOFF_MS);
    try {
      return await callOpenAICompat(cfg, messages, tools);
    } catch (e2) {
      const status2 = (e2 as { __httpStatus?: number }).__httpStatus;
      const kind2   = classifyFailure(e2, status2);
      (e2 as { __kind?: typeof kind2 }).__kind = kind2;
      throw e2;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Breaker order ────────────────────────────────────────────────

/** Push currently-demoted providers to the end of the chain while
 * keeping their relative priorities. */
async function reorderForBreaker(providers: LLMProvider[]): Promise<LLMProvider[]> {
  const flags = await Promise.all(providers.map(p => isDemoted(p.id).catch(() => false)));
  const healthy: LLMProvider[] = [];
  const demoted: LLMProvider[] = [];
  providers.forEach((p, i) => (flags[i] ? demoted : healthy).push(p));
  return [...healthy, ...demoted];
}

// ── Message normalization ────────────────────────────────────────

/** OpenAI accepts `content: string | array | null`. Cloudflare's
 * compat endpoint only accepts string. Coerce non-string non-null
 * values to a JSON string so messages survive every provider.
 *
 * Special-case: assistant messages that carry `tool_calls` should
 * keep an empty string instead of `null` to satisfy Cloudflare's
 * stricter validator. */
function normalizeMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map(m => {
    const isAssistantToolCall =
      m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

    if (m.content == null) {
      // Convert null/undefined → "" for assistant tool_calls; preserve
      // null for cases that explicitly want it (OpenAI spec compliant).
      return { ...m, content: isAssistantToolCall ? "" : (m.content ?? null) };
    }
    if (typeof m.content === "string") return m;

    // Array / object → stringify so strict validators (Cloudflare) accept it.
    try {
      return { ...m, content: JSON.stringify(m.content) };
    } catch {
      return { ...m, content: String(m.content) };
    }
  });
}

// ── Single HTTP call ─────────────────────────────────────────────

async function callOpenAICompat(
  cfg: LLMProvider,
  messages: LLMMessage[],
  tools: LLMToolDef[],
): Promise<{ content: string | null; toolCalls: LLMToolCall[] }> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model:       cfg.model,
    messages,
    temperature: 0.3,
    max_tokens:  2048,
  };
  // Only attach tools when there are any — empty arrays make some
  // providers reject the request.
  if (tools.length > 0) {
    body.tools       = tools;
    body.tool_choice = "auto";
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      const err = new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`) as
        Error & { __httpStatus?: number };
      err.__httpStatus = r.status;
      throw err;
    }
    const j = await r.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: LLMToolCall[];
        };
      }>;
    };
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new Error("empty response (no choices)");
    return {
      content:   msg.content ?? null,
      toolCalls: msg.tool_calls ?? [],
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Streaming HTTP call (text-only, no tool calling) ─────────────

const STREAM_TIMEOUT_MS = 60_000; // longer timeout for streaming

async function* callOpenAICompatStream(
  cfg: LLMProvider,
  messages: LLMMessage[],
): AsyncGenerator<string> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model:       cfg.model,
    messages,
    temperature: 0.3,
    max_tokens:  2048,
    stream:      true,
  };
  // No tools — streaming is only used for final text responses.

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      const err = new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`) as
        Error & { __httpStatus?: number };
      err.__httpStatus = r.status;
      throw err;
    }
    if (!r.body) throw new Error("no response body for streaming");

    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const j = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string | null } }>;
          };
          const chunk = j.choices?.[0]?.delta?.content;
          if (chunk) yield chunk;
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Public streaming dispatch ────────────────────────────────────

export interface StreamLLMResult {
  fullText:     string;
  providerUsed: string;
  ms:           number;
}

/**
 * Stream a text-only LLM response (no tools). Calls `onChunk` for
 * each text fragment as it arrives from the provider.
 *
 * Falls back to non-streaming `runLLM` if the provider doesn't
 * support streaming (e.g. returns a non-SSE body).
 */
export async function runLLMStream(
  messages: LLMMessage[],
  onChunk: (text: string) => void,
): Promise<StreamLLMResult> {
  const all = await loadProviders();
  if (all.length === 0) {
    throw new Error("No LLM providers configured");
  }
  const ordered    = await reorderForBreaker(all);
  const normalized = normalizeMessages(messages);

  const errors: string[] = [];
  for (const p of ordered) {
    const t0 = Date.now();
    try {
      let fullText = "";
      for await (const chunk of callOpenAICompatStream(p, normalized)) {
        fullText += chunk;
        onChunk(chunk);
      }
      const ms = Date.now() - t0;
      markUsed(p.id).catch(() => {});
      recordSuccess(p.id, ms).catch(() => {});
      return { fullText: fullText || "(لا رد)", providerUsed: p.id, ms };
    } catch (e) {
      const ms  = Date.now() - t0;
      const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
      const kind = (e as { __kind?: ReturnType<typeof classifyFailure> }).__kind
        ?? classifyFailure(e);
      L.warn("adminAgent", `stream ${p.id} failed`, { err: msg, ms, kind });
      recordFailure(p.id, kind, msg, ms).catch(() => {});
      errors.push(`${p.id}: ${msg}`);
    }
  }

  // All streaming attempts failed — fall back to non-streaming
  L.warn("adminAgent", "all streaming providers failed, falling back to non-streaming");
  const fallback = await runLLM(messages, [], { forceText: true });
  if (fallback.content) onChunk(fallback.content);
  return {
    fullText:     fallback.content || "(لا رد)",
    providerUsed: fallback.providerUsed + " (non-stream fallback)",
    ms:           fallback.ms,
  };
}

// ── Test-only exports ────────────────────────────────────────────
// Internal helpers exposed for unit tests. Not part of the runtime API.
export const __test = { normalizeMessages, reorderForBreaker };
