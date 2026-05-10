// Llama-on-Cloudflare topic-relevant book suggestions for the no-results
// branch. Audit follow-up #3.
//
// Why this exists:
//   When `searchAllSources` returns 0 results, the bot replies with a
//   generic fix-your-spelling tip ("اكتف بالعنوان / أضف اسم المؤلف /
//   تأكد من الإملاء"). That's correct *advice* but it doesn't move the
//   user forward — they're stuck guessing. Llama-3.1-8B can suggest
//   3 widely-known Arabic books in the same theme so the user has
//   actionable next searches without having to think.
//
// Why this is NOT a typo-correction layer:
//   That's #2 (transliteration correction) which runs *before* search
//   and tries to recover the intended query. This module runs *after*
//   search has confirmed nothing matched, and only proposes related
//   alternatives. Keeping the two concerns separate means we can tune
//   prompts independently and ship them in separate PRs.
//
// Telemetry counters (Redis):
//   tel:sugg:llama_used               umbrella, every call attempt
//   tel:sugg:llama_ok                 returned ≥1 suggestion
//   tel:sugg:llama_empty              returned 0 (parse failure / refusal)
//   tel:sugg:llama_cache_hit          served from Redis cache
//   tel:sugg:llama_http_error         CF API non-2xx
//   tel:sugg:llama_timeout            6s abort fired
//   tel:sugg:llama_other_error        any other exception
//   tel:sugg:llama_no_key             CF account or token missing

import { L } from "../logger.js";
import { redis } from "../redis.js";
import { canonicalizeForCache } from "../text.js";
import { createHash } from "crypto";
import {
  CLOUDFLARE_AI_ACCOUNT_ID,
  CLOUDFLARE_AI_API_TOKEN,
} from "../config.js";

const LLAMA_SUGGEST_MODEL      = "@cf/meta/llama-3.1-8b-instruct";
// 6s tighter than the validator's 8s — the no-results path already
// added latency through search/verify, and we don't want to make the
// tail worse. If Llama is slow we silently fall back to the generic
// message.
const LLAMA_SUGGEST_TIMEOUT_MS = 6000;
// 7-day cache: the corpus of "books similar to X" is stable on that
// horizon, and we don't want to burn neurons re-asking the same query.
const LLAMA_SUGGEST_CACHE_TTL_SEC = 7 * 24 * 3600;
const SUGGEST_TARGET_COUNT     = 3;

export const TEL_SUGG_LLAMA_USED         = "tel:sugg:llama_used";
export const TEL_SUGG_LLAMA_OK           = "tel:sugg:llama_ok";
export const TEL_SUGG_LLAMA_EMPTY        = "tel:sugg:llama_empty";
export const TEL_SUGG_LLAMA_CACHE_HIT    = "tel:sugg:llama_cache_hit";
export const TEL_SUGG_LLAMA_HTTP_ERROR   = "tel:sugg:llama_http_error";
export const TEL_SUGG_LLAMA_TIMEOUT      = "tel:sugg:llama_timeout";
export const TEL_SUGG_LLAMA_OTHER_ERROR  = "tel:sugg:llama_other_error";
export const TEL_SUGG_LLAMA_NO_KEY       = "tel:sugg:llama_no_key";

function suggestCacheKey(bookName: string): string {
  // Same canonicalisation we use for search-cache keys, so e.g.
  // "العادات الذرية" and "العادات الذريه" hit the same bucket.
  const canon = canonicalizeForCache(bookName);
  const hash  = createHash("sha256").update(canon).digest("hex").slice(0, 16);
  return `sugg:llama:${hash}`;
}

/**
 * Suggest up to 3 topic-relevant Arabic book titles from Llama.
 *
 * Returns:
 *   - string[] of length 1..3 (already trimmed, deduplicated, sanitised)
 *   - []       if anything went wrong, CF is unconfigured, or Llama
 *              produced unparseable output. Caller MUST treat this as
 *              "suggestions unavailable" and fall back to its existing
 *              generic message.
 *
 * Never throws. Every failure path increments a distinct counter so ops
 * can tell apart "Llama unhealthy" from "user-input untriggerable".
 */
