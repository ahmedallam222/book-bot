import { redis } from "./redis.js";
import { SOURCES, ARABIC_SOURCES } from "./sources.js";
import { isBlacklisted } from "./blacklist.js";
import {
  getAutoDisabledSourceDomains,
  getSourceStatsCached,
  rankSourcesByTrust,
} from "./analytics.js";
import { normalizeForCache, canonicalizeForCache, urlFilenameRelevance } from "./text.js";
import { L } from "./logger.js";
import type { BookResult, SourceConfig } from "./types.js";
import { searchWelib, type WelibSearchResult } from "./welibResolver.js";
import {
  TIMEOUT_FC_SEARCH, TIMEOUT_FC_SCRAPE,
  SEARCH_CACHE_TTL_HIT, SEARCH_CACHE_TTL_MISS,
  FC_QUOTA_EXCEEDED_KEY, FC_RATE_LIMITED_KEY, FC_RATE_LIMITED_TTL_SEC,
  FC_QUOTA_TTL_SEC, TRUSTED_PDF_DOMAINS, MIN_QUERY_LENGTH,
  SOURCE_RANK_MIN_SAMPLES,
} from "./config.js";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "";
const FIRECRAWL_SEARCH  = "https://api.firecrawl.dev/v2";
const FIRECRAWL_SCRAPE  = "https://api.firecrawl.dev/v1";

// ── Cache helpers ─────────────────────────────

// BUG FIX: كان يستخدم normalizeForCache فقط بينما الـ DB cache (storage.ts)
// يستخدم canonicalizeForCache (normalize + filler-word removal). نتيجة عدم
// التوحيد: استعلامات مثل "تحميل أرض زيكولا pdf" و "أرض زيكولا" تُنتِج مفاتيح
// كاش مختلفة في طبقة الـ Firecrawl (مدفوعة) رغم أنها بحث مكافئ منطقياً.
// الآن: التوحيد على canonicalizeForCache — مطابق لـ DB cache → cache hits أعلى
// واستهلاك أقل لاعتمادات Firecrawl.
function searchCacheKey(query: string): string {
  return `sc:${canonicalizeForCache(query)}`;
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

// Returns true if a search-cache entry exists for `query` — for *either*
// a HIT (results found) or a MISS (cached as `[]`). Callers use this to
// decide whether the query has any recent activity at all (e.g. the
// background cache-warmer skips queries that have already been searched
// in the last hour / 5 min so we don't burn Firecrawl quota re-checking
// the same negative result).
export async function hasRecentSearchCache(query: string): Promise<boolean> {
  try {
    const exists = await redis.exists(searchCacheKey(query));
    return exists === 1;
  } catch { return false; }
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

  // BUG FIX (admin manual-disable): الـ Set هنا الآن يجمع auto-disable +
  // manual override (`src:off:*`). الكود السابق كان يقرأ auto فقط، فمحاولات
  // الإيقاف اليدوي من الـ dashboard / Telegram كانت تُكتَب في Redis بدون أي قارئ
  // (silent feature failure). صار getAutoDisabledSourceDomains مصدر الحقيقة.
  // CACHE-INVALIDATION FIX: نحسبها قبل الـ cache check عشان نقدر نفلتر النتائج
  // المخزنة. لو مصدر اتعطّل بعد ما الكاش اتكتب، النتائج الـ stale لازم
  // تتفلتر — مش يتم تسليمها للمستخدم وتفشل التحقق.
  const disabledDomains = await getAutoDisabledSourceDomains().catch(() => new Set<string>());
  const isDisabled = (url: string) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return disabledDomains.has(host);
    } catch { return false; }
  };

  // Check cache first
  const cached = await getSearchCacheResults(query);
  if (cached.length) {
    const filtered = cached.filter((r) => !isDisabled(r.url) && !isDisabled(r.directPdfUrl || ""));
    // لو الفلترة سحبت كل النتائج، اعتبرها cache miss — هنعمل بحث جديد.
    // ولو فضل بعضها، رجِّعها وهات نتائج جديدة بعدين عند الحاجة.
    if (filtered.length > 0) return filtered;
    // fall through to fresh search
  }

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

  // Dynamic source ranking — re-order live sources by recent trustRate
  // (ok / total_with_rejects) so Firecrawl's `(site:a OR site:b OR …)`
  // budget concentrates on historically reliable sources first. Sources
  // with fewer than SOURCE_RANK_MIN_SAMPLES rolling samples keep their
  // hand-picked priority (defends against a brand-new source's first
  // lucky hit promoting it to #1 on a single attempt). Falls back to
  // the static priority order on any analytics failure.
  let arabicSources: SourceConfig[] = ARABIC_SOURCES.filter(
    (s) => !disabledDomains.has(s.domain),
  );
  try {
    const stats = await getSourceStatsCached();
    arabicSources = rankSourcesByTrust(arabicSources, stats, SOURCE_RANK_MIN_SAMPLES);
  } catch (e) {
    L.warn("engine", `rankSourcesByTrust failed — using static priority`, {
      err: String(e).slice(0, 80),
    });
  }
  const arabicDomains = arabicSources.map((s) => s.domain);
  const welibSourceConfig = arabicSources.find((s) => s.domain === "welib.st") ?? null;

  // Run Firecrawl + welib Playwright search in parallel. welib's
  // search has to bypass Cloudflare (Firecrawl/Google can't see most
  // welib pages), so we hit it directly via the existing welibResolver
  // browser singleton. Promise.allSettled keeps either source from
  // taking the other down.
  const welibBudgetMs = Number(process.env.WELIB_SEARCH_BUDGET_MS || 25_000);
  const welibMaxResults = Number(process.env.WELIB_SEARCH_MAX_RESULTS || 8);
  const [fcSettled, welibSettled] = await Promise.allSettled([
    unifiedSearch(arabicDomains, query, true),
    welibSourceConfig
      ? searchWelib(query, { maxResults: welibMaxResults, timeoutMs: welibBudgetMs })
      : Promise.resolve([] as WelibSearchResult[]),
  ]);
  const fcResults = fcSettled.status === "fulfilled" ? fcSettled.value : [];
  const welibResults = welibSettled.status === "fulfilled" ? welibSettled.value : [];

  const seen = new Set(fcResults.map((r) => r.url));
  const welibAsBookResults: BookResult[] = [];
  if (welibSourceConfig) {
    for (const w of welibResults) {
      if (seen.has(w.url)) continue;
      seen.add(w.url);
      welibAsBookResults.push(welibResultToBookResult(w, welibSourceConfig, query));
    }
  }

  const merged = [...fcResults, ...welibAsBookResults];
  const enriched = (await enrichWithMarkdown(merged, query))
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
    const hostname = u.hostname.replace(/^www\./, "");
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

