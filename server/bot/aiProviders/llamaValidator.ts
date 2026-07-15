// Llama-on-Cloudflare PDF prefilter.
//
// Why a separate file:
//   `server/bot/aiProviders/cloudflare.ts` calls a 70B model for the
//   summary engine — heavy compute, ~50–80 neurons/call → ~150 free
//   calls/day. Our use-case here is a lightweight YES/NO classifier
//   that runs ahead of Mistral on every PDF candidate, so we need a
//   smaller / cheaper model. The 8B-instruct model burns ~4–8
//   neurons/call → ~1500 free calls/day on the same Workers AI plan.
//
// Why a prefilter (not a replacement):
//   Mistral remains the source of truth — Llama 8B is permissive on
//   nuanced cases (translations, ambiguous filenames). We trust Llama
//   only when it's unambiguously certain (response starts exactly with
//   "YES" or "NO"). Anything else falls through to Mistral. Crucially,
//   we *skip the prefilter entirely* on cross-language pairs because
//   Mistral has the few-shot examples (P1 audit, 2026-05-09) that
//   teach it to accept "العادات الذرية" ↔ "Atomic Habits". Asking
//   Llama 8B those questions risks false NOs that would block real
//   matches before the better model gets a chance.
//
// Telemetry counters (kept distinct from Mistral's):
//   tel:pdf:llama_used               umbrella, like tel:pdf:mistral_used
//   tel:pdf:llama_yes                Llama said YES, saved a Mistral call
//   tel:pdf:llama_no                 Llama said NO,  saved a Mistral call
//   tel:pdf:llama_uncertain          Llama said UNSURE / ambiguous → Mistral
//   tel:pdf:llama_http_error         CF API non-2xx → fall through
//   tel:pdf:llama_timeout            CF API timed out → fall through
//   tel:pdf:llama_other_error        unexpected exception → fall through
//   tel:pdf:llama_no_key             CF account/token not configured
//   tel:pdf:llama_skipped_crosslang  intentionally skipped for translation pair

import { L } from "../logger.js";
import { redis } from "../redis.js";
import {
  CLOUDFLARE_AI_ACCOUNT_ID,
  CLOUDFLARE_AI_API_TOKEN,
} from "../config.js";

// Smallest Llama model on Cloudflare Workers AI. Free tier comfortable.
const LLAMA_VALIDATOR_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Tighter timeout than Mistral (8s vs 45s for the AI summary providers).
// Llama 8B on CF returns in <2s for short prompts; if it takes longer we
// prefer to fall through to Mistral than block the user.
const LLAMA_VALIDATOR_TIMEOUT_MS = 8000;

// Counter constants. Exported so tests can grep the bundle for them
// and so any other module can record without duplicating the strings.
export const TEL_LLAMA_USED              = "tel:pdf:llama_used";
export const TEL_LLAMA_YES               = "tel:pdf:llama_yes";
export const TEL_LLAMA_NO                = "tel:pdf:llama_no";
export const TEL_LLAMA_UNCERTAIN         = "tel:pdf:llama_uncertain";
export const TEL_LLAMA_HTTP_ERROR        = "tel:pdf:llama_http_error";
export const TEL_LLAMA_TIMEOUT           = "tel:pdf:llama_timeout";
export const TEL_LLAMA_OTHER_ERROR       = "tel:pdf:llama_other_error";
export const TEL_LLAMA_NO_KEY            = "tel:pdf:llama_no_key";
export const TEL_LLAMA_SKIPPED_CROSSLANG = "tel:pdf:llama_skipped_crosslang";

export type LlamaPrefilterVerdict = "yes" | "no" | null;

interface PrefilterArgs {
  bookName:        string;
  metaTitle:       string;       // "" when missing or garbage
  promptFilename:  string;       // human-readable filename / decoded slug
  isCrossLang:     boolean;      // skip prefilter when true
}

/**
 * Run a YES/NO prefilter against Llama-3.1-8B on Cloudflare Workers AI.
 *
 * Returns:
 *   "yes" | "no"  → caller can short-circuit Mistral (and cache verdict)
 *   null          → caller MUST fall through to Mistral (or its own
 *                   fail-open/closed policy when Mistral isn't configured)
 *
 * Never throws — every failure mode increments a counter and returns null.
 */
