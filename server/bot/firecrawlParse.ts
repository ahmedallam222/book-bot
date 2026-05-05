// ══════════════════════════════════════════════════════════
// Firecrawl /parse + /scrape PDF helpers
// ══════════════════════════════════════════════════════════
//
// Two entry points:
//
//   parsePdfBuffer(buf, filename, opts)  →  POST /v2/parse  (multipart upload)
//     Used when we already have the PDF bytes in-hand (download.ts
//     already fetched the file for delivery; we reuse the buffer).
//
//   scrapeRemotePdf(url, opts)           →  POST /v1/scrape (URL based)
//     Used when we only have a public URL and don't want to spend
//     bandwidth downloading the file ourselves.
//
// Both return the same shape: extracted markdown + (optional) Firecrawl-
// generated summary. Markdown is the primary output — we feed it back
// to the AI provider stack as `context` for the text-only tier, which
// lets premium users skip the multimodal Gemini pipeline entirely
// (faster, cheaper, doesn't burn the free Gemini quota).
//
// Quota / rate-limit handling is shared with engine.ts via the same
// FC_QUOTA_EXCEEDED_KEY / FC_RATE_LIMITED_KEY guards — if engine.ts
// already paused Firecrawl, we no-op and let the caller fall back to
// the existing PDF-tier path.
//
// Credit accounting writes to `counter:firecrawl:credits:{date}` —
// the same key the dashboard reads in routes.ts:361. Approximate
// (we don't get exact credit cost back from the API) but good enough
// for the costs card.
//
// docs:
//   https://docs.firecrawl.dev/api-reference/endpoint/parse
//   https://docs.firecrawl.dev/api-reference/endpoint/scrape

import { L } from "./logger.js";
import { redis } from "./redis.js";
import { cairoDateString } from "./text.js";
import {
  FC_QUOTA_EXCEEDED_KEY,
  FC_RATE_LIMITED_KEY,
  FC_RATE_LIMITED_TTL_SEC,
  FC_QUOTA_TTL_SEC,
} from "./config.js";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "";
const FIRECRAWL_V1      = "https://api.firecrawl.dev/v1";
const FIRECRAWL_V2      = "https://api.firecrawl.dev/v2";

// PDF size cap before attempting Firecrawl. The /parse endpoint
// allows up to 50 MB but at >18 MB the upload alone burns 5–10s of
// the user's wait time — not worth it for a marginal-quality bump.
// Mirrors PROVIDER_MAX_PDF_BYTES so the same buffer fits both paths.
export const FIRECRAWL_PARSE_MAX_BYTES = 18 * 1024 * 1024;

// Per-call timeout. PDFs of 200+ pages take ~30–45s on Firecrawl's
// `auto` parser. We cap at 60s and let the caller fall back to the
// existing PDF tier on timeout — never block the summary handler
// for longer than that.
export const TIMEOUT_FC_PARSE = 60_000;

// Per-call timeout for /scrape on remote PDFs. Lower than /parse
// because the file size is bounded by Firecrawl's own download.
export const TIMEOUT_FC_SCRAPE_PDF = 45_000;

// What we ask Firecrawl to return. `markdown` is non-negotiable —
// it's what we feed downstream. `summary` is requested as a bonus
// (free with the same call) but never required: callers should treat
// it as "use if present, ignore if missing".
const FORMATS = ["markdown", "summary"] as const;

// PDF parser config. `auto` = text-first with OCR fallback; this
// catches both text-PDFs and scanned image PDFs without us having
// to detect ahead of time. `maxPages` bounds runtime — most book
// summaries don't benefit from more than ~50 pages of context, and
// every additional page adds parsing latency + summary noise.
const PARSERS = [
  { type: "pdf", mode: "auto", maxPages: 50 },
] as const;

export interface FirecrawlParseResult {
  ok:        boolean;
  markdown?: string;
  summary?:  string;
  /** Why the call returned ok=false. Useful for telemetry. */
  reason?:
    | "no_api_key"
    | "fc_paused"
    | "too_large"
    | "http_error"
    | "rate_limited"
    | "quota_exceeded"
    | "auth_error"
    | "empty_response"
    | "timeout"
    | "exception";
  /** HTTP status when reason="http_error". */
  status?: number;
  /** Provider call latency in ms (for logging / telemetry). */
  ms?:     number;
}

export function isFirecrawlParseConfigured(): boolean {
  return !!FIRECRAWL_API_KEY;
}

// Same gate engine.ts uses — if Firecrawl is rate-limited or out of
// credits, every endpoint will fail until the keys expire. Skip
// without burning a network round-trip.
async function isFirecrawlPaused(): Promise<boolean> {
  try {
    const [quota, rate] = await Promise.all([
      redis.get(FC_QUOTA_EXCEEDED_KEY),
      redis.get(FC_RATE_LIMITED_KEY),
    ]);
    return !!(quota || rate);
  } catch {
    // Redis unavailable → assume not paused. The Firecrawl call
    // itself will fail fast if the rate-limit is real.
    return false;
  }
}

