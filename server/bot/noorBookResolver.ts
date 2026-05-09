// ══════════════════════════════════════════════
// NOOR-BOOK RESOLVER — Playwright-based download
// ──────────────────────────────────────────────
// noor-book.com محمي بـ Cloudflare + بروتوكول tokens داخلي
// (book_hash + crypto_token + csrf + localStorage.ls).
// لا يوجد HTTP-only path للتحميل — لازم session متصفح حقيقي
// عشان CF cookies + JS challenge + AJAX flow كله يحصل في نفس
// الـ context.
//
// الـ flow:
//   1. تفتح landing page → CF JS challenge يحلّ تلقائياً.
//   2. JS الصفحة بيستخرج book_hash + crypto_token + csrf_token من
//      الـ HTML inline.
//   3. ضغط على .download-btn → modal بيتفتح + timer 10s.
//   4. JS بيعمل POST لـ /Verification/check_user → بيرجع ls.
//   5. بعد التايمر، go_gownload() بيعمل POST لـ
//      /book/get_download_links → response HTML فيه الـ
//      internal_download URL.
//   6. .download-body بتتحدث بالـ HTML فيه <a href="…/internal_download/…">.
//   7. ضغط على الـ link → المتصفح بيبدأ تحميل PDF فعلي.
//
// Playwright بيسهّل النقطة 7: page.waitForEvent("download") بتمسك
// الملف كـ stream قبل ما يتكتب على disk، ونحفظه في tempPath.
//
// Singleton browser (lazy-launched) عشان نوفر cold start (~1.5s).
// كل request له context منفصل عشان localStorage/cookies تتعزل.
// ══════════════════════════════════════════════
import type { Browser, BrowserContext, Page } from "playwright-core";
import * as fs from "fs/promises";
import { L } from "./logger.js";

let _browserPromise: Promise<Browser> | null = null;
let _browserCloseTimer: NodeJS.Timeout | null = null;

// Default 30s — fail fast on books whose JS-token flow stalls
// (e.g. is_user_ready never set, internal_download_link never injected),
// so the worker can fall back to other sources instead of burning ~3 min
// on Playwright retries. Override via NOORBOOK_TIMEOUT_MS for slower hosts.
const NOORBOOK_RESOLVE_TIMEOUT_MS = Number(process.env.NOORBOOK_TIMEOUT_MS || 30_000);
const NOORBOOK_DOWNLOAD_TIMEOUT_MS = Number(process.env.NOORBOOK_DOWNLOAD_TIMEOUT_MS || 120_000);
// Idle browser → اقفله بعد 5 دقائق عشان مايحطش RAM
const BROWSER_IDLE_CLOSE_MS = Number(process.env.NOORBOOK_BROWSER_IDLE_MS || 5 * 60_000);

function chromiumExecPath(): string | undefined {
  return (
    process.env.CHROMIUM_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_PATH ||
    "/usr/bin/chromium-browser"
  );
}

async function getBrowser(): Promise<Browser> {
  if (_browserCloseTimer) {
    clearTimeout(_browserCloseTimer);
    _browserCloseTimer = null;
  }
  if (!_browserPromise) {
    _browserPromise = (async () => {
      const pw = await import("playwright-core");
      const exec = chromiumExecPath();
      L.info("noorbook", "Launching headless chromium", { exec });
      return pw.chromium.launch({
        executablePath: exec,
        headless: true,
        // ملاحظات:
        //   --headless=new جوهري لتجاوز CF — الوضع القديم (--headless
        //   بدون =new) بيبعت fingerprint مختلف و CF بيرفع challenge.
        //   وضع new بيستخدم نفس renderer بتاع Chrome العادي.
        //   --disable-blink-features=AutomationControlled بيخفي
        //   navigator.webdriver = true اللي CF بيتفحصه أول حاجة.
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-gpu",
          "--headless=new",
        ],
      });
    })().catch((e) => {
      _browserPromise = null;
      throw e;
    });
  }
  return _browserPromise;
}

function scheduleIdleClose(): void {
  if (_browserCloseTimer) clearTimeout(_browserCloseTimer);
  _browserCloseTimer = setTimeout(() => {
    const p = _browserPromise;
    _browserPromise = null;
    _browserCloseTimer = null;
    p?.then((b) => b.close().catch(() => {})).catch(() => {});
    L.info("noorbook", "Idle browser closed", {});
  }, BROWSER_IDLE_CLOSE_MS).unref();
}