export async function askLlamaPrefilter(args: PrefilterArgs): Promise<LlamaPrefilterVerdict> {
  const { bookName, metaTitle, promptFilename, isCrossLang } = args;

  if (!CLOUDFLARE_AI_ACCOUNT_ID || !CLOUDFLARE_AI_API_TOKEN) {
    redis.incr(TEL_LLAMA_NO_KEY).catch(() => {});
    return null;
  }

  // Mistral has translation few-shot examples (P1, audit 2026-05-09) that
  // Llama 8B does not. Skipping crosslang preserves that nuance.
  if (isCrossLang) {
    redis.incr(TEL_LLAMA_SKIPPED_CROSSLANG).catch(() => {});
    return null;
  }

  const lines: string[] = [
    `You are verifying whether a PDF file contains the book the user requested.`,
    `Requested book: "${bookName}"`,
  ];
  if (metaTitle)      lines.push(`PDF metadata title: "${metaTitle}"`);
  else                lines.push(`(PDF metadata title is empty)`);
  if (promptFilename) lines.push(`PDF filename / URL hint: "${promptFilename}"`);
  else                lines.push(`(no filename hint)`);
  lines.push(
    ``,
    `Decide YES, NO, or UNSURE using these rules:`,
    `1) YES — the metadata or filename names the same book in any language, transliteration, or translation (extra words like "pdf", "كتاب", site name, year are fine).`,
    `2) NO  — the metadata or filename clearly names a DIFFERENT specific book.`,
    `3) NO  — the metadata or filename ONLY contains an author's name, but not the requested book title.`,
    `4) UNSURE — anything else: ambiguous filename, only digits / IDs, no useful signal, conflicting evidence.`,
    `Reply with EXACTLY ONE WORD: YES, NO, or UNSURE. No punctuation. No explanation.`,
  );

  const url  = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${LLAMA_VALIDATOR_MODEL}`;
  const body = {
    messages: [
      { role: "system", content: "You are a strict, terse classifier. Reply with one word only." },
      { role: "user",   content: lines.join("\n") },
    ],
    max_tokens:  8,    // YES / NO / UNSURE all fit in 1–2 tokens
    temperature: 0,
  };

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), LLAMA_VALIDATOR_TIMEOUT_MS);
  const t0   = Date.now();
  redis.incr(TEL_LLAMA_USED).catch(() => {});
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
      redis.incr(TEL_LLAMA_HTTP_ERROR).catch(() => {});
      L.warn("llamaValidator", `CF AI HTTP ${r.status} — falling through to Mistral`, {
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
      redis.incr(TEL_LLAMA_HTTP_ERROR).catch(() => {});
      L.warn("llamaValidator", `CF AI failure — falling through`, {
        err: j.errors?.[0]?.message?.slice(0, 120),
      });
      return null;
    }
    const text = (j.result?.response || "").trim().toUpperCase();
    // Strict parse: response must start with the verdict word, optionally
    // followed by punctuation/whitespace. Anything else → uncertain.
    if (/^YES\b/.test(text)) {
      redis.incr(TEL_LLAMA_YES).catch(() => {});
      L.info("llamaValidator", "verdict=YES", {
        ms: Date.now() - t0, book: bookName.slice(0, 40),
      });
      return "yes";
    }
    if (/^NO\b/.test(text)) {
      redis.incr(TEL_LLAMA_NO).catch(() => {});
      L.info("llamaValidator", "verdict=NO", {
        ms: Date.now() - t0, book: bookName.slice(0, 40),
      });
      return "no";
    }
    // UNSURE, empty, or any noisier reply → don't trust → Mistral.
    redis.incr(TEL_LLAMA_UNCERTAIN).catch(() => {});
    L.info("llamaValidator", "verdict=UNSURE", {
      ms:   Date.now() - t0,
      book: bookName.slice(0, 40),
      raw:  text.slice(0, 30),
    });
    return null;
  } catch (e) {
    const errStr   = String(e);
    const isTimeout = /AbortError|TimeoutError|aborted|timed?\s*out/i.test(errStr) ||
                      /AbortError|TimeoutError/.test((e as Error)?.name || "");
    if (isTimeout) {
      redis.incr(TEL_LLAMA_TIMEOUT).catch(() => {});
      L.warn("llamaValidator", "timeout — falling through", { ms: Date.now() - t0 });
    } else {
      redis.incr(TEL_LLAMA_OTHER_ERROR).catch(() => {});
      L.warn("llamaValidator", "error — falling through", {
        ms: Date.now() - t0, err: errStr.slice(0, 120),
      });
    }
    return null;
  } finally {
    clearTimeout(t);
  }
}
