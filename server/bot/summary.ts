// ══════════════════════════════════════════════════════════
// Book Summary orchestrator
// ══════════════════════════════════════════════════════════
// Public entry point: getBookSummary(bookName, opts).
//
// Flow:
//   1. Redis cache lookup (key: summary:v1:<normalized>)
//      → hit: return cached SummaryResponse, no upstream calls.
//   2. Best-effort context fetch — Wikipedia summary (free, no key).
//      Used by every provider to ground its output.
//   3. If a fresh PDF is available (caller passed pdfBuffer or
//      sourceUrl we can re-download), try the PDF-native tier
//      (Gemini 2.5/2.0/1.5 Flash in priority order).
//   4. Fall back to the text-only tier (Groq → Cerebras → … →
//      Cloudflare). For premium users, you.com is tried first.
//   5. If everything fails AND we have Wikipedia context, return
//      the Wikipedia extract as a last-resort summary.
//   6. On success, cache the response under both the original
//      bookName and its normalized form.

import { L } from "./logger.js";
import { redis } from "./redis.js";
import {
  SUMMARY_CACHE_TTL_SECONDS,
  SUMMARY_DAILY_LIMIT_FREE,
  SUMMARY_DAILY_LIMIT_GLOBAL,
} from "./config.js";
import { normalizeForCache, canonicalizeForCache, cairoDateString } from "./text.js";
import { runFailover } from "./aiProviders/registry.js";
import { fetchWikipediaContext } from "./wikipedia.js";
import { PROVIDER_MAX_PDF_BYTES } from "./aiProviders/types.js";
import type { SummaryResponse } from "./aiProviders/types.js";
import {
  parsePdfBuffer,
  scrapeRemotePdf,
  buildSummaryContext,
  isFirecrawlParseConfigured,
} from "./firecrawlParse.js";

const CACHE_PREFIX  = "summary:v1:";
const USAGE_PREFIX  = "summary:usage:";
const GLOBAL_PREFIX = "ai:summary:global:";

// Thrown when the bot-wide daily AI ceiling is reached. The handler
// catches this specifically and surfaces an Arabic "come back
// tomorrow" message instead of a generic error. Cached summaries
// keep flowing — only fresh AI calls are affected.
export class GlobalSummaryLimitError extends Error {
  constructor() {
    super("Global daily summary limit reached");
    this.name = "GlobalSummaryLimitError";
  }
}

// Audit 2026-05-04 (Bug B): swapped from `normalizeForCache` to
// `canonicalizeForCache` for parity with the rest of the bot.
// `normalizeForCache` only Arabic-letter-folds; it does NOT strip noise
// words ("تحميل", "pdf", "مجاني") or normalize whitespace, so phrasings
// of the same book ("أرض زيكولا" vs "تحميل أرض زيكولا" vs "ارض زيكولا
// pdf") fragmented into separate Redis keys → 3+ paid Gemini calls per
// popular book instead of 1 cache hit. The inflight summary lock and
// the DB cache key both already use `canonicalizeForCache`; this gets
// the response cache aligned with them.
function cacheKey(bookName: string, depth: string = "quick"): string {
  const base = (canonicalizeForCache(bookName) || bookName).slice(0, 180);
  return CACHE_PREFIX + (depth === "deep" ? "d:" : "q:") + base;
}

function todayKey(): string {
  // Cairo TZ — يماشي downloadCount/buildResetTime عشان يوزر بيستخدم
  // البوت قبل منتصف ليل القاهرة وبعدها يلاقي اللميت اتجدد فعلاً (مش
  // الساعة 03:00 صباح القاهرة زي ما UTC كان بيعمل).
  return cairoDateString().replace(/-/g, ""); // YYYYMMDD
}

export interface UsageStatus {
  used:    number;
  limit:   number;
  blocked: boolean;
}

