// Groq — OpenAI-compatible, very fast Llama 3.3 70B inference.
// docs: https://console.groq.com/docs/api-reference

import { GROQ_API_KEY } from "../config.js";
import type { AIProvider } from "./types.js";
import { callOpenAICompat } from "./openaiCompat.js";

export const groqProvider: AIProvider = {
  name:         "groq-llama-3.3-70b",
  priority:     10,
  supportsPDF:  false,
  dailyQuota:   14400,
  isConfigured: () => !!GROQ_API_KEY,
  call: (req) => callOpenAICompat({
    providerName: "groq-llama-3.3-70b",
    baseUrl:      "https://api.groq.com/openai/v1",
    model:        "llama-3.3-70b-versatile",
    apiKey:       GROQ_API_KEY,
    jsonMode:     true,
  }, req),
};
