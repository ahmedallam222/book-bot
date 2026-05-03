// Mistral La Plateforme — already the validation backbone for
// pdfValidator.ts; reuse the same key for summary fallback.
// docs: https://docs.mistral.ai/api/

import { MISTRAL_API_KEY } from "../config.js";
import type { AIProvider } from "./types.js";
import { callOpenAICompat } from "./openaiCompat.js";

export const mistralProvider: AIProvider = {
  name:         "mistral-small-latest",
  priority:     15,
  supportsPDF:  false,
  // Free-tier rate-limited; we don't actually have a documented RPD
  // so this is a placeholder ceiling for our local counter.
  dailyQuota:   1000,
  isConfigured: () => !!MISTRAL_API_KEY,
  call: (req) => callOpenAICompat({
    providerName: "mistral-small-latest",
    baseUrl:      "https://api.mistral.ai/v1",
    model:        "mistral-small-latest",
    apiKey:       MISTRAL_API_KEY,
    jsonMode:     true,
  }, req),
};
