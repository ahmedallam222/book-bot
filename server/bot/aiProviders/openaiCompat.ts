// ══════════════════════════════════════════════════════════
// OpenAI-compatible HTTP wrapper
// ══════════════════════════════════════════════════════════
// Six of our providers (Groq, Cerebras, OpenRouter, Sambanova,
// GitHub Models, Mistral) speak the OpenAI Chat Completions
// protocol. Centralising the call here avoids 6× the boilerplate
// — each provider just declares its base URL + model + auth header
// + extra headers if any.

import { L } from "../logger.js";
import { TIMEOUT_AI_PROVIDER } from "../config.js";
import type { SummaryRequest, SummaryResponse } from "./types.js";
import { SYSTEM_INSTRUCTION, buildUserPrompt, parseProviderResponse } from "./prompt.js";

export interface OpenAICompatConfig {
  providerName: string;            // for logs + telemetry
  baseUrl:      string;            // e.g. https://api.groq.com/openai/v1
  model:        string;
  apiKey:       string;
  extraHeaders?: Record<string, string>;
  // Some providers (GitHub Models) reject OpenAI's response_format
  // field; let providers opt out of forcing JSON mode. The shared
  // parser still handles non-JSON responses defensively.
  jsonMode?:    boolean;
}

export async function callOpenAICompat(
  cfg: OpenAICompatConfig,
  req: SummaryRequest,
): Promise<SummaryResponse> {
  const t0 = Date.now();
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model:    cfg.model,
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user",   content: buildUserPrompt(req.bookName, req.context) },
    ],
    temperature: 0.3,
    max_tokens:  1024,
  };
  if (cfg.jsonMode) body.response_format = { type: "json_object" };

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_AI_PROVIDER);
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
        ...(cfg.extraHeaders || {}),
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`${cfg.providerName} HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json() as {
      choices?: { message?: { content?: string } }[];
    };
    const text = j.choices?.[0]?.message?.content || "";
    if (!text) throw new Error(`${cfg.providerName}: empty response`);
    const out = parseProviderResponse(text, cfg.providerName, "context");
    L.info("ai", `${cfg.providerName} ok`, { ms: Date.now() - t0, type: out.bookType });
    return out;
  } catch (e: any) {
    L.warn("ai", `${cfg.providerName} failed`, { ms: Date.now() - t0, err: String(e).slice(0, 200) });
    throw e;
  } finally {
    clearTimeout(t);
  }
}