export async function getLlamaSuggestions(bookName: string): Promise<string[]> {
  if (!bookName || bookName.trim().length < 2) return [];

  if (!CLOUDFLARE_AI_ACCOUNT_ID || !CLOUDFLARE_AI_API_TOKEN) {
    redis.incr(TEL_SUGG_LLAMA_NO_KEY).catch(() => {});
    return [];
  }

  const cacheKey = suggestCacheKey(bookName);

  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      redis.incr(TEL_SUGG_LLAMA_CACHE_HIT).catch(() => {});
      try {
        const parsed = JSON.parse(cached) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
        }
      } catch { /* corrupt cache, fall through to fresh call */ }
    }
  } catch { /* redis miss → fall through */ }

  redis.incr(TEL_SUGG_LLAMA_USED).catch(() => {});

  const prompt = [
    `You are suggesting Arabic-language books similar to a book a user just searched.`,
    ``,
    `User searched: "${bookName}"`,
    ``,
    `Suggest exactly ${SUGGEST_TARGET_COUNT} popular Arabic-language books that:`,
    `1. Are in the same theme/genre as the user's search.`,
    `2. Are widely-known and likely available as free PDFs in Arabic catalogs.`,
    `3. Are DIFFERENT books from the one the user searched (not editions or translations of the same book).`,
    ``,
    `Reply with EXACTLY ${SUGGEST_TARGET_COUNT} lines. Each line is ONE book title in Arabic, optionally followed by " — " and the author's name. No numbering, no bullets, no quotes, no commentary, no English.`,
  ].join("\n");

  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${LLAMA_SUGGEST_MODEL}`;
  const body = {
    messages: [
      { role: "system", content: "You are a concise Arabic-literate book recommender. Output only the requested lines." },
      { role: "user",   content: prompt },
    ],
    max_tokens:  192,   // ~3 short Arabic lines fit comfortably
    temperature: 0.4,   // a touch of variety so retries differ
  };

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), LLAMA_SUGGEST_TIMEOUT_MS);
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
      redis.incr(TEL_SUGG_LLAMA_HTTP_ERROR).catch(() => {});
      L.warn("llamaSuggestions", `CF AI HTTP ${r.status} — no suggestions`, {
        ms: Date.now() - t0,
      });
      return [];
    }
    const j = await r.json() as {
      result?:  { response?: string };
      success?: boolean;
      errors?:  { message?: string }[];
    };
    if (j.success === false) {
      redis.incr(TEL_SUGG_LLAMA_HTTP_ERROR).catch(() => {});
      return [];
    }
    const suggestions = parseSuggestionLines(j.result?.response || "");
    if (suggestions.length === 0) {
      redis.incr(TEL_SUGG_LLAMA_EMPTY).catch(() => {});
      L.info("llamaSuggestions", "empty — unparseable", {
        ms: Date.now() - t0,
        raw: (j.result?.response || "").slice(0, 80),
      });
      return [];
    }
    redis.incr(TEL_SUGG_LLAMA_OK).catch(() => {});
    L.info("llamaSuggestions", "ok", {
      ms:    Date.now() - t0,
      count: suggestions.length,
      book:  bookName.slice(0, 40),
    });
    redis.setex(cacheKey, LLAMA_SUGGEST_CACHE_TTL_SEC, JSON.stringify(suggestions))
      .catch(() => {});
    return suggestions;
  } catch (e) {
    const errStr   = String(e);
    const isTimeout = /AbortError|TimeoutError|aborted|timed?\s*out/i.test(errStr) ||
                      /AbortError|TimeoutError/.test((e as Error)?.name || "");
    if (isTimeout) {
      redis.incr(TEL_SUGG_LLAMA_TIMEOUT).catch(() => {});
    } else {
      redis.incr(TEL_SUGG_LLAMA_OTHER_ERROR).catch(() => {});
    }
    L.warn("llamaSuggestions", "error — no suggestions", {
      ms: Date.now() - t0, err: errStr.slice(0, 120),
    });
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Parse Llama's free-form reply into a clean list. Tolerates leading
 * digits/bullets/punctuation and surrounding quotes — Llama-8B is
 * unreliable at strict-format compliance and we don't want to discard
 * an otherwise-perfect suggestion just because it started with "1. ".
 *
 * Exported for unit testing.
 */
export function parseSuggestionLines(raw: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    let s = line.trim();
    if (!s) continue;
    // strip leading bullet / list markers
    s = s.replace(/^\s*[-*•◦▪▫]\s+/, "");
    s = s.replace(/^\s*\d+[.)]\s+/, "");
    // strip surrounding quotes
    s = s.replace(/^["'«»]+|["'«»]+$/g, "");
    s = s.trim();
    if (s.length < 3) continue;
    // reject lines that are obviously not book titles (English-only,
    // "Here are 3 suggestions:", numbered headers, etc.)
    if (/^(here|sure|certainly|of course|the following|these are)/i.test(s)) continue;
    // require at least some Arabic content — protects against Llama
    // ignoring the "no English" instruction.
    if (!/[\u0600-\u06FF]/.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= SUGGEST_TARGET_COUNT) break;
  }
  return out;
}
