import { redis } from "./redis.js";
import { SOURCES, ARABIC_SOURCES } from "./sources.js";
import { isBlacklisted } from "./blacklist.js";
import { getAutoDisabledSourceDomains } from "./analytics.js";
import { normalizeArabic, normalizeForCache, urlFilenameRelevance } from "./text.js";
import { L } from "./logger.js";
import type { BookResult, SourceConfig } from "./types.js";
import {
  TIMEOUT_FC_SEARCH, TIMEOUT_FC_SCRAPE,
  SEARCH_CACHE_TTL_HIT, SEARCH_CACHE_TTL_MISS,
  FC_QUOTA_EXCEEDED_KEY, FC_RATE_LIMITED_KEY, FC_RATE_LIMITED_TTL_SEC,
  FC_QUOTA_TTL_SEC, TRUSTED_PDF_DOMAINS, MIN_QUERY_LENGTH,
} from "./config.js";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "";
const FIRECRAWL_SEARCH  = "https://api.firecrawl.dev/v2";
const FIRECRAWL_SCRAPE  = "https://api.firecrawl.dev/v1";

// ── Cache helpers ─────────────────────────────

function searchCacheKey(query: string): string {
  return `sc:${normalizeForCache(query)}`;
}

export async function isFirecrawlDown(): Promise<boolean> {
  try {
    const [quota, rate] = await Promise.all([
      redis.get(FC_QUOTA_EXCEEDED_KEY),
      redis.get(FC_RATE_LIMITED_KEY),
    ]);
    return !!(quota || rate);
  } catch { return false; }
}

export async function getSearchCacheResults(query: string): Promise<BookResult[]> {
  try {
    const raw = await redis.get(searchCacheKey(query));
    if (!raw) return [];
    return JSON.parse(raw) as BookResult[];
  } catch { return []; }
}

export function invalidateRecentSearchesCache(bookName?: string): void {
  if (!bookName) return;
  const key = searchCacheKey(bookName);
  redis.del(key).catch(() => {});
  const normalizedKey = searchCacheKey(normalizeForCache(bookName));
  if (normalizedKey !== key) redis.del(normalizedKey).catch(() => {});
}

// ── searchAllSources ──────────────────────────

export async function searchAllSources(query: string): Promise<BookResult[]> {
  if (!query || query.trim().length < MIN_QUERY_LENGTH) return [];

  // Check cache first
  const cached = await getSearchCacheResults(query);
  if (cached.length) return cached;

  // Check if Firecrawl is paused
  try {
    const [quota, rate] = await Promise.all([
      redis.get(FC_QUOTA_EXCEEDED_KEY),
      redis.get(FC_RATE_LIMITED_KEY),
    ]);
    if (quota || rate) {
      L.warn("engine", "searchAllSources: Firecrawl paused (quota/rate), skipping");
      return [];
    }
  } catch {}

  const autoDisabledDomains = await getAutoDisabledSourceDomains().catch(() => new Set<string>());
  const arabicDomains = ARABIC_SOURCES
    .filter((s) => !autoDisabledDomains.has(s.domain))
    .map((s) => s.domain);

  const results = await unifiedSearch(arabicDomains, query, true);
  const enriched = (await enrichWithMarkdown(results))
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

  // Cache the results
  if (enriched.length) {
    const ttl = SEARCH_CACHE_TTL_HIT;
    redis.setex(searchCacheKey(query), ttl, JSON.stringify(enriched)).catch(() => {});
  } else {
    redis.setex(searchCacheKey(query), SEARCH_CACHE_TTL_MISS, JSON.stringify([])).catch(() => {});
  }

  return enriched;
}

// ── isPdfUrl ──────────────────────────────────

function isPdfUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes(".pdf")) return true;
  if (url.includes("archive.org/details/")) return true;
  try {
    const u = new URL(url);
    if (u.searchParams.get("dl")     === "1")        return true;
    if (u.searchParams.get("type")   === "pdf")      return true;
    if (u.searchParams.get("format") === "pdf")      return true;
    if (u.searchParams.get("action") === "download") return true;
    const hostname = u.hostname.replace(/^www./, "");
    if (TRUSTED_PDF_DOMAINS.some((d) => hostname.includes(d))) {
      if (u.pathname.includes("download") || u.pathname.includes("dl")) return true;
    }
  } catch {}
  return false;
}

