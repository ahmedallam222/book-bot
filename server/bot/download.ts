import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import TelegramBot from "node-telegram-bot-api";
import {
  UA, MAX_PDF_SIZE, TEMP_DIR,
  TIMEOUT_DOWNLOAD, TIMEOUT_TELEGRAM, TIMEOUT_UPLOAD,
} from "./config.js";
import { L } from "./logger.js";
import { isBlacklisted, recordUrlFailure, recordUrlSuccess } from "./blacklist.js";
import { ensureTempDir, safeDeleteTemp } from "./tempFiles.js";
import { escMd } from "./text.js";
import { validatePdfContent } from "./pdfValidator.js";
import type { DownloadResult } from "./types.js";

// ══════════════════════════════════════════════
// SKIP_DIRECT_DOMAINS
// كل موقع هنا → السيرفر يحمّله محلياً أولاً
// لأن Telegram يفشل في fetch الـ PDF مباشرة منهم
// ══════════════════════════════════════════════
const SKIP_DIRECT_DOMAINS = [
  // ══ archive.org ══════════════════════════════
  "archive.org/download",
  "archive.org/compress",

  // ══ مكتبات إسلامية ═══════════════════════════
  "dl.waqfeya.net",
  "waqfeya.net",

  // ══ مكتبات عربية — مطابق sources.ts ══════════
  "noor-book.com",
  "hindawi.org",
  "al-maktaba.org",
  "books-library.net",
  "foulabook.com",
  "kotobati.com",
  "novbook.net",
  "arabic-book.net",
  "ktabpdf.com",
  "kutub-pdf.net",
  "kutubm.com",
  "kutub.info",
  "kutubdl.site",

  // ══ domains إضافية من .env بدون إعادة deploy ══
  ...(process.env.SKIP_DOMAINS_EXTRA || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean),
];

function shouldSkipDirect(url: string): boolean {
  return SKIP_DIRECT_DOMAINS.some((d) => url.includes(d));
}

function isSlowArchiveUrl(url: string): boolean {
  return /\/\/(?:www\.)?(?:archive\.org|ia\d+\.us\.archive\.org)\//i.test(url);
}