// ══════════════════════════════════════════════
// non-book URL detection
// noor-book بيخدّم paths مالهاش .download-btn (tag, category, user, search):
//   /tag/<topic>            ← قائمة كتب تحت تاج
//   /category/<cat>         ← قائمة فئة
//   /user/<id>              ← profile مؤلف
//   /search?q=...           ← نتائج بحث
//   /البحث?q=...            ← نتائج بحث (Arabic)
//   /أحدث-الكتب             ← أحدث كتب (index)
// لو الـ URL واحد منهم، الـ resolver كان بيفتح Chromium ويستنّى 30s
// لـ .download-btn اللي مش هيظهر أبداً → fail بعد wasted budget.
// لما الـ Firecrawl بيرجع waste url زي ده، بنرفض فوراً ونوفّر 30s.
//
// ملاحظة implementation: بنفك URL-encoding قبل الـ test عشان pattern
// واحد يطابق الصيغتين (encoded + plain Unicode).
const NON_BOOK_NOOR_PATTERNS: RegExp[] = [
  /^\/tag\//i,
  /^\/category\//i,
  /^\/user\//i,
  /^\/author\//i,
  /^\/search(?:\?|\/|$)/i,
  /^\/البحث/,
  /^\/بحث(?:\?|\/|$)/,
  /^\/أحدث-/,
  /^\/الفئة\//,
  /^\/المستخدم\//,
  // P2 of the 2026-05-09 audit: Firecrawl was returning these
  // listing-style paths as candidates and they ate the per-domain
  // candidate cap (14/15 candidates for "العادات الذرية" cache were
  // /tag/* listing pages, leaving zero room for the actual book
  // page). They have no .download-btn so they would also fail the
  // resolver if we did try them.
  /^\/review(?:\/|$)/i,             // /review/<id> — book reviews, no download
  /^\/reviews(?:\/|$)/i,
  /^\/en\/ebook-/i,                  // /en/ebook-<topic> — English topic listings
  /^\/en\/category\//i,
  /^\/en\/tag\//i,
  /^\/en\/author\//i,
  /^\/en\/search(?:\?|\/|$)/i,
  /^\/مراجعة\//,                     // Arabic for "review"
  /^\/مراجعات(?:\/|$)/,
];

