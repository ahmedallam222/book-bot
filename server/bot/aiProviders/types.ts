// ══════════════════════════════════════════════════════════
// AI Providers — shared types + provider interface
// ══════════════════════════════════════════════════════════
// Every concrete provider (gemini.ts, groq.ts, …) implements
// `AIProvider` so the registry can iterate them uniformly.
//
// Two capability tiers:
//   - PDF-native (only Gemini today): accepts a PDF buffer + prompt
//   - text-only: accepts a plain-text context + prompt
//
// The orchestrator (summary.ts) tries PDF-native providers first
// when a PDF is available, then falls back to text-only providers
// using web-scraped context (Wikipedia, etc).

export interface SummaryRequest {
  bookName: string;
  // For PDF-native providers. The summary orchestrator passes a
  // freshly-downloaded PDF buffer here. Capped at PROVIDER_MAX_PDF_BYTES
  // (~18 MB) by the caller — providers may further truncate if needed.
  pdfBuffer?: Buffer;
  // For text-only providers (and as a hint to PDF providers). Anything
  // we already know about the book — Wikipedia summary, Goodreads
  // genre, our own metaTitle from pdfValidator, etc.
  context?: string;
  // Free vs premium routing key. Premium users get routed to higher-
  // quality / paid providers (you.com) ahead of the free stack.
  premium?: boolean;
}

export interface SummaryResponse {
  summary:    string;
  // Loose category — drives downstream UX:
  // "novel" → spoiler-free framing in the prompt; bot shows
  //   "📖 ملخص بدون حرق" label on the button.
  // anything else → standard summary.
  bookType:   "novel" | "non-fiction" | "poetry" | "religion" | "textbook" | "unknown";
  spoilerLevel: "critical" | "moderate" | "none";
  language:   "ar" | "en" | "mixed" | "unknown";
  // Provenance for cache + telemetry. Helps debugging "why was this
  // summary so bad?" — we know which provider and which input shape.
  providerName: string;
  source:       "pdf" | "context" | "wikipedia_only";
}

export interface AIProvider {
  // Stable string for telemetry keys + circuit-breaker keys + logs.
  // Keep it short, dash-separated, lowercase: e.g. "gemini-1.5-flash".
  name: string;
  // 1 = first to try. Lower number = higher priority. Multiple
  // providers can share a priority — the registry will iterate them
  // in declaration order within the same tier.
  priority: number;
  // True if this provider accepts PDF input (multimodal). Drives the
  // orchestrator's two-pass logic.
  supportsPDF: boolean;
  // Daily quota declared by the upstream free tier. Used to short-
  // circuit before we hit a 429 (we track our own counter in Redis).
  // Set to a conservative number; we'd rather skip slightly early than
  // waste a request on a known-exhausted provider.
  dailyQuota: number;
  // Returns true if the provider has its required env vars set. The
  // registry filters out unconfigured providers at boot.
  isConfigured(): boolean;
  // Premium-only providers (you.com) return true here. The orchestrator
  // skips them for non-premium users.
  premiumOnly?: boolean;
  // The actual call. May throw on transport / quota / parse errors —
  // the registry catches and moves to the next provider.
  call(req: SummaryRequest): Promise<SummaryResponse>;
}

// JSON shape we ask every provider to return. Putting this in shared
// types lets every provider use the exact same prompt + parser, so we
// don't drift across providers.
export interface ProviderJSONOutput {
  summary?:       string;
  book_type?:     string;
  spoiler_level?: string;
  language?:      string;
}

// Default 18 MB cap on inline PDF input. Gemini's hard ceiling is
// 20 MB inline; we leave headroom for the prompt + response.
export const PROVIDER_MAX_PDF_BYTES = 18 * 1024 * 1024;