// ══════════════════════════════════════════════
// PRE-VALIDATE
// يفحص 5 bytes فقط — هل الـ URL يُقدّم PDF حقيقي؟
// fail-open: أي خطأ شبكي → true (جرّب الإرسال)
// false فقط لو magic bytes مش %PDF-
// ══════════════════════════════════════════════
async function preValidatePdfUrl(pdfUrl: string): Promise<boolean> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const r = await fetch(pdfUrl, {
      headers: {
        "User-Agent": UA,
        "Range":      "bytes=0-4",
        "Accept":     "application/pdf,*/*",
      },
      signal:   ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!r.ok || !r.body) return true;

    const ct = r.headers.get("content-type") || "";
    if (ct.includes("html")) return true;

    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < 5) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        total += value.length;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    if (buf.length < 5) return true;

    if (buf.slice(0, 5).toString("ascii") !== "%PDF-") {
      L.warn("download", "preValidate: not a PDF (bad magic) — skipping", {
        url: pdfUrl.slice(0, 80),
      });
      return false;
    }

    return true;
  } catch (e: any) {
    clearTimeout(timer);
    const err = String(e?.message || e);
    if (!err.includes("abort")) {
      L.warn("download", `preValidate error — fail-open: ${err.slice(0, 80)}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════
// ARCHIVE.ORG RESOLVER
// يُحوِّل /details/ID → رابط PDF مباشر عبر metadata API
// ══════════════════════════════════════════════
async function expandArchiveOrgUrl(url: string): Promise<string | null> {
  const m = url.match(/archive\.org\/details\/([^/?#]+)/);
  if (!m) return null;

  const identifier = m[1];
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  try {
    const r = await fetch(`https://archive.org/metadata/${identifier}`, {
      headers: { "User-Agent": UA },
      signal:  ctrl.signal,
    });
    clearTimeout(timer);

    if (!r.ok) return null;

    const data = await r.json() as {
      files?: { name: string; format?: string; size?: string }[];
    };
    const files = data.files ?? [];

    const PREFERRED_FORMATS = ["Text PDF", "Additional Text PDF"];
    let pdfFile = files.find((f) => PREFERRED_FORMATS.includes(f.format ?? ""));
    if (!pdfFile) {
      pdfFile = files.find((f) => f.name.toLowerCase().endsWith(".pdf"));
    }
    if (!pdfFile) return null;

    const directUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(pdfFile.name)}`;
    L.info("download", "Resolved archive.org details → direct PDF", {
      identifier,
      file:   pdfFile.name.slice(0, 60),
      format: pdfFile.format ?? "unknown",
    });
    return directUrl;
  } catch (e) {
    clearTimeout(timer);
    L.warn("download", `expandArchiveOrgUrl error: ${String(e).slice(0, 80)}`);
    return null;
  }
}

// ══════════════════════════════════════════════
// FOULABOOK RESOLVER
// foulabook.com/<lang>/book/<slug>  هو landing page بـ HTML.
// الـ PDF الفعلي بيتقدّم من /book/downloading/<id>
// (Content-Type: application/pdf, content-disposition: attachment).
// نفتح الـ landing page مرة واحدة ونستخرج الـ id.
// ══════════════════════════════════════════════
async function expandFoulabookUrl(url: string): Promise<string | null> {
  if (!/foulabook\.com\/[a-z]{2}\/book\//i.test(url)) return null;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":      UA,
        "Accept":          "text/html,application/xhtml+xml",
        "Accept-Language": "ar,ar-SA;q=0.9,en;q=0.5",
      },
      signal:   ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!r.ok) return null;

    const html = (await r.text().catch(() => "")).slice(0, 200_000);
    const m = html.match(/foulabook\.com\/book\/downloading\/(\d+)/i);
    if (!m) return null;

    const directUrl = `https://foulabook.com/book/downloading/${m[1]}`;
    L.info("download", "Resolved foulabook landing → direct PDF", {
      landing: url.slice(0, 80),
      id:      m[1],
    });
    return directUrl;
  } catch (e) {
    clearTimeout(timer);
    L.warn("download", `expandFoulabookUrl error: ${String(e).slice(0, 80)}`);
    return null;
  }
}