// Approximate credit accounting for the dashboard. We don't get an
// exact credit cost back from /parse or /scrape, so we charge a flat
// rate per successful call. Tunable here without redeploying the
// dashboard.
const PARSE_CREDIT_COST  = 5;  // Firecrawl /parse is ~5 credits per call
const SCRAPE_CREDIT_COST = 1;  // /scrape with formats=markdown is ~1 credit

async function trackCredits(cost: number): Promise<void> {
  try {
    // Cairo TZ — يماشي باقي الـ daily counters (downloadCount/summaryUsage)
    // عشان الـ /system/costs panel يطابق الاستخدام اليومي اللي اليوزر يشوفه.
    const today = cairoDateString();
    const key   = `counter:firecrawl:credits:${today}`;
    await redis.incrby(key, cost);
    // 35-day TTL so the dashboard's monthly view always has data.
    await redis.expire(key, 35 * 24 * 3600).catch(() => {});
  } catch {
    // Tracking failure should never propagate.
  }
}

// Honor the shared quota / rate-limit cache so we don't hammer
// Firecrawl when we've already seen 402/429.
async function recordFirecrawlError(status: number): Promise<void> {
  try {
    if (status === 402) {
      await redis.setex(FC_QUOTA_EXCEEDED_KEY, FC_QUOTA_TTL_SEC, String(Date.now()));
    } else if (status === 429) {
      await redis.setex(FC_RATE_LIMITED_KEY, FC_RATE_LIMITED_TTL_SEC, String(Date.now()));
    }
  } catch { /* ignore redis hiccups */ }
}

interface ParseResponseBody {
  success?: boolean;
  data?: {
    markdown?: string;
    summary?:  string | null;
  };
  error?: string;
}

/**
 * Upload a PDF buffer to Firecrawl /v2/parse and return the extracted
 * markdown (and optional Firecrawl-generated summary).
 *
 * Returns `{ok: false, reason}` instead of throwing, so the caller
 * can simply branch on `ok` and fall through to the existing PDF
 * tier without try/catch noise.
 */
export async function parsePdfBuffer(
  buf:      Buffer,
  filename: string,
): Promise<FirecrawlParseResult> {
  if (!FIRECRAWL_API_KEY) return { ok: false, reason: "no_api_key" };
  if (buf.length > FIRECRAWL_PARSE_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  if (await isFirecrawlPaused()) return { ok: false, reason: "fc_paused" };

  // Build multipart/form-data body. We use Node's built-in FormData +
  // Blob (Node 20+); no external dep needed. The `options` part is
  // a JSON string per the OpenAPI spec.
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(buf)], { type: "application/pdf" }), filename);
  fd.append(
    "options",
    JSON.stringify({
      formats:         FORMATS,
      onlyMainContent: true,
      parsers:         PARSERS,
      timeout:         TIMEOUT_FC_PARSE,
    }),
  );

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_FC_PARSE);
  const t0    = Date.now();

  try {
    const r = await fetch(`${FIRECRAWL_V2}/parse`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
      },
      // Do NOT set Content-Type — the runtime adds the multipart
      // boundary automatically. Setting it manually breaks parsing.
      body:   fd,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;

    if (r.status === 429) {
      L.warn("firecrawl-parse", "rate-limited (429)", { ms });
      await recordFirecrawlError(429);
      return { ok: false, reason: "rate_limited", status: 429, ms };
    }
    if (r.status === 402) {
      L.warn("firecrawl-parse", "quota exceeded (402)", { ms });
      await recordFirecrawlError(402);
      return { ok: false, reason: "quota_exceeded", status: 402, ms };
    }
    if (r.status === 401 || r.status === 403) {
      L.error("firecrawl-parse", `auth error (${r.status}) — check FIRECRAWL_API_KEY`);
      return { ok: false, reason: "auth_error", status: r.status, ms };
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      L.warn("firecrawl-parse", `http error ${r.status}`, { body: body.slice(0, 200), ms });
      return { ok: false, reason: "http_error", status: r.status, ms };
    }

    const j = (await r.json().catch(() => ({}))) as ParseResponseBody;
    const markdown = (j?.data?.markdown ?? "").trim();
    if (!markdown) {
      L.warn("firecrawl-parse", "empty markdown in response", {
        ms,
        success: j?.success,
        error:   j?.error?.slice?.(0, 200),
      });
      return { ok: false, reason: "empty_response", ms };
    }

    await trackCredits(PARSE_CREDIT_COST);

    const summary = (j?.data?.summary ?? "").trim() || undefined;
    L.info("firecrawl-parse", "parse ok", {
      ms,
      mdLen:       markdown.length,
      hasSummary:  !!summary,
      uploadBytes: buf.length,
    });
    return { ok: true, markdown, summary, ms };
  } catch (e: any) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const isAbort = String(e?.name || "").includes("Abort");
    L.warn("firecrawl-parse", "exception", {
      ms,
      err:   String(e?.message || e).slice(0, 200),
      abort: isAbort,
    });
    return { ok: false, reason: isAbort ? "timeout" : "exception", ms };
  }
}

