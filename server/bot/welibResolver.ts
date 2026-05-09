// ══════════════════════════════════════════════
// WELIB RESOLVER — Playwright-based PDF download
// ──────────────────────────────────────────────
// ar.welib.st (and any *.welib.st mirror) is fully behind Cloudflare and
// gates downloads behind a "wait ~35-60s, then a Download Now anchor
// appears" interstitial. There is no HTTP-only path: even loading the
// search results page returns 403 to plain `fetch`.
//
// Flow used by this resolver:
//   1. Bootstrap a browser context with `cf_clearance` cookies by GET /.
//      Welib injects two cookies on home: `cf_clearance` (CF token) and
//      `download_token` (per-session quota cookie). Without these the
//      slow_download page just renders the language picker.
//   2. Navigate to /slow_download/{md5}/0/0/convert. The page loads with
//      a JS countdown timer. After ~10-60 seconds the page DOM mutates
//      and an <a href="https://s2.welib-public.org/...">التحميل الان</a>
//      element is injected.
//   3. Poll the DOM up to WELIB_RESOLVE_TIMEOUT_MS for the anchor whose
//      href is on `welib-public.org` (the signed CDN URL).
//   4. Stream the signed URL with Node's fetch — `welib-public.org`
//      itself is a regular CDN and accepts plain HTTP downloads.
//
// THROTTLE: only one resolver pass runs at a time. Welib's CF
// challenge cookies are per-IP, so concurrent requests both spend the
// 35s wait and double our chance of hitting their rate limit. A
// promise-chain mutex serializes welib calls per process.
//
// We share neither the browser nor the context with `noorBookResolver`:
// the two libraries set different cookies / locale headers, and we want
// independent idle-close timers. RAM cost is one extra Chromium process
// during active use; both browsers idle-close after 5 minutes.
// ══════════════════════════════════════════════
import type { Browser, BrowserContext, Page } from "playwright-core";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { L } from "./logger.js";
import { UA, WELIB_PROXY_URL, WELIB_PROXY_SECRET } from "./config.js";

let _browserPromise: Promise<Browser> | null = null;
let _browserCloseTimer: NodeJS.Timeout | null = null;

// Welib's slow_download flow has a built-in 35-60s wait, then the page
// reveals the signed URL. Allow 90s ceiling for the wait + DOM update.
const WELIB_RESOLVE_TIMEOUT_MS = Number(process.env.WELIB_TIMEOUT_MS || 90_000);
const WELIB_DOWNLOAD_TIMEOUT_MS = Number(process.env.WELIB_DOWNLOAD_TIMEOUT_MS || 120_000);
const BROWSER_IDLE_CLOSE_MS = Number(process.env.WELIB_BROWSER_IDLE_MS || 5 * 60_000);

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
      L.info("welib", "Launching headless chromium", { exec });
      return pw.chromium.launch({
        executablePath: exec,
        headless: true,
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
    L.info("welib", "Idle browser closed", {});
  }, BROWSER_IDLE_CLOSE_MS).unref();
}

// ══════════════════════════════════════════════
// URL coercion
// ──────────────────────────────────────────────
// Welib URLs come in many shapes from Firecrawl / direct user paste:
//   /md5/{hash}                                    ← book detail page
//   /md5/{hash}#info                               ← anchor variant
//   /slow_download/{hash}/0/0                      ← non-converted (mobi/epub/etc.)
//   /slow_download/{hash}/0/0/convert              ← converted-to-PDF flavor
//   /fast_download/{hash}/0/0[/convert]            ← paid membership only
//   /search?...                                    ← not a book
// We only know how to download a specific book, so we accept anything
// matching /md5/{32-hex} and coerce to the slow_download/.../convert
// form. Returns null for shapes we cannot resolve (search pages, etc.).
// ══════════════════════════════════════════════
const MD5_PATH_RE = /\/md5\/([a-f0-9]{32})/i;
const SLOW_PATH_RE = /\/slow_download\/([a-f0-9]{32})\/(\d+)\/(\d+)(?:\/convert)?/i;
const FAST_PATH_RE = /\/fast_download\/([a-f0-9]{32})\/(\d+)\/(\d+)(?:\/convert)?/i;

export function isWelibHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(?:^|\.)welib\.(?:st|org)$/.test(host);
  } catch {
    return false;
  }
}