// ══════════════════════════════════════════════
// MAIN — downloadAndSend
// ══════════════════════════════════════════════
export async function downloadAndSend(
  bot:      TelegramBot,
  chatId:   number,
  pdfUrl:   string,
  bookName: string,
  token:    string,
  _noFollow = false
): Promise<DownloadResult> {
  if (isSlowArchiveUrl(pdfUrl)) {
    L.warn("download", "Skipping slow archive.org URL", { url: pdfUrl.slice(0, 80) });
    await recordUrlFailure(pdfUrl);
    return { ok: false, permanent: true };
  }

  // ── archive.org/details/ → رابط مباشر ────────
  if (pdfUrl.includes("archive.org/details/")) {
    const expanded = await expandArchiveOrgUrl(pdfUrl);
    if (expanded) {
      pdfUrl = expanded;
    } else {
      L.warn("download", "Could not resolve archive.org details — will try as-is", {
        url: pdfUrl.slice(0, 80),
      });
    }
  }

  // ── foulabook.com/<lang>/book/ → /book/downloading/<id> ──
  if (/foulabook\.com\/[a-z]{2}\/book\//i.test(pdfUrl)) {
    const expanded = await expandFoulabookUrl(pdfUrl);
    if (expanded) {
      pdfUrl = expanded;
    } else {
      L.warn("download", "Could not resolve foulabook landing — will try as-is", {
        url: pdfUrl.slice(0, 80),
      });
    }
  }

  if (await isBlacklisted(pdfUrl)) {
    L.dlFail(pdfUrl, "blacklisted");
    return { ok: false };
  }

  L.dlStart(pdfUrl, bookName);
  const t0 = Date.now();

  // ══════════════════════════════════════════════
  // محاولة 1: URL مباشر لـ Telegram
  // ══════════════════════════════════════════════
  if (!shouldSkipDirect(pdfUrl)) {
    const preValid = await preValidatePdfUrl(pdfUrl);
    if (!preValid) {
      L.warn("download", "preValidate: not a PDF — skipping permanently", {
        url: pdfUrl.slice(0, 80),
      });
      return { ok: false, permanent: true };
    }

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_TELEGRAM);
      let d: any;
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          signal:  ctrl.signal,
          body: JSON.stringify({
            chat_id:    chatId,
            document:   pdfUrl,
            caption:    `📚 *${escMd(bookName)}*

✅ من خلاصة الكتب`,
            parse_mode: "Markdown",
          }),
        });
        d = await r.json();
      } finally {
        clearTimeout(timer);
      }

      if (d.ok) {
        const sizeMB = d.result?.document?.file_size
          ? (d.result.document.file_size / 1024 / 1024).toFixed(1)
          : "?";
        L.dlDirect(bookName, sizeMB);
        await recordUrlSuccess(pdfUrl);
        return {
          ok: true,
          fileId:   d.result?.document?.file_id,
          sizeMB,
          sendMode: "direct",
        };
      }

      if (d.error_code && d.error_code >= 400 && d.error_code < 500) {
        const desc: string = d.description || "";
        const isRetryable =
          desc.includes("failed to get HTTP URL content") ||
          desc.includes("Wrong URL") ||
          desc.includes("file must be non-empty");

        if (!isRetryable) {
          L.dlFail(pdfUrl, `Telegram error ${d.error_code}: ${desc}`);
          await recordUrlFailure(pdfUrl);
          return { ok: false, permanent: true };
        }

        L.warn("download", "Telegram direct blocked — falling back to local", {
          code: d.error_code,
          desc: desc.slice(0, 80),
        });
        // نكمل للمحاولة المحلية
      }
    } catch (e: any) {
      const err = String(e?.message || e);
      if (err.includes("abort") || err.includes("timeout")) {
        L.dlTimeout(pdfUrl, Date.now() - t0);
      } else {
        L.dlFail(pdfUrl, err);
      }
      // نكمل للمحاولة المحلية
    }
  } else {
    L.info("download", "Skipping Telegram direct — domain in SKIP list", {
      url: pdfUrl.slice(0, 80),
    });
  }

  // ══════════════════════════════════════════════
  // محاولة 2: تحميل محلي بـ stream pipeline
  // ══════════════════════════════════════════════
  ensureTempDir();
  const tempPath = path.join(
    TEMP_DIR,
    `${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`
  );

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_DOWNLOAD);

  try {
    const r = await fetch(pdfUrl, {
      headers: {
        "User-Agent":      UA,
        "Accept":          "application/pdf,*/*",
        "Accept-Language": "ar,ar-SA;q=0.9,en;q=0.5",
      },
      signal:   ctrl.signal,
      redirect: "follow",
    });

    if (!r.ok || !r.body) {
      L.dlFail(pdfUrl, `HTTP ${r.status}`);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    const ct = r.headers.get("content-type") || "";

    // ── HTML response → ابحث عن رابط PDF داخله ─
    if (ct.includes("html")) {
      if (!_noFollow) {
        try {
          const htmlPeek = (await r.text().catch(() => "")).slice(0, 6000);
          const pdfInPage =
            htmlPeek.match(/href=["']([^"']+\.pdf(?:[?#][^"']*)?)/i)?.[1] ??
            htmlPeek.match(/(https?:\/\/[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?)/i)?.[1];

          if (pdfInPage) {
            let fullPdfUrl = pdfInPage;
            if (!fullPdfUrl.startsWith("http")) {
              try { fullPdfUrl = new URL(fullPdfUrl, pdfUrl).href; } catch {}
            }
            if (fullPdfUrl.startsWith("http") && fullPdfUrl !== pdfUrl) {
              L.info("download", "Extracted PDF URL from HTML — following", {
                original: pdfUrl.slice(0, 60),
                found:    fullPdfUrl.slice(0, 80),
              });
              safeDeleteTemp(tempPath);
              clearTimeout(timer);
              return downloadAndSend(bot, chatId, fullPdfUrl, bookName, token, true);
            }
          }
        } catch { /* HTML غير قابل للقراءة → نكمل للفشل الطبيعي */ }
      }

      L.dlFail(pdfUrl, "response is HTML not PDF");
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    // ── Stream pipeline مع size limiter ──────────
    let totalBytes = 0;
    const sizeLimiter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_PDF_SIZE) {
          done(new Error("FILE_TOO_LARGE"));
        } else {
          done(null, chunk);
        }
      },
    });

    const writeStream = fs.createWriteStream(tempPath);
    try {
      await pipeline(Readable.fromWeb(r.body as any), sizeLimiter, writeStream);
    } catch (pipeErr: any) {
      safeDeleteTemp(tempPath);
      if (pipeErr?.message === "FILE_TOO_LARGE") {
        L.dlTooLarge(pdfUrl, totalBytes / 1024 / 1024);
        return { ok: false };
      }
      if (String(pipeErr).includes("abort") || String(pipeErr).includes("timeout")) {
        L.dlTimeout(pdfUrl, Date.now() - t0);
      } else {
        L.dlFail(pdfUrl, String(pipeErr));
      }
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    // ── تحقق من الملف ────────────────────────────
    if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size < 1024) {
      L.dlFail(pdfUrl, "temp file too small or missing");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    // فحص magic bytes عبر fs/promises
    let magic: Buffer;
    {
      const magicBuf = Buffer.alloc(10);
      const fh       = await fsPromises.open(tempPath, "r");
      try {
        await fh.read(magicBuf, 0, 10, 0);
      } finally {
        await fh.close();
      }
      magic = magicBuf;
    }

    if (!magic.includes(Buffer.from("%PDF"))) {
      L.dlFail(pdfUrl, "no PDF signature in file");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    // ── validatePdfContent — تحقق من المحتوى ─────
    const validation = await validatePdfContent(tempPath, bookName, pdfUrl);
    if (!validation.accepted) {
      L.warn("download", "PDF rejected — content mismatch", {
        book:      bookName.slice(0, 50),
        url:       pdfUrl.slice(0, 80),
        score:     validation.score.toFixed(2),
        metaTitle: validation.metaTitle.slice(0, 60) || "(empty)",
        event:     validation.event,
        mistral:   validation.mistralUsed,
      });
      safeDeleteTemp(tempPath);
      return { ok: false, rejectedContent: true };
    }

    // ── اسم الملف ─────────────────────────────────
    const cleanBookName = bookName
      .replace(/[/\\:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 80);
    const fname = `${cleanBookName || "book"}.pdf`;

    // ── إرسال لـ Telegram ─────────────────────────
    let sent: TelegramBot.Message;
    let uploadTimerId: ReturnType<typeof setTimeout> | null = null;
    try {
      sent = await Promise.race([
        bot.sendDocument(
          chatId,
          tempPath,
          {
            caption:    `📚 *${escMd(bookName)}*

✅ من خلاصة الكتب`,
            parse_mode: "Markdown",
          },
          { filename: fname, contentType: "application/pdf" }
        ),
        new Promise<never>((_, rej) => {
          uploadTimerId = setTimeout(
            () => rej(new Error("UPLOAD_TIMEOUT")),
            TIMEOUT_UPLOAD
          );
        }),
      ]);
    } finally {
      if (uploadTimerId !== null) clearTimeout(uploadTimerId);
      safeDeleteTemp(tempPath);
    }

    const sizeMB = (totalBytes / 1024 / 1024).toFixed(1);
    L.dlLocal(bookName, sizeMB, Date.now() - t0);
    await recordUrlSuccess(pdfUrl);

    return {
      ok:       true,
      fileId:   sent.document?.file_id,
      sizeMB,
      sendMode: "local",
    };

  } catch (e: any) {
    const err = String(e?.message || e);
    if (err.includes("UPLOAD_TIMEOUT")) {
      safeDeleteTemp(tempPath);
      L.dlTimeout(pdfUrl, Date.now() - t0);
    } else if (err.includes("abort") || err.includes("timeout")) {
      L.dlTimeout(pdfUrl, Date.now() - t0);
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
    } else {
      L.dlFail(pdfUrl, err);
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
    }
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
