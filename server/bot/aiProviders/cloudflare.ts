// Cloudflare Workers AI — free tier ~10k neurons/day. Custom request
// shape (not OpenAI-compat by default, though they have a beta
// /v1/chat/completions endpoint per account; we use the documented
// per-model endpoint to be conservative).
// docs: https://developers.cloudflare.com/workers-ai/

import { L } from "../logger.js";
import {
  CLOUDFLARE_AI_ACCOUNT_ID,
  CLOUDFLARE_AI_API_TOKEN,
  TIMEOUT_AI_PROVIDER,
} from "../config.js";
import type { AIProvider, SummaryRequest, SummaryResponse } from "./types.js";
import { SYSTEM_INSTRUCTION, buildUserPrompt, parseProviderResponse } from "./prompt.js";

const CF_MODEL = "@cf/meta/llama-3.1-70b-instruct";

async function callCloudflare(req: SummaryRequest): Promise<SummaryResponse> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${CF_MODEL}`;
  const body = {
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user",   content: buildUserPrompt(req.bookName, req.context) },
    ],
    // Bumped 1024 → 2048 to fit the structured non-fiction format
    // (4 sections + bullets + paragraph). Arabic tokens 1.5-2×
    // English so the old budget truncated mid-output.
    max_tokens: 2048,
    temperature: 0.3,
  };

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_AI_PROVIDER);
  const t0   = Date.now();
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${CLOUDFLARE_AI_API_TOKEN}`,
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Cloudflare AI HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json() as {
      result?: { response?: string };
      success?: boolean;
      errors?: { message?: string }[];
    };
    if (j.success === false) {
      throw new Error(`Cloudflare AI: ${j.errors?.[0]?.message || "unknown"}`);
    }
    const text = j.result?.response || "";
    if (!text) throw new Error("Cloudflare AI: empty response");
    const out = parseProviderResponse(text, "cloudflare-llama-3.1-70b", "context");
    L.info("ai", "cloudflare-llama-3.1-70b ok", { ms: Date.now() - t0, type: out.bookType });
    return out;
  } catch (e: any) {
    L.warn("ai", "cloudflare-llama-3.1-70b failed", { ms: Date.now() - t0, err: String(e).slice(0, 200) });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export const cloudflareProvider: AIProvider = {
  name:         "cloudflare-llama-3.1-70b",
  priority:     16,
  supportsPDF:  false,
  // Cloudflare bills neurons (compute units) not requests; a 70B chat
  // call burns roughly 50–80 neurons. 10k/day → ~150–200 calls.
  dailyQuota:   150,
  isConfigured: () => !!(CLOUDFLARE_AI_ACCOUNT_ID && CLOUDFLARE_AI_API_TOKEN),
  call:         callCloudflare,
};