// Per-user daily counter — only enforced for non-premium users (the
// caller passes premium=false to consume; premium=true bypasses).
export async function checkAndConsumeUsage(
  userId:  string,
  premium: boolean,
): Promise<UsageStatus> {
  if (premium || SUMMARY_DAILY_LIMIT_FREE <= 0) {
    return { used: 0, limit: SUMMARY_DAILY_LIMIT_FREE, blocked: false };
  }
  const k    = `${USAGE_PREFIX}${userId}:${todayKey()}`;
  const used = await redis.incr(k).catch(() => 0);
  // 25h TTL ensures the counter naturally rotates with the date key.
  await redis.expire(k, 25 * 3600).catch(() => {});
  if (used > SUMMARY_DAILY_LIMIT_FREE) {
    // Reverse the increment so the counter accurately reflects allowed
    // consumption — important if the user upgrades to premium and we
    // want to grandfather their day's usage.
    await redis.decr(k).catch(() => {});
    return { used: SUMMARY_DAILY_LIMIT_FREE, limit: SUMMARY_DAILY_LIMIT_FREE, blocked: true };
  }
  return { used, limit: SUMMARY_DAILY_LIMIT_FREE, blocked: false };
}

// Refund a previously consumed slot when the upstream call failed and
// the user did not actually receive a summary. Mirrors the rollback
// already done inside checkAndConsumeUsage when the cap is exceeded —
// the same guarantee should hold when the AI providers throw or the
// global cap blocks the call after the per-user counter was charged.
//
// Bounded at zero by the caller paths: we only refund when consume
// previously succeeded (blocked=false), so the counter is at least 1.
export async function refundUserSummaryUsage(
  userId:  string,
  premium: boolean,
): Promise<void> {
  if (premium || SUMMARY_DAILY_LIMIT_FREE <= 0) return;
  const k = `${USAGE_PREFIX}${userId}:${todayKey()}`;
  await redis.decr(k).catch(() => {});
}

// Bot-wide daily ceiling. Increments the counter atomically and
// rolls back if we'd exceed the cap, returning false. The caller
// must NOT call any AI provider when this returns false. Cache hits
// must bypass this entirely (call before this function).
async function consumeGlobalQuota(): Promise<boolean> {
  if (SUMMARY_DAILY_LIMIT_GLOBAL <= 0) return true;
  const k    = `${GLOBAL_PREFIX}${todayKey()}`;
  const used = await redis.incr(k).catch(() => 0);
  // 25h TTL ensures the counter naturally rotates with the date key.
  await redis.expire(k, 25 * 3600).catch(() => {});
  if (used > SUMMARY_DAILY_LIMIT_GLOBAL) {
    // Rollback so the counter accurately reflects allowed AI calls.
    await redis.decr(k).catch(() => {});
    return false;
  }
  return true;
}

export async function getCachedSummary(bookName: string, depth: string = "quick"): Promise<SummaryResponse | null> {
  try {
    const raw = await redis.get(cacheKey(bookName, depth));
    if (!raw) return null;
    return JSON.parse(raw) as SummaryResponse;
  } catch {
    return null;
  }
}

async function setCachedSummary(bookName: string, resp: SummaryResponse, depth: string = "quick"): Promise<void> {
  try {
    await redis.set(cacheKey(bookName, depth), JSON.stringify(resp), "EX", SUMMARY_CACHE_TTL_SECONDS);
  } catch (e) {
    L.warn("summary", "cache write failed", { err: String(e).slice(0, 100) });
  }
}

