// Llama-on-Cloudflare transliteration correction for the no-results
// branch. Audit follow-up #2 (P5).
//
// Why this exists:
//   When a user types a foreign author or title in Arabic by phonetic
//   guesswork — e.g. "كيف تتقبل و تكتشف ذاتك لي وتيدصي درايدن" instead of
//   "ويندي درايدن" — every downstream stage (search ranking, title-gate,
//   filename-relevance) is poisoned by the noisy token. The user never
//   sees a result, gets the generic fix-your-spelling tip, and gives up.
//
//   This module asks Llama-3.1-8B to look at the query and return a
//   corrected version (or the same string if it already looks fine).
//   The caller compares the two; if they differ, it retries the search
//   with the corrected query before giving up.
//
// Why this is NOT the suggestions module:
//   #3 (suggestions) runs *after* search confirmed nothing matched and
//   only proposes related alternatives. This (#2) runs *before* giving
//   up — it tries to recover the user's *intended* query. Composes
//   cleanly with #3: if transliteration still misses, the corrected
//   query feeds into the suggestions prompt for a better seed.
//
// Why this is NOT pre-search:
//   We could run this on every query, but ~99% of queries are spelled
//   fine and a CF call adds ~1s to the happy path. Triggering only on
//   no-results means we already paid the search cost; an extra Llama
//   call is justified by the chance of recovering a delivered PDF.
//
// Telemetry counters (Redis):
//   tel:tlit:llama_used               umbrella, every fresh CF call
//   tel:tlit:llama_corrected          Llama proposed a different query
//   tel:tlit:llama_unchanged          Llama said the query looks fine
//   tel:tlit:llama_cache_hit          served from Redis cache
//   tel:tlit:llama_http_error         CF API non-2xx
//   tel:tlit:llama_timeout            6s abort fired
//   tel:tlit:llama_other_error        any other exception
//   tel:tlit:llama_no_key             CF account or token missing
//   tel:tlit:retry_recovered          incremented by the caller when
//                                     the corrected query produced ≥1
//                                     search result (success metric)

import { L } from "../logger.js";
import { redis } from "../redis.js";
import { canonicalizeForCache } from "../text.js";
import { createHash } from "crypto";
import {
  CLOUDFLARE_AI_ACCOUNT_ID,
  CLOUDFLARE_AI_API_TOKEN,
} from "../config.js";

const LLAMA_TLIT_MODEL         = "@cf/meta/llama-3.1-8b-instruct";
// 6s — same budget as #3 suggestions. The user is already waiting on
// the search round-trip; an extra slow tail here defeats the purpose.
const LLAMA_TLIT_TIMEOUT_MS    = 6000;
// 7-day cache: a query that misspells "وتيدصي درايدن" today will be
// just as wrong tomorrow, and the canonical correction won't drift.
const LLAMA_TLIT_CACHE_TTL_SEC = 7 * 24 * 3600;
// Min input length below which we won't bother — too short to contain
// a meaningful transliteration. Matches buildNoResultMessage's gate.
const TLIT_MIN_QUERY_LEN       = 4;

export const TEL_TLIT_LLAMA_USED          = "tel:tlit:llama_used";
export const TEL_TLIT_LLAMA_CORRECTED     = "tel:tlit:llama_corrected";
export const TEL_TLIT_LLAMA_UNCHANGED     = "tel:tlit:llama_unchanged";
export const TEL_TLIT_LLAMA_CACHE_HIT     = "tel:tlit:llama_cache_hit";
export const TEL_TLIT_LLAMA_HTTP_ERROR    = "tel:tlit:llama_http_error";
export const TEL_TLIT_LLAMA_TIMEOUT       = "tel:tlit:llama_timeout";
export const TEL_TLIT_LLAMA_OTHER_ERROR   = "tel:tlit:llama_other_error";
export const TEL_TLIT_LLAMA_NO_KEY        = "tel:tlit:llama_no_key";
export const TEL_TLIT_RETRY_RECOVERED     = "tel:tlit:retry_recovered";

