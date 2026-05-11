// ══════════════════════════════════════════════════════════
// Admin Agent — LLM dispatch with tool calling
// ══════════════════════════════════════════════════════════
// Calls OpenAI-compatible Chat Completions endpoints with function-
// calling. Provider list is loaded **dynamically** from Redis via
// llmProviders.ts so the admin can hot-swap API keys at runtime via
// the admin bot (`set_llm_provider`, `remove_llm_provider`).
//
// Default chain (when Redis is empty): Cerebras gpt-oss-120b → Groq
// gpt-oss-120b → Groq Llama 3.3 70B-versatile. All three are
// OpenAI-compatible and support `tools` + `tool_choice`.
//
// Why gpt-oss-120b: in our admin tests it produces ~3-5× richer
// multi-tool chains than Llama 3.3 70B — and it actually computes
// derived rates instead of replying "غير متاح".

import { L } from "../logger.js";
import { loadProviders, markUsed, type LLMProvider } from "./llmProviders.js";

const TIMEOUT_MS = 30_000;

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

export async function runLLM(
  messages: LLMMessage[],
  tools: LLMToolDef[],
): Promise<LLMResponse> {
  const providers = await loadProviders();
  if (providers.length === 0) {
    throw new Error("No LLM providers configured (set CEREBRAS_API_KEY/GROQ_API_KEY or use set_llm_provider)");
  }
  const errors: string[] = [];
  for (const p of providers) {
    const t0 = Date.now();
    try {
      const res = await callOpenAICompat(p, messages, tools);
      markUsed(p.id).catch(() => { /* best-effort */ });
      return { ...res, providerUsed: p.id, ms: Date.now() - t0 };
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
      L.warn("adminAgent", `${p.id} failed`, { err: msg, ms: Date.now() - t0 });
      errors.push(`${p.id}: ${msg}`);
    }
  }
  throw new Error(`All LLM providers failed: ${errors.join(" | ")}`);
}

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

  const ctrl = new AbortController();
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
      throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`);
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