// FIX-PAID-FALSE-POSITIVE: الـ patterns القديمة كانت تطابق كلمات مفردة
// زي "premium" / "subscribe" / "price" / "checkout" / "حقوق النشر" /
// "اشتر" — كلها بتظهر في UI شريطي/footer لمواقع كتب مجانية تماماً
// (newsletter signup، Premium membership banner، copyright notice،
// كلمة "اشتراك" اللي بتبدأ بـ "اشتر")، فكتب مجانية كانت تنحتسب
// على إنها مدفوعة. النتيجة: المستخدم يستلم رسالة "كتاب مدفوع" حتى
// لو الكتاب موجود مجاناً على kutubm.com / hindawi.org.
//
// التشديد:
//   - شيلنا الكلمات المفردة الغامضة (premium، subscribe، price، paid،
//     checkout، حقوق النشر، شراء/اشتر بدون context).
//   - أضفنا context صريح للأفعال (buy NOW، add to cart، اشتر الآن،
//     شراء الكتاب).
//   - أضفنا pattern للـ price tags الفعلية (currency + رقم) — أقوى
//     إشارة على إن الصفحة بتبيع.
//   - حافظنا على الإشارات القاطعة (out of stock، نفدت الكمية،
//     غير متوفر مجاناً، read-only signals صريحة).
const PROTECTED_ACCESS_PATTERNS = [
  // Action verbs in commerce context (Arabic)
  /(?:شراء|اشتري?(?:ه)?)\s+(?:الآن|الكتاب|المنتج|النسخة)|أضف(?:ه)?\s+(?:إلى|الى)\s+(?:السلة|عربة|عربتك)|اضف(?:ه)?\s+(?:إلى|الى)\s+(?:السلة|عربة|عربتك)|نفد(?:ت)?\s+(?:الكمية|المخزون)|غير\s+متوفر\s+مجان(?:اً|ا)?|متوفر\s+للبيع|للبيع\s+فقط|الدفع\s+(?:الإلكتروني|عبر|بـ)|أتمم?\s+(?:عملية\s+)?الشراء/i,
  // Action verbs in commerce context (English)
  /\b(?:buy\s+now|add\s+to\s+(?:cart|basket)|out\s+of\s+stock|sold\s+out|not\s+(?:available\s+)?for\s+free|proceed\s+to\s+checkout|complete\s+(?:your\s+)?purchase|paid\s+(?:only|content|version|access))\b/i,
  // Price tags — currency symbol/code + number (very specific signal)
  // ملاحظة: \b ما بيشتغلش مع حروف عربية في JS regex، لذا نستخدم
  // (?:^|[^\d.,]) قبل الرقم و (?:[\s.,;:،؛]|$) بعد العملة بدلاً من \b.
  /[\$€£¥]\s?\d+(?:[.,]\d+)?(?!\s*(?:%|سنة|years?))|(?:^|[^\d.,])\d+(?:[.,]\d+)?\s*(?:USD|EUR|GBP|JPY|SAR|AED|EGP|KWD|QAR|BHD|OMR|JOD|ر\.?س\.?|ج\.?م\.?|د\.?ك\.?|د\.?\u0625\.?|ريال|دينار|درهم|جنيه|ليرة)(?=[\s.,;:،؛]|$)/i,
  // Read-only / licensing signals (specific, not the generic "قراءة أونلاين"
  // that just means "read online" — many free libraries offer that)
  /قراءة\s+فقط(?!\s+ل(?:جزء|بعض))|للاطلاع\s+فقط|لا\s+يسمح\s+ب?التحميل|غير\s+قابل\s+للتنزيل|read[\-\s]only\s+access|preview\s+only\s+\(?\s*\d+\s*pages?\s*\)?/i,
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
          try { realDomain = new URL(docUrl).hostname.replace(/^www\./, ""); } catch {}
          srcConfig = {
            domain: realDomain || "unknown",
            name:   realDomain || "مصدر غير معروف",
            emoji:  "📄",
            priority: 99,
            searchUrl: () => "",
            isArabic,
          };
        }
        return makeResult(doc, srcConfig, idx, query);
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

