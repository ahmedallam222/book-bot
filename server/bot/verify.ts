import { isBlacklisted } from "./blacklist.js";
import { L }              from "./logger.js";
import { UA, VIEWER_ONLY_DOMAINS, HARD_BLOCKED_DOMAINS } from "./config.js";
import { isWelibHost }    from "./welibResolver.js";

// ══════════════════════════════════════════════
// VERIFY — التحقق من صلاحية روابط PDF
// ══════════════════════════════════════════════

export interface VerifyBatch {
  urls:  string[];
  stats: { blacklisted: number; checked: number; valid: number; hardBlocked?: number };
}

/**
 * يُصفّي قائمة URLs:
 *  0. يُزيل ما يطابق HARD_BLOCKED_DOMAINS (config) — بدون أي فحص
 *  1. يُزيل المحجوبة في الـ blacklist
 *  2. يتحقق بـ HEAD request إن كان Content-Type يشير لـ PDF
 */
export async function findValidPdfUrls(urls: string[]): Promise<VerifyBatch> {
  const stats = { blacklisted: 0, checked: 0, valid: 0, hardBlocked: 0 };

  if (urls.length === 0) return { urls: [], stats };

  // ── (0) Hard block — قبل أي عملية شبكية ──
  // domains معطوبة بالكامل (مثل scholar.archive.org wayback academic
  // ranges) يُسقَط فوراً. مختلف عن UNRELIABLE_DOMAINS اللي بس بيخفض
  // الترتيب. شاهد config.ts للتفاصيل.
  const notHardBlocked = urls.filter((url) => {
    const blocked = HARD_BLOCKED_DOMAINS.some((d) => url.includes(d));
    if (blocked) {
      stats.hardBlocked++;
      L.debug("verify", "Hard-blocked domain — skipped", { url: url.slice(0, 80) });
    }
    return !blocked;
  });

  // ── (1) فلتر الـ blacklist ────────────────────
  const blChecks = await Promise.allSettled(notHardBlocked.map((u) => isBlacklisted(u)));
  const notBlacklisted = notHardBlocked.filter((_, i) => {
    if (blChecks[i].status === "fulfilled" && (blChecks[i] as PromiseFulfilledResult<boolean>).value) {
      stats.blacklisted++;
      return false;
    }
    return true;
  });

  // ── فلتر منصات العرض — لا PDF قابل للتحميل منها أبداً ──
  // fliphtml5.com, scribd.com, issuu.com وغيرها من عوارض الوثائق
  // المحاولة معها تستهلك 90 ثانية وتفشل دائماً — نُزيلها فوراً
  const notViewerOnly = notBlacklisted.filter((url) => {
    const isViewer = VIEWER_ONLY_DOMAINS.some((d) => url.includes(d));
    if (isViewer) {
      L.debug("verify", `Viewer-only domain — skipped immediately`, { url: url.slice(0, 80) });
    }
    return !isViewer;
  });

  // ── welib URLs — let download.ts handle them ──
  // welib (welib.st / welib.org, with or without subdomain) sits fully
  // behind Cloudflare; a HEAD without cf_clearance returns 403 ("Just
  // a moment…") which the 4xx-skip path below would otherwise mark as
  // permanently dead. The resolver bootstraps CF cookies in Playwright
  // at download time, so we keep welib URLs in the candidate set and
  // bypass the HEAD probe entirely.
  //
  // Source-of-truth for "is this a welib URL?" lives in
  // `isWelibHost(url)` in welibResolver.ts — using a real URL parser
  // there means bare welib.st AND ar.welib.st AND welib.org variants
  // all match identically, instead of drifting between two ad-hoc
  // regexes here and there.
  const welibUrls = notViewerOnly.filter(isWelibHost);
  const nonWelib  = notViewerOnly.filter((u) => !isWelibHost(u));

  // ── HEAD check لأول 6 URLs ───────────────────
  const toCheck = nonWelib.slice(0, 6);
  const rest    = nonWelib.slice(6); // تجاوز الـ HEAD check — pass through

  const valid: string[] = [];

  await Promise.allSettled(
    toCheck.map(async (url) => {
      stats.checked++;
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        try {
          // FIX v29: إضافة Accept-Language: ar — مواقع عربية قد تُعيد محتوى مختلفاً
          const r = await fetch(url, {
            method: "HEAD",
            headers: {
              "User-Agent":      UA,
              "Accept-Language": "ar,ar-SA;q=0.9,en;q=0.5",
            },
            signal: ctrl.signal,
            redirect: "follow",
          });
          const ct = r.headers.get("content-type") || "";
          if (r.ok && (ct.includes("pdf") || ct.includes("octet-stream"))) {
            stats.valid++;
            valid.push(url);
          } else if (r.ok && ct.includes("html")) {
            // صفحة HTML — download.ts يتعامل معها (قد تحتوي رابط PDF)
            valid.push(url);
          } else if (r.ok && !ct) {
            // لا Content-Type — قد يكون PDF بدون header صحيح → نُمرّره
            valid.push(url);
          } else if (!r.ok) {
            // FIX-VERIFY: 404/410 → رفض نهائي بدون تمرير
            // 429/5xx → تمرير (مشكلة مؤقتة وليست URL فاشلة)
            if (r.status === 404 || r.status === 410 || r.status === 403) {
              L.debug("verify", `HEAD ${r.status} — skipping permanently`, { url: url.slice(0, 60) });
            } else {
              // مشكلة مؤقتة (429, 5xx) → نُمرّر ونتيح لـ download.ts الحكم
              valid.push(url);
            }
          } else {
            // نوع آخر غير معروف — نُمرّره ونتيح لـ download.ts الحكم
            valid.push(url);
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // timeout أو network error — نمرر الـ URL
        valid.push(url);
      }
    })
  );

  // welib URLs are deliberately not HEAD-checked (see comment above)
  // and don't show up in `stats.checked` / `stats.valid`. They keep
  // their original order at the end of the candidate list so a strong
  // HEAD-verified PDF outranks them; download.ts handles them via the
  // welibResolver path.
  return { urls: [...valid, ...rest, ...welibUrls], stats };
}