// Check whether a noor-book.com URL is a non-book listing/aggregator
// page (no .download-btn, never resolves to a PDF). Exposed for use
// by the search-result filter in engine.ts so the candidates never
// enter the ranker / per-domain cap.
export function isNonBookNoorUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    let decoded = path;
    try { decoded = decodeURIComponent(path); } catch { /* malformed → use raw */ }
    return NON_BOOK_NOOR_PATTERNS.some((re) => re.test(decoded));
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════
// MAIN ENTRY
// landingUrl: مثلاً https://www.noor-book.com/كتاب-آنا-كارنينا-pdf
// outputPath: المسار اللي هيتكتب عليه الـ PDF
// returns: { ok: true, sizeBytes } لو نجح، { ok: false, error } غير كده
// ══════════════════════════════════════════════
export async function downloadNoorBookPdf(
  landingUrl: string,
  outputPath: string,
): Promise<{ ok: boolean; sizeBytes?: number; error?: string; resolvedUrl?: string }> {
  const t0 = Date.now();

  // Early fail-fast: tag/category/user/search URLs ليسوا book pages —
  // الـ .download-btn مش هيظهر أبداً، فبنرفض فوراً بدون فتح متصفح.
  if (isNonBookNoorUrl(landingUrl)) {
    L.warn("noorbook", "non-book noor URL — skipping resolver", {
      url: landingUrl.slice(0, 100),
    });
    return { ok: false, error: "noor-book: URL is not a book page (tag/category/search)" };
  }

  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      // UA لازم يبقى Chrome جديد فعلاً، مش البوت UA التاني (اللي
      // بستخدمو في HTTP fetches). CF بيفحص UA + JS fingerprint.
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ar-SA",
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      extraHTTPHeaders: {
        "Accept-Language": "ar,ar-SA;q=0.9,en;q=0.5",
      },
    });

    // إلغاء علامة navigator.webdriver قبل أي script في الصفحة بيتنفّذ.
    // جوهري لـ CF — لو webdriver=true بيرفع challenge فوراً، ولو undefined
      // بيعدي بدون challenge أصلاً.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page: Page = await context.newPage();
    page.setDefaultTimeout(NOORBOOK_RESOLVE_TIMEOUT_MS);

    L.info("noorbook", "Navigating to landing page", {
      url: landingUrl.slice(0, 100),
    });

    await page.goto(landingUrl, {
      waitUntil: "domcontentloaded",
      timeout: NOORBOOK_RESOLVE_TIMEOUT_MS,
    });

    // CF interstitial: اتنين من 3 احتمالات:
    //   (أ) صفحة الكتاب الحقيقية لو CF بيثق في الـ session فوراً.
    //   (ب) "Just a moment..." → نستنى لحد ما يحلّ (max 25s).
    // الـ selector الـ download-btn بيكون موجود في صفحة الكتاب فقط.
    try {
      await page.waitForSelector(".download-btn", {
        state: "visible",
        timeout: 30_000,
      });
    } catch {
      // فحص لو لسه على CF challenge
      const title = await page.title().catch(() => "");
      const url = page.url();
      L.warn("noorbook", "download-btn not visible — possibly CF challenge", {
        title: title.slice(0, 60),
        url: url.slice(0, 80),
      });
      throw new Error("download button never appeared (CF challenge or not a book page)");
    }

    L.info("noorbook", "Book page loaded — clicking download", {});

    // ضغط الـ download-btn — بيفتح modal بـ timer 10s
    await page.click(".download-btn", { timeout: 10_000 });

    // ننتظر POST /Verification/check_user يكمل (is_user_ready = true)
    // ده شرط لـ go_gownload() عشان csrf_token + ls يكونوا fresh
    await page
      .waitForFunction(
        // @ts-ignore — متغيرات global في صفحة noor-book
        () => typeof (window as any).is_user_ready !== "undefined" && (window as any).is_user_ready === true,
        { timeout: 30_000 },
      )
      .catch(() => {
        L.warn("noorbook", "is_user_ready never set — proceeding anyway", {});
      });

    // ندوس على go_gownload() مباشرة عشان نتخطى الـ countdown
    // (الـ function بتعمل clearInterval(timerID) جواها فالـ timer بيتلغى)
    await page.evaluate(() => {
      // @ts-ignore — global function في الصفحة
      if (typeof (window as any).go_gownload === "function") {
        (window as any).go_gownload();
      }
    });

    // ننتظر <a class="internal_download_link"> يظهر في .download-body
    // ده بيظهر بعد ما POST /book/get_download_links يرجع HTML.
    // Bound by NOORBOOK_RESOLVE_TIMEOUT_MS so a stuck page fails fast instead
    // of holding the worker for the previous hardcoded 60s.
    const internalUrl: string = await page
      .waitForFunction(
        () => {
          const a = document.querySelector(
            ".download-body a.internal_download_link",
          ) as HTMLAnchorElement | null;
          return a && a.href ? a.href : null;
        },
        { timeout: NOORBOOK_RESOLVE_TIMEOUT_MS },
      )
      .then((h) => h.jsonValue() as Promise<string>);

    L.info("noorbook", "Resolved internal_download URL", {
      url: internalUrl.slice(0, 100),
    });

    // ضغط على الـ link داخل الصفحة — Playwright بيمسك الـ download event
    // ده بيضمن إن الـ session cookies بتاعة CF تستخدم في request التحميل
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: NOORBOOK_DOWNLOAD_TIMEOUT_MS }),
      page.evaluate((href: string) => {
        const a = document.querySelector(
          ".download-body a.internal_download_link",
        ) as HTMLAnchorElement | null;
        if (a) {
          a.click();
        } else {
          // fallback: انشئ anchor جديد
          const newA = document.createElement("a");
          newA.href = href;
          newA.download = "";
          document.body.appendChild(newA);
          newA.click();
        }
      }, internalUrl),
    ]);

    await download.saveAs(outputPath);
    const stats = await fs.stat(outputPath);

    L.info("noorbook", "PDF downloaded", {
      size: stats.size,
      ms: Date.now() - t0,
    });

    return {
      ok: true,
      sizeBytes: stats.size,
      resolvedUrl: internalUrl,
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    L.warn("noorbook", "downloadNoorBookPdf failed", {
      error: msg.slice(0, 200),
      ms: Date.now() - t0,
    });
    return { ok: false, error: msg };
  } finally {
    await context?.close().catch(() => {});
    scheduleIdleClose();
  }
}

// تنظيف عند إغلاق التطبيق
export async function shutdownNoorBookBrowser(): Promise<void> {
  if (_browserCloseTimer) {
    clearTimeout(_browserCloseTimer);
    _browserCloseTimer = null;
  }
  const p = _browserPromise;
  _browserPromise = null;
  if (p) {
    try {
      const b = await p;
      await b.close();
    } catch { /* noop */ }
  }
}
