// GitHub Models — completely free, OpenAI-compatible at /inference,
// gated by a GitHub PAT with `models:read` scope.
// docs: https://docs.github.com/en/github-models

import { GITHUB_MODELS_TOKEN } from "../config.js";
import type { AIProvider } from "./types.js";
import { callOpenAICompat } from "./openaiCompat.js";

export const githubModelsProvider: AIProvider = {
  name:         "github-models-llama-3.3-70b",
  priority:     14,
  supportsPDF:  false,
  // Per-token RPD varies by tier. We pick a conservative middle and
  // let the circuit breaker handle real-world 429s.
  dailyQuota:   150,
  isConfigured: () => !!GITHUB_MODELS_TOKEN,
  call: (req) => callOpenAICompat({
    providerName: "github-models-llama-3.3-70b",
    baseUrl:      "https://models.inference.ai.azure.com",
    // Other models reachable via this same key without code changes:
    // "openai/gpt-4o-mini", "mistral-ai/mistral-large", "microsoft/phi-3.5-mini-instruct".
    model:        "meta/llama-3.3-70b-instruct",
    apiKey:       GITHUB_MODELS_TOKEN,
    // GitHub Models occasionally errors on response_format=json_object;
    // the shared parser is permissive enough to tolerate prose output.
    jsonMode:     false,
  }, req),
};