export function coerceToSlowDownloadUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!isWelibHost(url)) return null;

    let m = u.pathname.match(SLOW_PATH_RE);
    if (m) {
      // Always normalize to /convert flavor — gives PDF regardless of
      // the original file format.
      return `https://${u.hostname}/slow_download/${m[1]}/${m[2]}/${m[3]}/convert`;
    }

    m = u.pathname.match(FAST_PATH_RE);
    if (m) {
      // /fast_download requires welib membership. Switch to the slow
      // path so anonymous bots can use it.
      return `https://${u.hostname}/slow_download/${m[1]}/${m[2]}/${m[3]}/convert`;
    }

    m = u.pathname.match(MD5_PATH_RE);
    if (m) {
      return `https://${u.hostname}/slow_download/${m[1]}/0/0/convert`;
    }

    return null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════
// THROTTLE — one welib resolver pass at a time per process.
// Promise-chain mutex; cheap and avoids extra deps.
// ══════════════════════════════════════════════
let _welibQueueTail: Promise<unknown> = Promise.resolve();

function withWelibLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _welibQueueTail.then(() => fn(), () => fn());
  // Swallow rejection in tail so the chain doesn't carry an unhandled
  // rejection forward (we re-throw via `next` to the caller).
  _welibQueueTail = next.catch(() => undefined);
  return next;
}

// ══════════════════════════════════════════════
// MAIN ENTRY
//
// landingUrl: any welib.st URL that maps to a single book — typically
//   /md5/{hash} or /slow_download/{hash}/0/0[/convert].
// outputPath: where to write the PDF.
// returns: { ok: true, sizeBytes, resolvedUrl } on success, otherwise
//   { ok: false, error } with a short message describing why.
// ══════════════════════════════════════════════
export async function downloadWelibPdf(
  landingUrl: string,
  outputPath: string,
): Promise<{ ok: boolean; sizeBytes?: number; error?: string; resolvedUrl?: string }> {
  const slow = coerceToSlowDownloadUrl(landingUrl);
  if (!slow) {
    return { ok: false, error: "welib: URL is not a recognizable book page" };
  }

  return withWelibLock(async () => {
    const t0 = Date.now();
    // The Playwright BrowserContext is owned by extractSignedDownloadUrl
    // which closes it in its own finally. We only need to schedule
    // idle-close on the singleton browser here.
    try {
      const signedUrl = await extractSignedDownloadUrl(slow);
      if (!signedUrl) {
        return { ok: false, error: "welib: download anchor never appeared" };
      }

      L.info("welib", "Resolved signed URL — streaming to disk", {
        slow:   slow.slice(0, 100),
        signed: signedUrl.slice(0, 100),
      });

      const dl = await streamSignedUrlToFile(signedUrl, outputPath);
      if (!dl.ok) {
        return { ok: false, error: dl.error ?? "stream failed" };
      }

      L.info("welib", "PDF downloaded", {
        size: dl.sizeBytes,
        ms:   Date.now() - t0,
      });

      return {
        ok:          true,
        sizeBytes:   dl.sizeBytes,
        resolvedUrl: signedUrl,
      };
    } catch (err: any) {
      const msg = String(err?.message || err);
      L.warn("welib", "downloadWelibPdf failed", {
        url:   slow.slice(0, 100),
        error: msg.slice(0, 200),
        ms:    Date.now() - t0,
      });
      return { ok: false, error: msg };
    } finally {
      scheduleIdleClose();
    }
  });
}

// ══════════════════════════════════════════════
// extractSignedDownloadUrl — Playwright-only step
// Bootstrap CF cookies, navigate, poll for the welib-public.org anchor.
// Exposed for test injection / direct use.
// ══════════════════════════════════════════════
export async function extractSignedDownloadUrl(slowUrl: string): Promise<string | null> {
  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ar-SA",
      viewport: { width: 1280, height: 800 },
      // No need for `acceptDownloads` — we extract the signed URL and
      // stream it from Node, not via Playwright's download API.
      acceptDownloads: false,
      extraHTTPHeaders: {
        "Accept-Language": "ar,ar-SA;q=0.9,en;q=0.5",
      },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page: Page = await context.newPage();
    page.setDefaultTimeout(WELIB_RESOLVE_TIMEOUT_MS);

    // Step 1: bootstrap cf_clearance + download_token. Without this the
    // slow_download page renders only the language-picker shell.
    const origin = new URL(slowUrl).origin;
    L.info("welib", "Bootstrapping session", { origin });
    await page.goto(origin + "/?lang=ar", {
      waitUntil: "domcontentloaded",
      timeout:   WELIB_RESOLVE_TIMEOUT_MS,
    });
    // Small settle so CF can set cookies before we navigate away.
    await page.waitForTimeout(1500);

    // Step 2: navigate to the slow_download page.
    L.info("welib", "Navigating to slow_download", { url: slowUrl.slice(0, 100) });
    await page.goto(slowUrl, {
      waitUntil: "domcontentloaded",
      timeout:   WELIB_RESOLVE_TIMEOUT_MS,
    });

    // Step 3: poll for the signed anchor. We watch every 1.5s up to
    // WELIB_RESOLVE_TIMEOUT_MS. The anchor href is on welib-public.org.
    const deadline = Date.now() + WELIB_RESOLVE_TIMEOUT_MS;
    let signedUrl: string | null = null;
    while (Date.now() < deadline) {
      signedUrl = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
        for (const a of anchors) {
          if (/welib-public\.org/i.test(a.href)) return a.href;
        }
        return null;
      });
      if (signedUrl) break;
      await page.waitForTimeout(1500);
    }

    if (!signedUrl) {
      L.warn("welib", "anchor never appeared", {
        url: slowUrl.slice(0, 100),
        ms:  WELIB_RESOLVE_TIMEOUT_MS,
      });
      return null;
    }

    return signedUrl;
  } finally {
    await context?.close().catch(() => {});
  }
}

