// OpenRouter — gateway to many models behind one API. We register
// the free tier (suffix `:free`) so quota is genuinely shared with
// no surprise charges. docs: https://openrouter.ai/docs

import { OPENROUTER_API_KEY } from "../config.js";
import type { AIProvider } from "./types.js";
import { callOpenAICompat } from "./openaiCompat.js";

// OpenRouter recommends an HTTP-Referer header for free-tier
// attribution. The book-bot doesn't have a public site URL, so we
// send the GitHub repo as a stable identifier.
const OR_HEADERS = {
  "HTTP-Referer": "https://github.com/ahmedallam222/book-bot",
  "X-Title":      "book-bot",
};

export const openrouterProvider: AIProvider = {
  name:         "openrouter-llama-3.3-70b-free",
  priority:     13,
  supportsPDF:  false,
  // 200/day per free model is OpenRouter's public limit; we keep the
  // counter conservative.
  dailyQuota:   200,
  isConfigured: () => !!OPENROUTER_API_KEY,
  call: (req) => callOpenAICompat({
    providerName: "openrouter-llama-3.3-70b-free",
    baseUrl:      "https://openrouter.ai/api/v1",
    model:        "meta-llama/llama-3.3-70b-instruct:free",
    apiKey:       OPENROUTER_API_KEY,
    extraHeaders: OR_HEADERS,
    jsonMode:     true,
  }, req),
};