export type LlamaTransliterationResult = {
  /** Original user query (whitespace-trimmed). */
  original:  string;
  /** Llama-corrected query. May equal original if no change was needed. */
  corrected: string;
  /** Convenience: corrected !== original after normalisation. */
  changed:   boolean;
};

function tlitCacheKey(query: string): string {
  // Same canonicalisation we use for search-cache and #3 suggestions,
  // so equivalent malformed queries dedupe to the same Redis bucket.
  const canon = canonicalizeForCache(query);
  const hash  = createHash("sha256").update(canon).digest("hex").slice(0, 16);
  return `tlit:llama:${hash}`;
}

/**
 * Compare original vs corrected after normalising whitespace, case,
 * and trailing punctuation. We don't want to count an extra space or
 * a renamed punctuation character as a real "correction".
 */
export function isMeaningfulChange(original: string, corrected: string): boolean {
  if (!corrected) return false;
  const norm = (s: string) =>
    s.normalize("NFKC")
     .replace(/\s+/g, " ")
     .replace(/[.,،:؛!؟?]+$/u, "")
     .trim()
     .toLowerCase();
  return norm(original) !== norm(corrected);
}

/**
 * Parse Llama's reply, which is supposed to be a single line containing
 * the corrected query. Tolerates accidental quotes, leading bullet/list
 * markers, "Corrected:" / "Answer:" prefixes, and trailing punctuation.
 *
 * Exported for unit testing.
 */
