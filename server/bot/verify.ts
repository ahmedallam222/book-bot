import { createHash } from "crypto";
import { isBlacklisted } from "./blacklist.js";
import { redis } from "./redis.js";
import { UA, TIMEOUT_VERIFY, VERIFY_CACHE_TTL } from "./config.js";
import { L } from "./logger.js";

// ══════════════════════════════════════════════
// VERIFY — فحص صلاحية روابط PDF
//
// المنطق:
//  1. فلتر روابط Blacklist أولاً (رخيص — Redis lookup)
//  2. فحص كاش Redis (تجنب HTTP مكرر)
//  3. HEAD request (أو GET partial) للتحقق من:
//     - الرابط يرد (2xx)
//     - Content-Type يحوي pdf أو octet-stream
//     - Content-Length > 10KB (ليس ملف فارغ/خطأ)
// ══════════════════════════════════════════════

interface VerifyStats {
  blacklisted: number;
  checked:     number;
  valid:       number;
}

export interface VerifyBatchResult {
  urls:  string[];
  stats: VerifyStats;
}

// BUG FIX: base64url.slice(0,80) كانت تُنتج تصادمات لـ URLs طويلة تختلف بعد الحرف 60.
// مثال: url1 = "https://site.com/books/very-long-path-A-..." و url2 = "...path-B-..."
// قد ينتجان نفس الـ base64 prefix → نفس cache key → نتيجة خاطئة للـ URL الثاني.
// الحل: SHA-256 يضمن uniqueness كاملاً لأي إدخال — نفس النهج في pdfValidator.ts
function verifyCacheKey(url: string): string {
  return `vcache:${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
}

/**
 * verifyPdfUrl
 * ─────────────
 * يتحقق من صلاحية رابط PDF واحد.
 * يُعيد: "valid" | "invalid" | "unknown" (timeout/error)
 */
async function verifyPdfUrl(url: string): Promise<"valid" | "invalid" | "unknown"> {
  // ── فحص الكاش ──────────────────────────────
  const cacheKey = verifyCacheKey(url);
  try {
    const cached = await redis.get(cacheKey);
    if (cached === "1") return "valid";
    if (cached === "0") return "invalid";
  } catch { /* تجاهل خطأ Redis → نكمل الفحص */ }

  // ── HEAD request ─────────────────────────────
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_VERIFY);

  try {
    const r = await fetch(url, {
      method:  "HEAD",
      headers: {
        "User-Agent": UA,
        "Accept":     "application/pdf,*/*",
      },
      signal:   ctrl.signal,
      redirect: "follow",
    });

    // إذا HEAD مرفوض → جرّب GET بأول 256 bytes فقط
    // BUG FIX: كان يُشارك نفس ctrl مع HEAD — إذا استغرق HEAD 8 ثوانٍ ثم أعاد 403،
    // يتبقى ثانيتان فقط للـ GET وقد يُلغى قبل الاستجابة → URL يُصنَّف خطأً كـ "unknown".
    // الحل: AbortController جديد مع timeout مستقل لكل محاولة GET fallback.
    if (r.status === 405 || r.status === 403) {
      const ctrl2  = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), TIMEOUT_VERIFY);
      let r2: Response;
      try {
        r2 = await fetch(url, {
          method:  "GET",
          headers: {
            "User-Agent": UA,
            "Accept":     "application/pdf,*/*",
            "Range":      "bytes=0-255",
          },
          signal:   ctrl2.signal,
          redirect: "follow",
        });
      } finally {
        clearTimeout(timer2);
      }
      if (!r2.ok) {
        await redis.setex(cacheKey, Math.floor(VERIFY_CACHE_TTL / 1000), "0");
        return "invalid";
      }
      // BUG-E FIX: الكود القديم: `await r2.arrayBuffer()` يُنزِّل الملف كاملاً
      // المشكلة: إذا تجاهل الـ server الـ Range header وأرسل 50MB كاملة
      //   → يستهلك TIMEOUT_VERIFY (10 ثوانٍ) قبل الاكتمال → URL يُصنَّف "unknown"
      //   → PDF صالح يُتجاهل فقط لأن التحقق استغرق وقتاً طويلاً
      // الحل: نقرأ أول chunk من الـ stream ثم نُلغيه فوراً
      //   أول chunk = 16KB عادةً (أكثر من كافٍ لـ 4 bytes %PDF)
      let hasPdf = false;
      try {
        const reader = r2.body?.getReader();
        if (reader) {
          const { value: firstChunk } = await reader.read();
          reader.cancel().catch(() => {}); // أوقف الـ stream — لا نحتاج الباقي
          const bytes = firstChunk || new Uint8Array(0);
          hasPdf = bytes.length >= 4 &&
            bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
        }
      } catch { /* تجاهل خطأ قراءة الـ stream → hasPdf يبقى false */ }
      const ttl = Math.floor(VERIFY_CACHE_TTL / 1000);
      await redis.setex(cacheKey, ttl, hasPdf ? "1" : "0");
      return hasPdf ? "valid" : "invalid";
    }

    if (!r.ok) {
      await redis.setex(cacheKey, Math.floor(VERIFY_CACHE_TTL / 1000), "0");
      return "invalid";
    }

    const ct   = (r.headers.get("content-type") || "").toLowerCase();
    const size = parseInt(r.headers.get("content-length") || "0", 10);

    // قبول: pdf أو octet-stream أو application/force-download
    const looksLikePdf =
      ct.includes("pdf") ||
      ct.includes("octet-stream") ||
      ct.includes("application/force-download");

    // BUG FIX: Content-Type فارغ كان يُخزَّن كـ "0" (invalid) ويُمنع الـ URL نهائياً
    // كثير من مواقع الكتب العربية لا ترسل Content-Type صحيح مع HEAD
    // لكن الملف نفسه قد يكون PDF صالحاً — نُعامله كـ "unknown" ونتركه لـ download يحكم
    if (!ct) {
      return "unknown"; // لا نُخزَّن في الكاش — نجرّب عند التحميل الفعلي
    }

    const tooSmall = size > 0 && size < 10_240; // أقل من 10KB → مشبوه

    const result = looksLikePdf && !tooSmall;
    const ttl = Math.floor(VERIFY_CACHE_TTL / 1000);
    await redis.setex(cacheKey, ttl, result ? "1" : "0").catch(() => {});
    return result ? "valid" : "invalid";

  } catch (e: any) {
    const err = String(e?.message || e);
    if (err.includes("abort") || err.includes("timeout")) {
      L.debug("verify", `Timeout verifying: ${url.slice(0, 60)}`);
      return "unknown"; // timeout → لا تُخزِّن في الكاش — قد يكون مؤقتاً
    }
    // BUG FIX (BUG-REVIEW-1): الكود القديم كان يُخزِّن "0" (invalid) في الكاش
    // لكن يُعيد "unknown" — التناقض يسبب: أي طلب تالٍ خلال 60 ثانية يقرأ "0"
    // ويُعيد "invalid" → يُسقط الرابط كلياً رغم أنه لم يُثبَت أنه خاطئ.
    // الحل: لا نُخزّن شيئاً عند خطأ الشبكة — "unknown" يعني "لا أعلم، جرّب لاحقاً"
    L.debug("verify", `Network error verifying: ${url.slice(0, 60)} — ${err.slice(0, 60)}`);
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * findValidPdfUrls
 * ─────────────────
 * يفلتر قائمة URLs ويُعيد الصالحة منها مع إحصائيات.
 *
 * الخوارزمية:
 *  1. فلتر Blacklist (Redis atomic)
 *  2. فحص كل رابط متبقٍّ بالتوازي (Promise.allSettled)
 *  3. ترتيب: "valid" أولاً ثم "unknown"
 *
 * الـ BUG السابق: كان يتحقق بشكل تسلسلي → بطيء جداً
 * الإصلاح: تشغيل كل الفحوصات بالتوازي مع timeout فردي
 */
export async function findValidPdfUrls(urls: string[]): Promise<VerifyBatchResult> {
  if (urls.length === 0) {
    return { urls: [], stats: { blacklisted: 0, checked: 0, valid: 0 } };
  }

  const stats: VerifyStats = { blacklisted: 0, checked: 0, valid: 0 };

  // ── فلتر Blacklist بالتوازي ────────────────────
  const blChecks = await Promise.allSettled(
    urls.map((u) => isBlacklisted(u))
  );

  const toCheck: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const isBlack = blChecks[i].status === "fulfilled" && blChecks[i].value;
    if (isBlack) {
      stats.blacklisted++;
      L.debug("verify", `Blacklisted: ${urls[i].slice(0, 60)}`);
    } else {
      toCheck.push(urls[i]);
    }
  }

  if (toCheck.length === 0) {
    return { urls: [], stats };
  }

  // ── فحص URL بالتوازي ──────────────────────────
  stats.checked = toCheck.length;

  const verifyResults = await Promise.allSettled(
    toCheck.map((u) => verifyPdfUrl(u))
  );

  const validUrls:   string[] = [];
  const unknownUrls: string[] = [];

  for (let i = 0; i < toCheck.length; i++) {
    const res = verifyResults[i];
    const result = res.status === "fulfilled" ? res.value : "unknown";
    if (result === "valid") {
      validUrls.push(toCheck[i]);
      stats.valid++;
    } else if (result === "unknown") {
      // timeout/error → نُضيفها كـ fallback (قد تنجح عند التحميل الفعلي)
      unknownUrls.push(toCheck[i]);
    }
    // "invalid" → نتجاهلها كلياً
  }

  // الصالحة أولاً ثم المجهولة كـ fallback
  return {
    urls:  [...validUrls, ...unknownUrls],
    stats,
  };
}