// ══════════════════════════════════════════════
// buildProxyFetchTarget — pure helper, exported for tests.
//
// Returns the URL + headers used to fetch the signed welib URL. When
// WELIB_PROXY_URL + WELIB_PROXY_SECRET are configured, the request is
// routed through the Cloudflare Worker proxy (see
// cloudflare/welib-proxy/). Otherwise the bot fetches the signed URL
// directly — which currently times out on AWS EC2 because welib's CDN
// blocks public-cloud egress IPs.
//
// We pass the proxy config as arguments rather than reading them
// inline so tests can exercise both branches deterministically.
// ══════════════════════════════════════════════
export function buildProxyFetchTarget(
  signedUrl: string,
  proxyUrl:  string,
  secret:    string,
): { fetchUrl: string; headers: Record<string, string>; viaProxy: boolean } {
  const baseHeaders: Record<string, string> = {
    "User-Agent":      UA,
    "Accept":          "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar,ar-SA;q=0.9,en;q=0.5",
  };

  if (!proxyUrl || !secret) {
    return { fetchUrl: signedUrl, headers: baseHeaders, viaProxy: false };
  }

  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    // Misconfigured proxy URL — fall back to direct fetch rather than
    // breaking the path entirely.
    return { fetchUrl: signedUrl, headers: baseHeaders, viaProxy: false };
  }
  proxy.searchParams.set("url", signedUrl);

  return {
    fetchUrl: proxy.toString(),
    headers: {
      ...baseHeaders,
      Authorization: `Bearer ${secret}`,
    },
    viaProxy: true,
  };
}

// ══════════════════════════════════════════════
// streamSignedUrlToFile — plain Node fetch (no browser).
// The signed URL is on welib-public.org. Direct fetches from AWS EC2
// time out at the CDN; route through the Cloudflare Worker proxy when
// configured (see cloudflare/welib-proxy/).
// ══════════════════════════════════════════════
async function streamSignedUrlToFile(
  url:        string,
  outputPath: string,
): Promise<{ ok: boolean; sizeBytes?: number; error?: string }> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WELIB_DOWNLOAD_TIMEOUT_MS);
  try {
    const { fetchUrl, headers, viaProxy } = buildProxyFetchTarget(
      url,
      WELIB_PROXY_URL,
      WELIB_PROXY_SECRET,
    );
    L.info("welib", "Streaming signed URL", {
      viaProxy,
      proxy: viaProxy ? new URL(fetchUrl).host : undefined,
    });
    const resp = await fetch(fetchUrl, {
      method:  "GET",
      signal:  ctrl.signal,
      headers,
      redirect: "follow",
    });
    if (!resp.ok || !resp.body) {
      return { ok: false, error: `welib CDN HTTP ${resp.status}` };
    }

    // Stream to disk; abort if the response isn't actually binary.
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.startsWith("text/html")) {
      return { ok: false, error: `welib CDN returned HTML (likely expired token), ct=${ct}` };
    }

    const out = fsSync.createWriteStream(outputPath);
    let bytes = 0;
    const reader = resp.body.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((res) => out.once("drain", () => res()));
        }
      }
    } finally {
      await new Promise<void>((res) => out.end(() => res()));
    }

    // Sanity check
    const stat = await fs.stat(outputPath);
    if (stat.size === 0) {
      return { ok: false, error: "welib CDN: empty file" };
    }
    return { ok: true, sizeBytes: stat.size };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════
// SHUTDOWN — closes the browser if it is still open.
// Called from the bot's graceful-shutdown hook alongside
// shutdownNoorBookBrowser.
// ══════════════════════════════════════════════
export async function shutdownWelibBrowser(): Promise<void> {
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
    } catch {
      /* noop */
    }
  }
}