// ── Firecrawl types ───────────────────────────

interface FirecrawlDoc {
  url:       string;
  markdown?: string;
  metadata?: {
    title?:       string;
    description?: string;
    sourceURL?:   string;
  };
}

interface FirecrawlSearchResponse {
  success:  boolean;
  data?:    { web?: FirecrawlDoc[] };
  error?:   string;
  warning?: string;
}

type ResultAccess = BookResult["access"];

const PROTECTED_ACCESS_PATTERNS = [
  /شراء|اشتر|اشتري|سعر|أضف إلى السلة|اضف الى السلة|السلة|الدفع|مدفوع|غير مجاني|نفدت الكمية/i,
  /buy now|add to cart|checkout|price|paid|subscription|subscribe|premium|out of stock/i,
  /حقوق النشر|الكتب المرخصة|المرخصة والقانونية|قراءة ومراجعة|قراءة أونلاين|اقرأ أونلاين/i,
];

const DOWNLOAD_ACCESS_PATTERNS = [
  /تحميل\s+(?:كتاب|رواية|ملف)?|تنزيل|رابط مباشر|تحميل مباشر|download|download book|free pdf|pdf مجانا/i,
];

const CATALOG_ACCESS_PATTERNS = [
  /نبذة عن|وصف الكتاب|مراجعة|ملخص|تفاصيل الكتاب|بوابة الناشرين|الناشرين والمؤلفين/i,
];

function isSlowDomain(url: string): boolean {
  return /\/\/(?:www\.)?(?:archive\.org|ia\d+\.us\.archive\.org)\//i.test(url);
}

// ══════════════════════════════════════════════
// unifiedSearch
// ══════════════════════════════════════════════

async function unifiedSearch(
  activeDomains: string[],
  query:         string,
  isArabic:      boolean,
): Promise<BookResult[]> {
  if (!FIRECRAWL_API_KEY || activeDomains.length === 0) return [];

  const sitePart = activeDomains.map((d) => `site:${d}`).join(" OR ");
  const fcQuery  = `(${sitePart}) ${query} pdf`;

  const body: Record<string, unknown> = {
    query:    fcQuery,
    limit:    isArabic ? Math.min(activeDomains.length * 3, 20) : 5,
    country:  "SA",
    location: "Saudi Arabia",
  };

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_FC_SEARCH);

  try {
    let response: Response;
    try {
      response = await fetch(`${FIRECRAWL_SEARCH}/search`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        },
        signal: ctrl.signal,
        body:   JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }

    // ══════════════════════════════════════════
    // BUG FIX: فصل 402 عن 403
    // 429 = rate limit مؤقت
    // 402 = quota انتهت فعلاً → سجّل في Redis
    // 403 = مشكلة API Key → لا تضبط quota flag!
    // ══════════════════════════════════════════
    if (response.status === 429) {
      L.warn("engine", `Firecrawl rate limited (429) — cooling down ${FC_RATE_LIMITED_TTL_SEC}s`);
      await redis.setex(FC_RATE_LIMITED_KEY, FC_RATE_LIMITED_TTL_SEC, String(Date.now())).catch(() => {});
      return [];
    }
    if (response.status === 402) {
      L.warn("engine", `Firecrawl quota exceeded (402) — pausing ${FC_QUOTA_TTL_SEC}s`);
      await redis.setex(FC_QUOTA_EXCEEDED_KEY, FC_QUOTA_TTL_SEC, String(Date.now())).catch(() => {});
      return [];
    }
    if (response.status === 403) {
      const errBody = await response.text().catch(() => "");
      L.error("engine", `Firecrawl auth error (403) — check API key! Body: ${errBody.slice(0, 200)}`);
      return [];
    }
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      L.warn("engine", `Firecrawl HTTP ${response.status} (${isArabic ? "arabic" : "intl"}) — ${errBody.slice(0, 200)}`);
      return [];
    }

    const data = await response.json() as FirecrawlSearchResponse;
    const docs = data.data?.web;
    if (!data.success || !docs?.length) return [];

    return docs
      .filter((doc) => !!(doc.url || doc.metadata?.sourceURL))
      .filter((doc) => !isSlowDomain(doc.url || doc.metadata?.sourceURL || ""))
      .map((doc, idx) => {
        const docUrl    = doc.url || doc.metadata?.sourceURL || "";
        const srcDomain = activeDomains.find((d) => docUrl.includes(d)) ?? null;

        let srcConfig: SourceConfig;
        if (srcDomain) {
          srcConfig = SOURCES.find((s) => s.domain === srcDomain) ?? {
            domain: srcDomain, name: srcDomain, emoji: "📄", priority: 99,
            searchUrl: () => "", isArabic,
          };
        } else {
          let realDomain = "";
          try { realDomain = new URL(docUrl).hostname.replace(/^www./, ""); } catch {}
          srcConfig = {
            domain: realDomain || "unknown",
            name:   realDomain || "مصدر غير معروف",
            emoji:  "📄",
            priority: 99,
            searchUrl: () => "",
            isArabic,
          };
        }
        return makeResult(doc, srcConfig, idx);
      });

  } catch (e: any) {
    const err = String(e?.message || e);
    const isNetworkError = err.includes("ENOTFOUND") || err.includes("ECONNREFUSED") || err.includes("ETIMEDOUT");
    const isAbortError = err.includes("abort");
    
    if (!isAbortError) {
      if (isNetworkError) {
        L.warn("engine", `unifiedSearch network error (${isArabic ? "ar" : "intl"}): ${err.slice(0, 100)}`);
      } else {
        L.error("engine", `unifiedSearch error (${isArabic ? "ar" : "intl"}): ${err.slice(0, 100)}`);
      }
    }
    return [];
  }
}

