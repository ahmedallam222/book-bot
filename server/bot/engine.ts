import { redis } from "./redis.js";
import { SOURCES, ARABIC_SOURCES, INTL_SOURCES } from "./sources.js";
import { isBlacklisted } from "./blacklist.js";
import { normalizeArabic, normalizeForCache, urlFilenameRelevance } from "./text.js";
import { L } from "./logger.js";
import type { BookResult, SourceConfig } from "./types.js";
import {
  TIMEOUT_FC_SEARCH,
  SEARCH_CACHE_TTL_HIT, SEARCH_CACHE_TTL_MISS,
  FC_QUOTA_EXCEEDED_KEY, FC_RATE_LIMITED_KEY, FC_RATE_LIMITED_TTL_SEC,
  FC_QUOTA_TTL_SEC, TRUSTED_PDF_DOMAINS,
} from "./config.js";

// ══════════════════════════════════════════════
// SEARCH ENGINE — Firecrawl Unified Search
//
// المنطق (v19+):
//  ┌─ القديم: 9 calls منفصلة × كل مصدر = 9 credits/بحث ─────────────────┐
//  │  مشكلة: fuzzy fallback → يصل لـ 81 credits لبحث واحد فاشل           │
//  └──────────────────────────────────────────────────────────────────────┘
//
//  ┌─ الجديد: Unified Search — callان فقط لكل بحث ──────────────────────┐
//  │  Call 1: includeDomains=[كل المواقع العربية] + lang:ar + query "pdf" │
//  │  Call 2: includeDomains=[المواقع الدولية] (بدون lang:ar)             │
//  │  = 2 credits فقط (توفير 78-89%)                                     │
//  │  fuzzy worst case: 10 credits بدل 81                                 │
//  └──────────────────────────────────────────────────────────────────────┘
//
//  لماذا "pdf" في الـ query؟
//    Firecrawl يستخدم Google-backed web search.
//    إضافة "pdf" تُعطي إشارة للـ Google لترتيب صفحات التحميل أولاً.
//    مثال: "العقيدة الواسطية pdf" يجلب روابط تحميل مباشرة أكثر من "العقيدة الواسطية" فقط.
//
//  Pipeline كامل:
//  1. Redis cache
//  2. فحص quota/rateLimit (pipeline واحدة)
//  3. فلتر المصادر المُعطَّلة (pipeline واحدة بدل N reads)
//  4. Unified Arabic Search (1 call)
//  5. Unified International Search (1 call) — موازٍ لـ 4
//  6. دمج النتائج + فلتر blacklist
//  7. تخزين في cache
// ══════════════════════════════════════════════

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || "";
const FIRECRAWL_BASE    = "https://api.firecrawl.dev/v1";

// ── Cache helpers ─────────────────────────────

function searchCacheKey(query: string): string {
  return `sc:${normalizeForCache(query)}`;
}

/** قراءة نتائج مخزَّنة من Redis */
export async function getSearchCacheResults(query: string): Promise<BookResult[]> {
  try {
    const raw = await redis.get(searchCacheKey(query));
    if (!raw) return [];
    return JSON.parse(raw) as BookResult[];
  } catch { return []; }
}

/** مسح كاش "recent searches" (بعد تسجيل بحث ناجح) */
let _recentInvalidated = 0;
export function invalidateRecentSearchesCache(): void {
  _recentInvalidated = Date.now();
}

// ── isPdfUrl ──────────────────────────────────

/**
 * يُحدّد هل الرابط هو PDF مباشر.
 * يدعم:
 *  - امتداد .pdf في المسار
 *  - ?dl=1 في domains موثوقة
 *  - مسارات /download/ و /dl/ في domains موثوقة
 */
function isPdfUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes(".pdf")) return true;
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
  success: boolean;
  data?:   FirecrawlDoc[];
  error?:  string;
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
// Unified Search — call واحدة لمجموعة domains
//
// E1 FIX: بدل 9 calls منفصلة (واحدة لكل مصدر)
//   نُرسل call واحدة مع includeDomains=[كل المصادر المُفعَّلة]
//   Firecrawl يبحث في جميعها ويُرجع أفضل النتائج cross-domain
//   = توفير 85%+ من credits
//
// E2 FIX: إضافة "pdf" للـ query للمواقع العربية
//   يُخبر Google-backed Firecrawl أننا نريد صفحات تحميل وليس مراجعات
//
// E3 FIX: lang:ar فقط للمواقع العربية
//   pdfdrive.com وغيرها الدولية لا تستفيد من lang:ar
//   بل قد تضر: Firecrawl يُضيّق نطاق البحث دون داعٍ
// ══════════════════════════════════════════════