export function parseTransliterationReply(raw: string): string {
  if (!raw) return "";
  // Take only the first non-empty line — Llama sometimes adds a
  // commentary line below the answer.
  let s = raw.split(/\r?\n/).find((l) => l.trim().length > 0) || "";
  s = s.trim();
  // strip "Corrected:" / "Answer:" / "Here is the corrected query:" etc.
  s = s.replace(/^\s*(corrected|answer|here\s+(is|are)(\s+the\s+\w+)?(\s+\w+)?)\s*[:\-—]\s*/i, "");
  // strip leading bullet / list markers
  s = s.replace(/^\s*[-*•◦▪▫]\s+/, "");
  s = s.replace(/^\s*\d+[.)]\s+/, "");
  // strip surrounding quotes
  s = s.replace(/^["'«»]+|["'«»]+$/g, "");
  // strip trailing terminator punctuation (Llama loves to add ".")
  s = s.replace(/[.!?؟،,;:]+$/u, "");
  s = s.trim();
  return s;
}

/**
 * Ask Llama to correct any garbled foreign-name transliteration in
 * `query`. Returns:
 *   - { original, corrected, changed: true }  if Llama proposed a
 *     meaningfully different version
 *   - { original, corrected, changed: false } if Llama said the query
 *     looks fine as-is (or its proposal was a no-op)
 *   - null on any failure (CF unconfigured / down / timeout / parse
 *     failure). Caller MUST treat null as "give up, fall through to
 *     the no-results branch".
 *
 * Never throws. Every failure path increments a distinct counter.
 */
export async function correctTransliteration(
  query: string,
): Promise<LlamaTransliterationResult | null> {
  const original = (query || "").trim();
  if (original.length < TLIT_MIN_QUERY_LEN) return null;

  if (!CLOUDFLARE_AI_ACCOUNT_ID || !CLOUDFLARE_AI_API_TOKEN) {
    redis.incr(TEL_TLIT_LLAMA_NO_KEY).catch(() => {});
    return null;
  }

  const cacheKey = tlitCacheKey(original);

  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      redis.incr(TEL_TLIT_LLAMA_CACHE_HIT).catch(() => {});
      try {
        const parsed = JSON.parse(cached) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          "corrected" in parsed &&
          typeof (parsed as { corrected: unknown }).corrected === "string"
        ) {
          const corrected = (parsed as { corrected: string }).corrected;
          return {
            original,
            corrected,
            changed: isMeaningfulChange(original, corrected),
          };
        }
      } catch { /* corrupt cache, fall through to fresh call */ }
    }
  } catch { /* redis miss → fall through */ }

  redis.incr(TEL_TLIT_LLAMA_USED).catch(() => {});

  const prompt = [
    `You are reviewing a book-search query that returned 0 results in Arabic catalogs.`,
    ``,
    `Query: "${original}"`,
    ``,
    `If the query contains a foreign author or title whose Arabic transliteration looks garbled or unusual (e.g. "وتيدصي درايدن" instead of "ويندي درايدن"), reply with the corrected query.`,
    ``,
    `If the query already looks like a valid Arabic title or a correctly-transliterated name, reply with the SAME query unchanged.`,
    ``,
    `Reply with EXACTLY ONE LINE: just the query (corrected or unchanged). No explanation, no quotes, no English commentary.`,
  ].join("\n");

  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${LLAMA_TLIT_MODEL}`;
  const body = {
    messages: [
      { role: "system", content: "You are a careful Arabic-literate transliteration corrector. Output only the requested single line." },
      { role: "user",   content: prompt },
    ],
    max_tokens:  96,
    temperature: 0.0, // determinism — same input should give same output
  };

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), LLAMA_TLIT_TIMEOUT_MS);
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
      redis.incr(TEL_TLIT_LLAMA_HTTP_ERROR).catch(() => {});
      L.warn("llamaTransliteration", `CF AI HTTP ${r.status} — give up`, {
        ms: Date.now() - t0,
      });
      return null;
    }
    const j = await r.json() as {
      result?:  { response?: string };
      success?: boolean;
      errors?:  { message?: string }[];
    };
    if (j.success === false) {
      redis.incr(TEL_TLIT_LLAMA_HTTP_ERROR).catch(() => {});
      return null;
    }
    const corrected = parseTransliterationReply(j.result?.response || "");
    if (!corrected || corrected.length < TLIT_MIN_QUERY_LEN) {
      // Treat unparseable / too-short replies as "unchanged" rather
      // than a hard failure — we don't want a flaky parser to dirty the
      // error counters.
      redis.incr(TEL_TLIT_LLAMA_UNCHANGED).catch(() => {});
      const result: LlamaTransliterationResult = { original, corrected: original, changed: false };
      redis.setex(cacheKey, LLAMA_TLIT_CACHE_TTL_SEC, JSON.stringify({ corrected: original }))
        .catch(() => {});
      return result;
    }

    const changed = isMeaningfulChange(original, corrected);
    if (changed) {
      redis.incr(TEL_TLIT_LLAMA_CORRECTED).catch(() => {});
    } else {
      redis.incr(TEL_TLIT_LLAMA_UNCHANGED).catch(() => {});
    }

    L.info("llamaTransliteration", changed ? "corrected" : "unchanged", {
      ms:        Date.now() - t0,
      original:  original.slice(0, 50),
      corrected: corrected.slice(0, 50),
    });

    const result: LlamaTransliterationResult = { original, corrected, changed };
    redis.setex(cacheKey, LLAMA_TLIT_CACHE_TTL_SEC, JSON.stringify({ corrected }))
      .catch(() => {});
    return result;
  } catch (e) {
    const errStr    = String(e);
    const isTimeout = /AbortError|TimeoutError|aborted|timed?\s*out/i.test(errStr) ||
                      /AbortError|TimeoutError/.test((e as Error)?.name || "");
    if (isTimeout) {
      redis.incr(TEL_TLIT_LLAMA_TIMEOUT).catch(() => {});
    } else {
      redis.incr(TEL_TLIT_LLAMA_OTHER_ERROR).catch(() => {});
    }
    L.warn("llamaTransliteration", "error — give up", {
      ms: Date.now() - t0, err: errStr.slice(0, 120),
    });
    return null;
  } finally {
    clearTimeout(t);
  }
}