// ── welibResultToBookResult ────────────────────
// A welib /md5/{hash} URL is *not* a direct PDF — it's a book-detail
// landing page that the welib Playwright resolver later resolves to a
// signed welib-public.org URL via a 5–60s slow_download flow. From the
// engine's point of view we still treat the URL as `directPdfUrl` so
// it lands in `validUrls` (instead of the 3rd-tier `downloadablePageFallbacks`)
// and gets ranked by the existing _score logic. download.ts checks
// `isWelibHost(pdfUrl)` and routes it to welibDownloadAndSend, so the
// "directPdfUrl" semantic abuse never reaches the actual fetch step.
//
// We score welib results with the highest access_prior tier
// (`direct_pdf`) plus the user-query / filename heuristic — so a
// strong title match outranks a weaker hindawi result, but a weak
// title match doesn't unseat a strong match from any other source.
export function welibResultToBookResult(
  w:         WelibSearchResult,
  source:    SourceConfig,
  userQuery: string,
): BookResult {
  const title = w.title || w.url;
  const score = scoreResult(
    { url: w.url, markdown: "", metadata: { title } },
    w.url,            // pretend the /md5/ URL is the directPdf so accessPrior is high
    "direct_pdf",
    userQuery,
  );
  return {
    id:           `welib-${w.md5}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    url:          w.url,
    directPdfUrl: w.url,
    source,
    access:       "direct_pdf",
    accessReason: "welib search hit (resolved at download time)",
    _score:       score,
  };
}

// ── makeResult ────────────────────────────────

function makeResult(
  doc:       FirecrawlDoc,
  source:    SourceConfig,
  idx:       number,
  userQuery: string,
): BookResult {
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
    _score: scoreResult(doc, directPdfUrl, access.kind, userQuery),
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

  // FIX-PAID-FALSE-POSITIVE: نحتاج matches من *2 patterns مختلفة على الأقل*
  // عشان نتأكد. صفحة فيها فقط "buy now" في زر شراء كتب أخرى (sidebar)
  // ما تكفيش لنصنّف الكتاب نفسه على إنه مدفوع. لازم تكون فيها إشارتين
  // مستقلتين (مثلاً "buy now" + price tag، أو price tag + "out of stock").
  let protectedHits = 0;
  for (const p of PROTECTED_ACCESS_PATTERNS) {
    if (p.test(haystack)) protectedHits++;
    if (protectedHits >= 2) break;
  }
  if (protectedHits >= 2) {
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

// BUG #10 — was scoring `urlFilenameRelevance(searchResultTitle, directPdfUrl)`
// which is meaningless: the title from Firecrawl is itself derived from the
// PDF URL/filename (so the score was almost always near 1.0, regardless of
// whether the result matched what the USER asked for). This let `direct_pdf`
// access types dominate ranking even when the actual PDF was an unrelated
// book — root cause for the dalilkuwa wrong-delivery class fixed at the
// download-stage in PR #39. We close the loop here so wrong-book PDFs sort
// LOWER than relevant download-pages.
//
// New scoring: split into three signals.
//   - accessPrior  — base probability by access type
//   - userMatch    — how well user query overlaps the result title
//   - filenameMatch — how well user query overlaps the directPdfUrl (or url)
// Combined as `accessPrior * 0.5 + max(userMatch, filenameMatch) * 0.5`
// so a `direct_pdf` with completely irrelevant filename collapses from
// ~0.95 → 0.5 (still a fallback option, but loses to a download_page that
// strongly matches the user query).
function scoreResult(
  doc:          FirecrawlDoc,
  directPdfUrl: string | null,
  access:       ResultAccess,
  userQuery:    string,
): number {
  const accessPrior: Record<ResultAccess, number> = {
    direct_pdf:     1,
    download_page:  0.7,
    catalog_page:   0.35,
    protected_page: 0.1,
  };

  // Relevance of the user's query to the result title — uses the same word-
  // overlap algorithm as `urlFilenameRelevance` for consistency, but against
  // the title text rather than a URL filename.
  const title = doc.metadata?.title || "";
  const titleAsUrl = `https://example.com/${encodeURIComponent(title)}.pdf`;
  const userMatch = userQuery && title
    ? urlFilenameRelevance(userQuery, titleAsUrl)
    : 0;

  // Relevance of the user's query to the actual file/URL the user would
  // receive — strongest signal for catching wrong PDFs (cache-poisoning,
  // unrelated direct downloads).
  const targetUrl = directPdfUrl || doc.url || "";
  const filenameMatch = userQuery && targetUrl
    ? urlFilenameRelevance(userQuery, targetUrl)
    : 0;

  const queryScore = Math.max(userMatch, filenameMatch);
  return Math.max(0.05, Math.min(1, accessPrior[access] * 0.5 + queryScore * 0.5));
}

// ── enrichWithMarkdown ─────────────────────────

const MAX_ENRICH = 1;  // FIX: خُفِّض من 2 → 1 لتوفير ~20% من Firecrawl credits

async function enrichWithMarkdown(results: BookResult[], userQuery: string): Promise<BookResult[]> {
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

  // welib.st صفحاته كلها محمية بـ Cloudflare ومفيهاش direct PDF link حتى
  // لو الـ scrape نجح (الرابط بيتولّد ديناميكياً بعد counter). نتركها لـ
  // welibResolver وقت التحميل بدل ما نحرق Firecrawl credits.
  const needsEnrich = results
    .filter((r) => !r.directPdfUrl && r.url && !/(?:^|\.)welib\.(?:st|org)\//i.test(r.url))
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
      _score: scoreResult({ url: r.url, markdown, metadata: { title: r.title } }, directPdfUrl, access.kind, userQuery),
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