async function unifiedSearch(
  activeDomains: string[],
  query:         string,
  isArabic:      boolean,
): Promise<BookResult[]> {
  if (!FIRECRAWL_API_KEY || activeDomains.length === 0) return [];

  // E2: إضافة "pdf" للـ query العربي — يُحسّن ترتيب Google لروابط التحميل
  const fcQuery = isArabic ? `${query} pdf` : query;

  const body: Record<string, unknown> = {
    query:          fcQuery,
    includeDomains: activeDomains,
    limit:          isArabic ? Math.min(activeDomains.length * 3, 20) : 5,
    scrapeOptions:  { formats: ["markdown"] },
  };

  // E3: lang/country فقط للمواقع العربية
  if (isArabic) {
    body.lang    = "ar";
    body.country = "SA";
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_FC_SEARCH);

  try {
    let response: Response;
    try {
      response = await fetch(`${FIRECRAWL_BASE}/search`, {
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

    // ── Rate limit / Quota ─────────────────────
    if (response.status === 429) {
      L.warn("engine", `Firecrawl rate limited (429) — cooling down ${FC_RATE_LIMITED_TTL_SEC}s`);
      // BUG-1 FIX: كان يُخزَّن "1" → alertWatcher يُفسّره كـ timestamp (مليارات الثواني!)
      // الآن: نُخزّن الوقت الحقيقي بالمللي ثانية حتى يعمل حساب sinceSec بشكل صحيح
      await redis.setex(FC_RATE_LIMITED_KEY, FC_RATE_LIMITED_TTL_SEC, String(Date.now())).catch(() => {});
      return [];
    }
    if (response.status === 402 || response.status === 403) {
      L.warn("engine", `Firecrawl quota exceeded (${response.status}) — pausing 24h`);
      // BUG-1 FIX: نفس الإصلاح — alertWatcher يستخدم parseInt(fcQuota, 10) → يجب أن يكون timestamp
      await redis.setex(FC_QUOTA_EXCEEDED_KEY, FC_QUOTA_TTL_SEC, String(Date.now())).catch(() => {});
      return [];
    }
    if (!response.ok) {
      L.warn("engine", `Firecrawl HTTP ${response.status} (${isArabic ? "arabic" : "intl"})`);
      return [];
    }

    const data = await response.json() as FirecrawlSearchResponse;
    if (!data.success || !data.data?.length) return [];

    // نحوّل كل نتيجة لـ BookResult — نتجاهل النتائج بدون URL صالح
    // BUG FIX: بعض نتائج Firecrawl تُعيد doc.url فارغاً — كانت تُضاف للنتائج بدون فائدة
    return data.data
      .filter((doc) => !!(doc.url || doc.metadata?.sourceURL))
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
        return makeResult(doc, srcConfig, idx);
      });

  } catch (e: any) {

    const err = String(e?.message || e);
    if (!err.includes("abort")) {
      L.warn("engine", `unifiedSearch error (${isArabic ? "ar" : "intl"}): ${err.slice(0, 80)}`);
    }
    return [];
  }
}

/**
 * makeResult — تحويل Firecrawl doc إلى BookResult
 */
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

/**
 * extractPdfLink — استخراج رابط PDF من markdown المُرجَع
 *
 * الأنماط مُرتَّبة من الأكثر دقةً إلى الأقل:
 *  1. روابط Markdown الصريحة مع .pdf
 *  2. روابط URL مجردة تنتهي بـ .pdf
 *  3. روابط href مع .pdf
 *  4. روابط تحميل بـ query params شائعة
 *  5. مسارات تحميل بدون .pdf
 *  6. أنماط مواقع الكتب العربية
 *  7. href أي رابط تحميل (آخر محاولة)
 */
function extractPdfLink(markdown: string, baseUrl: string, source: SourceConfig): string | null {
  if (!markdown) return null;

  // ── نمط 1: روابط Markdown الصريحة ────────────
  const mdLinks = [...markdown.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)]+\.pdf[^)]*)\)/gi)];
  if (mdLinks.length > 0) return mdLinks[0][2];

  // ── نمط 2: روابط URL مجردة تنتهي بـ .pdf ──────
  const plainPdf = markdown.match(/https?:\/\/[^\s\)>"]+\.pdf(?:[?#][^\s\)>"<]*)?/i);
  if (plainPdf) return plainPdf[0];

  // ── نمط 3: href مع .pdf ───────────────────────
  const hrefPdf = markdown.match(/href=["'](https?:\/\/[^"']+\.pdf[^"']*)/i);
  if (hrefPdf) return hrefPdf[1];

  // ── نمط 4: query params تحميل شائعة ──────────
  const qpDownload = markdown.match(
    /(https?:\/\/[^\s"'<>]+[?&](?:dl|download|get|format|type|action)=(?:1|pdf|download|true)[^\s"'<>]*)/i
  );
  if (qpDownload) return qpDownload[1];

  // ── نمط 5: مسارات تحميل بدون امتداد .pdf ─────
  // BUG FIX: الـ regex القديم كان عُرضة لـ ReDoS على markdown طويل
  // [^\s"'<>]+ بعد \b يمكن أن يتداخل مع backtracking — الحل: تقييد الطول
  const pathDl = markdown.match(
    /(https?:\/\/[^\s"'<>]{1,100}\/(?:download|dl|pdf|files?|get|تحميل|كتب)[^\s"'<>]{0,200})/i
  );
  if (pathDl) {
    const u = pathDl[1].toLowerCase();
    if (!u.endsWith(".html") && !u.endsWith(".htm") && !u.endsWith(".php") &&
        !u.includes("search") && !u.includes("index")) {
      return pathDl[1];
    }
  }

  // ── نمط 6: أنماط مواقع الكتب العربية ──────────
  const arabicBookPatterns: RegExp[] = [
    /href=["']((?:https?:\/\/)?[^"']*(?:\/download\/|\/dl\/|\/تحميل\/)[^"']*)/i,
    /(https?:\/\/[^\s"'<>]+\/(?:book|كتاب)\.php\?[^\s"'<>]*(?:dl|download)=[^\s"'<>]*)/i,
    /(https?:\/\/[^\s"'<>]+\/download(?:\.php)?\?[^\s"'<>]+)/i,
  ];
  for (const pat of arabicBookPatterns) {
    const m = markdown.match(pat);
    if (m) {
      const found = m[1] || m[0];
      if (found.startsWith("/")) {
        try { return new URL(found, baseUrl).href; } catch {}
      }
      if (found.startsWith("http")) return found;
    }
  }

  // ── نمط 7: أي href يبدو رابط تحميل (آخر محاولة) ──
  const anyDownloadHref = markdown.match(
    /href=["'](https?:\/\/[^"']+)["'][^>]*>[^<]*(?:تحميل|PDF|download|pdf|حمّل|اقرأ)[^<]*/i
  );
  if (anyDownloadHref) {
    const candidate = anyDownloadHref[1];
    const cl = candidate.toLowerCase();
    if (!cl.endsWith(".html") && !cl.endsWith(".htm")) return candidate;
  }

  return null;
}

// ── Source disabled check ─────────────────────

// ══════════════════════════════════════════════
// searchAllSources — نقطة الدخول الرئيسية
// ══════════════════════════════════════════════

/**
 * searchAllSources
 * ─────────────────
 * البحث الرئيسي — E1 FIX: Unified Search بدل 9 calls منفصلة
 *
 * الخطوات:
 *  1. Redis cache
 *  2. فحص quota/rateLimit (pipeline واحدة)
 *  3. فلتر المصادر المُعطَّلة (pipeline واحدة)
 *  4. Unified Arabic Search + Unified International Search بالتوازي
 *  5. دمج + فلتر blacklist + إزالة مكررات
 *  6. تخزين في cache
 */
export async function searchAllSources(query: string): Promise<BookResult[]> {
  if (!query.trim()) return [];

  // ── 1. Cache hit ──────────────────────────────
  const cacheKey = searchCacheKey(query);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const results = JSON.parse(cached) as BookResult[];
      if (results.length > 0) {
        L.debug("engine", `Cache hit: "${query}" → ${results.length} results`);
        return results;
      }
      // BUG-2 FIX: miss-cache كان يُخزَّن [] لكن الكود يتجاوزه ولا يُعيد [] أبداً
      // → كل بحث فاشل سبق تخزينه كـ miss يُعيد إرسال طلب Firecrawl كامل
      //   حتى خلال فترة SEARCH_CACHE_TTL_MISS (دقيقتان) → هدر credits
      // الحل: إذا وُجد مفتاح في الكاش ونتائجه [] → أعِد [] مباشرة بدون Firecrawl
      L.debug("engine", `Miss-cache hit: "${query}" — skipping Firecrawl`);
      return [];
    }
  } catch {}

  if (!FIRECRAWL_API_KEY) {
    L.warn("engine", "FIRECRAWL_API_KEY not set — returning empty results");
    return [];
  }

  // ── 2. فحص quota/rateLimit (pipeline واحدة) ──
  const [fcQuotaRaw, fcRateRaw] = (await redis.pipeline()
    .get(FC_QUOTA_EXCEEDED_KEY)
    .get(FC_RATE_LIMITED_KEY)
    .exec().catch(() => [])) as [Error | null, string | null][];
  if ((fcQuotaRaw as any)?.[1]) {
    L.debug("engine", `FC quota exceeded — skipping "${query}"`);
    return [];
  }
  if ((fcRateRaw as any)?.[1]) {
    L.debug("engine", `FC rate limited — skipping "${query}"`);
    return [];
  }

  // ── 3. فلتر المصادر المُعطَّلة (pipeline واحدة) ──
  // E1 FIX (improvement): بدل N Redis reads لـ isSourceEnabled
  const srcPipeline = redis.pipeline();
  for (const s of SOURCES) srcPipeline.get(`src:off:${s.domain}`);
  const offFlags = (await srcPipeline.exec().catch(() =>
    SOURCES.map(() => [null, null])
  )) as [Error | null, string | null][];

  const enabledDomains = new Set(
    SOURCES.filter((_, i) => (offFlags[i] as any)?.[1] !== "1").map((s) => s.domain)
  );

  const activeArabicDomains = ARABIC_SOURCES
    .filter((s) => enabledDomains.has(s.domain))
    .map((s) => s.domain);

  const activeIntlDomains = INTL_SOURCES
    .filter((s) => enabledDomains.has(s.domain))
    .map((s) => s.domain);

  if (activeArabicDomains.length === 0 && activeIntlDomains.length === 0) {
    L.warn("engine", "All sources disabled — no search performed");
    return [];
  }

  L.info("engine", `Unified search "${query}" — ar:[${activeArabicDomains.length}] intl:[${activeIntlDomains.length}]`);

  // ── 4. Unified Search بالتوازي ────────────────
  // E1: callتان بدل 9 calls — توفير 78-89% من credits
  const [arabicResults, intlResults] = await Promise.all([
    activeArabicDomains.length > 0
      ? unifiedSearch(activeArabicDomains, query, true)
      : Promise.resolve([]),
    activeIntlDomains.length > 0
      ? unifiedSearch(activeIntlDomains,  query, false)
      : Promise.resolve([]),
  ]);

  const allResults: BookResult[] = [...arabicResults, ...intlResults];

  if (allResults.length === 0) {
    await redis.setex(cacheKey, Math.max(1, Math.floor(SEARCH_CACHE_TTL_MISS / 1000)), JSON.stringify([])).catch(() => {});
    return [];
  }

  // ── 5. فلتر Blacklist ─────────────────────────
  const blChecks = await Promise.allSettled(
    allResults.map((r) =>
      r.directPdfUrl ? isBlacklisted(r.directPdfUrl) : Promise.resolve(false)
    )
  );
  const filtered = allResults.filter((_, i) => {
    const check = blChecks[i];
    return !(check.status === "fulfilled" && check.value);
  });

  // ── إزالة المكررات ────────────────────────────
  const seenUrls = new Set<string>();
  const unique   = filtered.filter((r) => {
    if (isSlowDomain(r.directPdfUrl || r.url)) return false;
    const key = r.directPdfUrl || r.url;
    if (seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });

  unique.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

  L.info("engine", `Search "${query}": ${unique.length} unique results (ar:${arabicResults.length} intl:${intlResults.length})`);

  // ── 6. Cache save ─────────────────────────────
  await redis.setex(
    cacheKey,
    Math.max(1, Math.floor(SEARCH_CACHE_TTL_HIT / 1000)),
    JSON.stringify(unique)
  ).catch(() => {});

  return unique;
}
