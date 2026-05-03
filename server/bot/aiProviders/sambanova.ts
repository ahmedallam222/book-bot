// Sambanova — Llama 3.3 70B at 560 tok/sec (faster than Cerebras
// in our latency tests). OpenAI-compatible.
// docs: https://docs.sambanova.ai/cloud/docs/get-started/overview

import { SAMBANOVA_API_KEY } from "../config.js";
import type { AIProvider } from "./types.js";
import { callOpenAICompat } from "./openaiCompat.js";

export const sambanovaProvider: AIProvider = {
  name:         "sambanova-llama-3.3-70b",
  priority:     12,
  supportsPDF:  false,
  dailyQuota:   10000,
  isConfigured: () => !!SAMBANOVA_API_KEY,
  call: (req) => callOpenAICompat({
    providerName: "sambanova-llama-3.3-70b",
    baseUrl:      "https://api.sambanova.ai/v1",
    model:        "Meta-Llama-3.3-70B-Instruct",
    apiKey:       SAMBANOVA_API_KEY,
    jsonMode:     true,
  }, req),
};
