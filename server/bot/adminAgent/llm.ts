// ══════════════════════════════════════════════════════════
// Admin Agent — LLM dispatch with tool calling
// ══════════════════════════════════════════════════════════
// Calls Cerebras (OpenAI-compatible) Llama 3.3 70B with function-
// calling. Falls back to Groq Llama 3.3 70B if Cerebras fails.
// Both providers speak the OpenAI Chat Completions tools protocol,
// so we can share a single request/response shape.

import { L } from "../logger.js";
import { CEREBRAS_API_KEY, GROQ_API_KEY } from "../config.js";

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

interface LLMConfig {
  name:     string;
  baseUrl:  string;
  model:    string;
  apiKey:   string;
}

const PROVIDERS: LLMConfig[] = [
  {
    name:    "cerebras-llama-3.3-70b",
    baseUrl: "https://api.cerebras.ai/v1",
    model:   "llama-3.3-70b",
    apiKey:  CEREBRAS_API_KEY,
  },
  {
    name:    "groq-llama-3.3-70b",
    baseUrl: "https://api.groq.com/openai/v1",
    model:   "llama-3.3-70b-versatile",
    apiKey:  GROQ_API_KEY,
  },
];

export async function runLLM(
  messages: LLMMessage[],
  tools: LLMToolDef[],
): Promise<LLMResponse> {
  const errors: string[] = [];
  for (const p of PROVIDERS) {
    if (!p.apiKey) continue;
    const t0 = Date.now();
    try {
      const res = await callOpenAICompat(p, messages, tools);
      return { ...res, providerUsed: p.name, ms: Date.now() - t0 };
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
      L.warn("adminAgent", `${p.name} failed`, { err: msg, ms: Date.now() - t0 });
      errors.push(`${p.name}: ${msg}`);
    }
  }
  throw new Error(`All LLM providers failed: ${errors.join(" | ") || "none configured"}`);
}

async function callOpenAICompat(
  cfg: LLMConfig,
  messages: LLMMessage[],
  tools: LLMToolDef[],
): Promise<{ content: string | null; toolCalls: LLMToolCall[] }> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model:       cfg.model,
    messages,
    temperature: 0.2,
    max_tokens:  1024,
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
