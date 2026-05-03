// ══════════════════════════════════════════════════════════
// Google Gemini providers (PDF native — primary tier)
// ══════════════════════════════════════════════════════════
// Gemini Flash is the only free model in the stack that accepts
// PDF input directly. We register three flavours (1.5/2.0/2.5)
// behind one API key — each has its own free-tier daily quota
// (~1500 RPD), so registering all three triples our PDF capacity.
//
// docs: https://ai.google.dev/gemini-api/docs/document-processing

import { L } from "../logger.js";
import { GEMINI_API_KEY, TIMEOUT_AI_PROVIDER } from "../config.js";
import type { AIProvider, SummaryRequest, SummaryResponse } from "./types.js";
import { SYSTEM_INSTRUCTION, buildUserPrompt, parseProviderResponse } from "./prompt.js";

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

async function callGemini(
  modelId: string,
  req: SummaryRequest,
  providerName: string,
): Promise<SummaryResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;

  // Two-part input when PDF is present: PDF inline + text prompt.
  // We send a small response_mime_type=application/json hint so the
  // model is more likely to honor the strict-JSON instruction.
  const parts: GeminiPart[] = [];
  if (req.pdfBuffer) {
    parts.push({
      inline_data: {
        mime_type: "application/pdf",
        data: req.pdfBuffer.toString("base64"),
      },
    });
  }
  parts.push({ text: buildUserPrompt(req.bookName, req.context) });

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents:           [{ role: "user", parts }],
    generationConfig: {
      response_mime_type: "application/json",
      temperature:        0.3,
      maxOutputTokens:    1024,
    },
  };

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), TIMEOUT_AI_PROVIDER);
  try {
    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Gemini ${modelId} HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }
    const j = await r.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    if (!text) throw new Error(`Gemini ${modelId}: empty response`);
    return parseProviderResponse(text, providerName, req.pdfBuffer ? "pdf" : "context");
  } finally {
    clearTimeout(t);
  }
}

function makeGeminiProvider(
  name: string,
  modelId: string,
  priority: number,
): AIProvider {
  return {
    name,
    priority,
    supportsPDF: true,
    dailyQuota: 1500,
    isConfigured: () => !!GEMINI_API_KEY,
    call: async (req) => {
      const t0 = Date.now();
      try {
        const out = await callGemini(modelId, req, name);
        L.info("ai", `${name} ok`, { ms: Date.now() - t0, type: out.bookType, source: out.source });
        return out;
      } catch (e: any) {
        L.warn("ai", `${name} failed`, { ms: Date.now() - t0, err: String(e).slice(0, 200) });
        throw e;
      }
    },
  };
}

// Three Gemini variants share the same key but maintain separate quotas
// upstream — registering all three effectively triples our PDF budget.
// 2.5 Flash is newest/best-quality; 1.5/2.0 stay as deeper failover.
export const geminiProviders: AIProvider[] = [
  makeGeminiProvider("gemini-2.5-flash",  "gemini-2.5-flash",  1),
  makeGeminiProvider("gemini-2.0-flash",  "gemini-2.0-flash",  2),
  makeGeminiProvider("gemini-1.5-flash",  "gemini-1.5-flash",  3),
];
