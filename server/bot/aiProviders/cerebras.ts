// Cerebras — fastest free inference (~2000 tok/sec on Llama 3.3 70B).
// OpenAI-compatible. docs: https://inference-docs.cerebras.ai

import { CEREBRAS_API_KEY } from "../config.js";
import type { AIProvider } from "./types.js";
import { callOpenAICompat } from "./openaiCompat.js";

export const cerebrasProvider: AIProvider = {
  name:         "cerebras-llama-3.3-70b",
  priority:     11,
  supportsPDF:  false,
  // Cerebras's published free-tier RPD varies by model; we set a
  // conservative number well under the announced limit so we don't
  // race their server-side counter.
  dailyQuota:   14400,
  isConfigured: () => !!CEREBRAS_API_KEY,
  call: (req) => callOpenAICompat({
    providerName: "cerebras-llama-3.3-70b",
    baseUrl:      "https://api.cerebras.ai/v1",
    model:        "llama-3.3-70b",
    apiKey:       CEREBRAS_API_KEY,
    jsonMode:     true,
  }, req),
};