/**
 * Tell Firecrawl /v1/scrape to download a public PDF URL itself and
 * return the extracted markdown. Used when the bot has a sourceUrl
 * but no buffer in-hand (avoids re-downloading the file ourselves).
 *
 * Same return shape as `parsePdfBuffer` — caller branches on `ok`.
 */
export async function scrapeRemotePdf(url: string): Promise<FirecrawlParseResult> {
  if (!FIRECRAWL_API_KEY) return { ok: false, reason: "no_api_key" };
  if (await isFirecrawlPaused()) return { ok: false, reason: "fc_paused" };

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_FC_SCRAPE_PDF);
  const t0    = Date.now();

  try {
    // /v1/scrape with formats=markdown auto-detects PDF from
    // Content-Type and runs the same parsing pipeline as /parse.
    const r = await fetch(`${FIRECRAWL_V1}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        url,
        formats:         FORMATS,
        onlyMainContent: true,
        parsers:         PARSERS,
        timeout:         TIMEOUT_FC_SCRAPE_PDF,
      }),
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;

    if (r.status === 429) {
      L.warn("firecrawl-parse", "scrape rate-limited (429)", { ms });
      await recordFirecrawlError(429);
      return { ok: false, reason: "rate_limited", status: 429, ms };
    }
    if (r.status === 402) {
      L.warn("firecrawl-parse", "scrape quota exceeded (402)", { ms });
      await recordFirecrawlError(402);
      return { ok: false, reason: "quota_exceeded", status: 402, ms };
    }
    if (r.status === 401 || r.status === 403) {
      L.error("firecrawl-parse", `scrape auth error (${r.status})`);
      return { ok: false, reason: "auth_error", status: r.status, ms };
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      L.warn("firecrawl-parse", `scrape http error ${r.status}`, { body: body.slice(0, 200), ms });
      return { ok: false, reason: "http_error", status: r.status, ms };
    }

    const j = (await r.json().catch(() => ({}))) as ParseResponseBody;
    const markdown = (j?.data?.markdown ?? "").trim();
    if (!markdown) {
      L.warn("firecrawl-parse", "scrape empty markdown", { ms, url: url.slice(0, 80) });
      return { ok: false, reason: "empty_response", ms };
    }

    await trackCredits(SCRAPE_CREDIT_COST);

    const summary = (j?.data?.summary ?? "").trim() || undefined;
    L.info("firecrawl-parse", "scrape ok", {
      ms,
      mdLen:      markdown.length,
      hasSummary: !!summary,
      url:        url.slice(0, 80),
    });
    return { ok: true, markdown, summary, ms };
  } catch (e: any) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const isAbort = String(e?.name || "").includes("Abort");
    L.warn("firecrawl-parse", "scrape exception", {
      ms,
      err:   String(e?.message || e).slice(0, 200),
      abort: isAbort,
      url:   url.slice(0, 80),
    });
    return { ok: false, reason: isAbort ? "timeout" : "exception", ms };
  }
}

// How much extracted markdown to forward as `context` to a text-only
// AI provider. Most providers accept ~30k tokens of input; we keep
// well under that so the user's prompt + the system instruction also
// fit. Empirically this captures the first ~5–8 pages of a typical
// book PDF — plenty of grounding for a summary call.
export const FIRECRAWL_CONTEXT_MAX_CHARS = 24_000;

/**
 * Combine Firecrawl markdown + (optional) Firecrawl summary into a
 * single context block suitable for passing as `req.context` to
 * runFailover. Keeps the result under FIRECRAWL_CONTEXT_MAX_CHARS so
 * we don't blow up provider input limits.
 */
export function buildSummaryContext(res: FirecrawlParseResult): string | undefined {
  if (!res.ok || !res.markdown) return undefined;
  const parts: string[] = [];
  if (res.summary) {
    // Firecrawl's own summary first — it's a clean LLM-generated
    // overview, useful as the "TL;DR" context for the downstream
    // provider.
    parts.push(`## ملخص أوّلي من Firecrawl\n\n${res.summary.trim()}`);
  }
  parts.push(`## محتوى الكتاب (مستخرج)\n\n${res.markdown.trim()}`);
  const combined = parts.join("\n\n---\n\n");
  if (combined.length <= FIRECRAWL_CONTEXT_MAX_CHARS) return combined;
  return combined.slice(0, FIRECRAWL_CONTEXT_MAX_CHARS) + "\n\n[…تم اقتطاع باقي المحتوى…]";
}