// Download PDF bytes from a public URL. Used when the orchestrator
// has a sourceUrl but no buffer in-hand (the bot's main flow deletes
// the temp file after delivery). Capped at PROVIDER_MAX_PDF_BYTES so
// we don't blow up Gemini's inline-data limit.
async function fetchPdfBuffer(url: string): Promise<Buffer | null> {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "book-bot/1.0" },
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    // Defend against landing pages that redirect to HTML — we'd waste
    // a Gemini call sending an HTML page as a PDF.
    if (!ct.includes("pdf") && !ct.includes("octet-stream")) {
      L.warn("summary", "fetchPdfBuffer: non-PDF content-type", { url: url.slice(0, 80), ct });
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > PROVIDER_MAX_PDF_BYTES) {
      L.warn("summary", "PDF too large for inline upload — skipping PDF path", {
        url:   url.slice(0, 80),
        bytes: buf.length,
      });
      return null;
    }
    return buf;
  } catch (e) {
    L.warn("summary", "fetchPdfBuffer failed", { url: url.slice(0, 80), err: String(e).slice(0, 100) });
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface SummaryOptions {
  /** deep = ملخص أطول وأغنى */
  depth?: "quick" | "deep";
  // PDF source. Either a Buffer (caller already has the file in
  // memory — fastest path) or a URL we can download from. Both
  // optional; if neither is supplied we go straight to text-only.
  pdfBuffer?: Buffer;
  pdfUrl?:    string;
  // Premium routing — true = try you.com first.
  premium?:   boolean;
  // Bypass cache entirely. Useful for an admin "regenerate" button
  // (not yet wired) and for tests.
  forceFresh?: boolean;
}

export async function getBookSummary(
  bookName: string,
  opts: SummaryOptions = {},
): Promise<SummaryResponse> {
  const t0 = Date.now();
  const depth = opts.depth === "deep" ? "deep" : "quick";

  if (!opts.forceFresh) {
    const cached = await getCachedSummary(bookName, depth);
    if (cached) {
      L.info("summary", "cache hit", { book: bookName.slice(0, 50) });
      return cached;
    }
  }

  // 1. Best-effort Wikipedia context (parallelizable with PDF fetch).
  //    Always fetched — both as grounding for the AI call AND as the
  //    free fallback path when the global cap is reached.
  const wikiP = fetchWikipediaContext(bookName);

  // 2. Bot-wide daily AI cap — protects the free Gemini quota from a
  //    viral spike. Checked AFTER cache so popular books keep being
  //    served from Redis even when the cap is hit. We DO NOT throw
  //    immediately on cap-hit; we still try the Wikipedia-only path
  //    below so the user gets something useful instead of an error.
  const globalOk = await consumeGlobalQuota();
  if (!globalOk) {
    L.warn("summary", "global daily cap reached — skipping AI tiers", {
      book:  bookName.slice(0, 50),
      limit: SUMMARY_DAILY_LIMIT_GLOBAL,
    });
  }

  // 3. Maybe-PDF fetch (skipped when cap hit since we won't use it).
  let pdfBuffer: Buffer | undefined = opts.pdfBuffer;
  const pdfP = globalOk && !pdfBuffer && opts.pdfUrl
    ? fetchPdfBuffer(opts.pdfUrl)
    : Promise.resolve(null);

  const [wiki, freshPdf] = await Promise.all([wikiP, pdfP]);
  if (!pdfBuffer && freshPdf) pdfBuffer = freshPdf;

  const wikiContext = wiki?.extract || undefined;
  // Will be augmented with Firecrawl markdown for premium users (step 3.5).
  // The text-only failover path (step 5) consumes this combined context.
  let context = wikiContext;
  if (depth === "deep") {
    const deepHint =
      "\n\n[تعليمات الملخص العميق] قدّم ملخصاً أغنى: " +
      "للروايات 450-650 كلمة دون كشف النهاية؛ " +
      "لغير الروايات 5-7 نقاط + أفكار موسّعة + تطبيق عملي واحد.";
    context = (context || "") + deepHint;
  }
  // Set to true when the Firecrawl fast-path produced usable markdown
  // for a premium user. Skips the multimodal Gemini PDF tier (step 4)
  // entirely so we don't spend the Gemini free-tier quota on premium
  // users whose summary will come from you.com anyway.
  let firecrawlEnriched = false;

  // 3.5  Premium fast-path — Firecrawl /parse (or /scrape) extracts the
  //      PDF text directly, then the text-only AI tier (you.com first,
  //      since it's premium-only at priority 0) generates the summary.
  //      Two wins: (a) the user gets a citation-rich you.com response
  //      instead of multimodal Gemini noise, and (b) the free Gemini
  //      quota is preserved for non-premium users.
  //
  //      We only run this when:
  //        - global cap not hit
  //        - opts.premium is true (gates the cost — /parse is ~5
  //          credits per call; we don't want to spend it on free users
  //          when Gemini's free tier handles them fine)
  //        - Firecrawl is configured AND we have either a buffer or URL
  //
  //      Failure here falls through to the existing PDF tier — no
  //      regression for premium users if Firecrawl is down.
  if (globalOk && opts.premium && isFirecrawlParseConfigured() && (pdfBuffer || opts.pdfUrl)) {
    try {
      const fc = pdfBuffer
        ? await parsePdfBuffer(pdfBuffer, `${normalizeForCache(bookName).slice(0, 60) || "book"}.pdf`)
        : await scrapeRemotePdf(opts.pdfUrl!);

      // Telemetry — observe the rollout. Non-blocking.
      const telKey = fc.ok
        ? "tel:summary:firecrawl_used"
        : `tel:summary:firecrawl_skipped:${fc.reason || "unknown"}`;
      redis.incr(telKey).catch(() => {});

      if (fc.ok) {
        const fcContext = buildSummaryContext(fc);
        if (fcContext) {
          // Combine Wikipedia + Firecrawl markdown — Wikipedia gives
          // the canonical title/author/genre signal, Firecrawl gives
          // the actual book content. The text-tier provider is fed
          // both so it can ground its answer in the real text.
          context = wikiContext
            ? `${wikiContext}\n\n---\n\n${fcContext}`
            : fcContext;
          firecrawlEnriched = true;
          L.info("summary", "Firecrawl premium fast-path engaged", {
            book:       bookName.slice(0, 50),
            mdLen:      fc.markdown?.length ?? 0,
            ctxLen:     context.length,
            hasFcSummary: !!fc.summary,
            ms:         fc.ms,
          });
        }
      } else {
        L.info("summary", "Firecrawl premium fast-path skipped — falling through", {
          book:   bookName.slice(0, 50),
          reason: fc.reason,
          status: fc.status,
          ms:     fc.ms,
        });
      }
    } catch (e) {
      // Defensive — buildSummaryContext / parsePdfBuffer already swallow
      // their own errors, but if anything escapes we still want to fall
      // through to the existing pipeline rather than fail the summary.
      L.warn("summary", "Firecrawl fast-path threw — ignored", {
        err: String(e).slice(0, 200),
      });
      redis.incr("tel:summary:firecrawl_skipped:exception").catch(() => {});
    }
  }

  // 4. Try PDF-native tier first if we have bytes (and the cap is not hit).
  //    Premium users with a successful Firecrawl extract skip this — the
  //    text-tier path (step 5) will use you.com (priority 0, premium-only)
  //    with the rich Firecrawl context, which is faster + higher quality
  //    than multimodal Gemini for those users.
  if (globalOk && pdfBuffer && !firecrawlEnriched) {
    try {
      const out = await runFailover({
        bookName,
        pdfBuffer,
        context,
        premium: opts.premium,
      }, { requirePDF: true });
      await setCachedSummary(bookName, out, depth);
      L.info("summary", "PDF-tier ok", {
        book:     bookName.slice(0, 50),
        provider: out.providerName,
        ms:       Date.now() - t0,
      });
      return out;
    } catch (e) {
      L.warn("summary", "PDF tier failed — falling back to text", {
        book: bookName.slice(0, 50),
        err:  String(e).slice(0, 200),
      });
      // Continue to text-only tier below.
    }
  }

  // 5. Text-only tier (with whatever Wikipedia context we got).
  if (globalOk) {
    try {
      const out = await runFailover({
        bookName,
        context,
        premium: opts.premium,
      }, { requirePDF: false });
      await setCachedSummary(bookName, out, depth);
      L.info("summary", "text-tier ok", {
        book:     bookName.slice(0, 50),
        provider: out.providerName,
        ms:       Date.now() - t0,
      });
      return out;
    } catch (e) {
      L.warn("summary", "All AI tiers exhausted", {
        book: bookName.slice(0, 50),
        err:  String(e).slice(0, 300),
      });
    }
  }

  // 6. Last-resort: Wikipedia extract verbatim (no AI). Reached on
  //    full AI failure OR when the global cap is hit. Cached too so
  //    a popular spike-day book becomes a free hit afterwards.
  if (wiki?.extract && wiki.extract.length > 100) {
    const fallback: SummaryResponse = {
      summary:      wiki.extract,
      bookType:     "unknown",
      spoilerLevel: "none",
      language:     wiki.language,
      providerName: "wikipedia-fallback",
      source:       "wikipedia_only",
    };
    await setCachedSummary(bookName, fallback, depth);
    L.info("summary", "wikipedia-only fallback used", {
      book:        bookName.slice(0, 50),
      capExceeded: !globalOk,
    });
    return fallback;
  }

  // 7. Truly nothing left. If the cap was the reason we skipped AI,
  //    surface the typed error so the handler shows a "try later"
  //    message instead of a generic failure.
  if (!globalOk) throw new GlobalSummaryLimitError();
  throw new Error(`getBookSummary: all paths exhausted for "${bookName}"`);
}