// ── makeResult ────────────────────────────────

function makeResult(doc: FirecrawlDoc, source: SourceConfig, idx: number): BookResult {
  const url          = doc.url || doc.metadata?.sourceURL || "";
  const directPdfUrl = isPdfUrl(url) ? url : extractPdfLink(doc.markdown || "", url, source);
  const title        = doc.metadata?.title?.replace(/\s*[-|–—].*$/, "").trim() || url;
  const access       = classifyAccess(doc, directPdfUrl);

  return {
    id:           `${source.domain}-${idx}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    url,
    directPdfUrl,
    source,
    access: access.kind,
    accessReason: access.reason,
    _score: scoreResult(doc, directPdfUrl, access.kind),
  };
}

function classifyAccess(doc: FirecrawlDoc, directPdfUrl: string | null): { kind: ResultAccess; reason: string } {
  if (directPdfUrl) return { kind: "direct_pdf", reason: "pdf_link" };

  const haystack = [
    doc.url,
    doc.metadata?.title,
    doc.metadata?.description,
    doc.markdown?.slice(0, 12_000),
  ].filter(Boolean).join("\n");

  if (PROTECTED_ACCESS_PATTERNS.some((p) => p.test(haystack))) {
    return { kind: "protected_page", reason: "paid_or_read_only_signals" };
  }
  if (DOWNLOAD_ACCESS_PATTERNS.some((p) => p.test(haystack))) {
    return { kind: "download_page", reason: "download_signals" };
  }
  if (CATALOG_ACCESS_PATTERNS.some((p) => p.test(haystack))) {
    return { kind: "catalog_page", reason: "catalog_signals" };
  }
  return { kind: "catalog_page", reason: "no_direct_pdf" };
}

function scoreResult(doc: FirecrawlDoc, directPdfUrl: string | null, access: ResultAccess): number {
  const accessScore: Record<ResultAccess, number> = {
    direct_pdf: 1,
    download_page: 0.7,
    catalog_page: 0.35,
    protected_page: 0.1,
  };
  const titleText = `${doc.metadata?.title || ""} ${doc.url || ""}`;
  const normalizedTitle = normalizeArabic(titleText)
    .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, " ")
    .toLowerCase();
  const urlScore = directPdfUrl ? urlFilenameRelevance(normalizedTitle, directPdfUrl) : 0.5;
  return Math.max(0.05, Math.min(1, accessScore[access] * 0.85 + urlScore * 0.15));
}

// ── enrichWithMarkdown ─────────────────────────

const MAX_ENRICH = 1;  // FIX: خُفِّض من 2 → 1 لتوفير ~20% من Firecrawl credits

async function enrichWithMarkdown(results: BookResult[]): Promise<BookResult[]> {
  try {
    const [quota, rate] = await Promise.all([
      redis.get(FC_QUOTA_EXCEEDED_KEY),
      redis.get(FC_RATE_LIMITED_KEY),
    ]);
    if (quota || rate) {
      L.debug("engine", "enrichWithMarkdown: FC quota/rate active — skipping scrape");
      return results;
    }
  } catch {}

  const needsEnrich = results
    .filter((r) => !r.directPdfUrl && r.url)
    .slice(0, MAX_ENRICH);

  if (needsEnrich.length === 0) return results;

  const enriched = new Map<string, string | null>();

  await Promise.allSettled(
    needsEnrich.map(async (r) => {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_FC_SCRAPE);
      try {
        const resp = await fetch(`${FIRECRAWL_SCRAPE}/scrape`, {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
          },
          signal: ctrl.signal,
          body: JSON.stringify({ url: r.url, formats: ["markdown"] }),
        });
        clearTimeout(timer);

        // ══════════════════════════════════════
        // BUG FIX: فصل 402 عن 403 هنا كمان
        // ══════════════════════════════════════
        if (resp.status === 429) {
          L.warn("engine", `enrichWithMarkdown: FC rate limited (429)`);
          await redis.setex(FC_RATE_LIMITED_KEY, FC_RATE_LIMITED_TTL_SEC, String(Date.now())).catch(() => {});
          enriched.set(r.url, null);
          return;
        }
        if (resp.status === 402) {
          L.warn("engine", `enrichWithMarkdown: FC quota exceeded (402)`);
          await redis.setex(FC_QUOTA_EXCEEDED_KEY, FC_QUOTA_TTL_SEC, String(Date.now())).catch(() => {});
          enriched.set(r.url, null);
          return;
        }
        if (resp.status === 403) {
          const errBody = await resp.text().catch(() => "");
          L.error("engine", `enrichWithMarkdown: FC auth error (403) — check API key! Body: ${errBody.slice(0, 200)}`);
          enriched.set(r.url, null);
          return;
        }
        if (!resp.ok) { enriched.set(r.url, null); return; }

        const data = await resp.json();
        enriched.set(r.url, data?.data?.markdown || null);
      } catch (e: any) {
        clearTimeout(timer);
        const err = String(e?.message || e);
        if (!err.includes("abort")) {
          L.debug("engine", `enrichWithMarkdown fetch error: ${err.slice(0, 80)}`);
        }
        enriched.set(r.url, null);
      }
    })
  );

  return results.map((r) => {
    if (r.directPdfUrl || !enriched.has(r.url)) return r;
    const markdown = enriched.get(r.url) ?? "";
    const directPdfUrl = extractPdfLink(markdown, r.url, r.source);
    const access = classifyAccess({
      url: r.url,
      markdown,
      metadata: { title: r.title },
    }, directPdfUrl);
    return {
      ...r,
      directPdfUrl,
      access: access.kind,
      accessReason: access.reason,
      _score: scoreResult({ url: r.url, markdown, metadata: { title: r.title } }, directPdfUrl, access.kind),
    };
  });
}

// ── extractPdfLink ────────────────────────────
// Enhanced regex to handle:
// - Standard PDF URLs (https://example.com/book.pdf)
// - Encoded URLs (%2F for /, %3F for ?)
// - Query parameters (?param=value&download=true)
// - Fragment identifiers (#page=1)
function extractPdfLink(markdown: string, baseUrl: string, _source: SourceConfig): string | null {
  // First try direct PDF links in markdown
  const directMatch = markdown.match(/https?:\/\/[^\s\)\"\'<>"]+\.pdf(?:\?[^\s\)\"\'<>"]*)?(?:#[^\s\)\"\'<>"]*)?/gi);
  if (directMatch?.[0]) return directMatch[0];
  
  // Try encoded URLs and variations
  const encodedMatch = markdown.match(/https?:\/\/[^\s\"\'<>"]+(?:%2F|\/)+[^\s\"\'<>"]*\.pdf[^\s\"\'<>"]*/gi);
  if (encodedMatch?.[0]) {
    try {
      return decodeURI(encodedMatch[0]);
    } catch {
      return encodedMatch[0];
    }
  }
  
  return null;
}
