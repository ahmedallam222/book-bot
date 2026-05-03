// You.com Smart API — premium-tier provider for paying users.
// User has $99 of pre-paid credit, so we route premium-flagged
// requests here ahead of the free stack for higher-quality, more
// citation-rich summaries.
// docs: https://documentation.you.com/api-reference

import { L } from "../logger.js";
import { YOU_COM_API_KEY, TIMEOUT_AI_PROVIDER } from "../config.js";
import type { AIProvider, SummaryRequest, SummaryResponse } from "./types.js";
import { SYSTEM_INSTRUCTION, buildUserPrompt, parseProviderResponse } from "./prompt.js";

async function callYouCom(req: SummaryRequest): Promise<SummaryResponse> {
  const url = "https://chat-api.you.com/smart";
  const body = {
    query:        buildUserPrompt(req.bookName, req.context),
    instructions: SYSTEM_INSTRUCTION,
    // Smart endpoint web-grounds answers — perfect for book summaries
    // where the model can cite Goodreads/publisher pages.
  };

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_AI_PROVIDER);
  const t0   = Date.now();
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key":    YOU_COM_API_KEY,
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`You.com HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json() as {
      answer?: string;
      response?: string;
    };
    const text = j.answer || j.response || "";
    if (!text) throw new Error("You.com: empty response");
    const out = parseProviderResponse(text, "youcom-smart", "context");
    L.info("ai", "youcom-smart ok", { ms: Date.now() - t0, type: out.bookType });
    return out;
  } catch (e: any) {
    L.warn("ai", "youcom-smart failed", { ms: Date.now() - t0, err: String(e).slice(0, 200) });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export const youcomProvider: AIProvider = {
  name:         "youcom-smart",
  // priority 0 → tried first when the request is flagged premium.
  // For non-premium requests the registry skips this provider entirely
  // (premiumOnly=true).
  priority:     0,
  supportsPDF:  false,
  premiumOnly:  true,
  // No declared daily cap — this is paid usage. We track local counter
  // anyway so admins can see spend per day.
  dailyQuota:   100000,
  isConfigured: () => !!YOU_COM_API_KEY,
  call:         callYouCom,
};
