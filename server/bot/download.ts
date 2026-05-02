import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import TelegramBot from "node-telegram-bot-api";
import { UA, MAX_PDF_SIZE, TEMP_DIR, TIMEOUT_DOWNLOAD, TIMEOUT_TELEGRAM, TIMEOUT_UPLOAD } from "./config.js";
import { L } from "./logger.js";
import { isBlacklisted, recordUrlFailure, recordUrlSuccess } from "./blacklist.js";
import { ensureTempDir, safeDeleteTemp } from "./tempFiles.js";
import { escMd } from "./text.js";
import { validatePdfContent } from "./pdfValidator.js";
import type { DownloadResult } from "./types.js";

// ══════════════════════════════════════════════
// DOWNLOAD & SEND — Stream pipeline + Logging
// ══════════════════════════════════════════════

/**
 * Domains التي تحجب Telegram من تنزيل ملفاتها مباشرة.
 * Telegram يحاول fetch الـ URL من سيرفراته — هذه الـ domains ترفضه
 * أو ترجع HTML بدل PDF.
 * الحل: تخطي محاولة Telegram المباشرة والنزول محلياً فوراً.
 */
const SKIP_DIRECT_DOMAINS = [
  // مواقع تحجب Telegram من تنزيل ملفاتها مباشرة
  "dl.waqfeya.net",
  "books-library.net",
  "1lib.sk",
  "annas-archive.org",
  "libgen.is", "libgen.rs", "libgen.st",
  "library.lol",
  "z-lib.org", "z-lib.bo",
  // مصادر جديدة — تستخدم redirect أو session cookies
  "ktab.cc",
  "al-mostafa.com",
];

function shouldSkipDirect(url: string): boolean {
  return SKIP_DIRECT_DOMAINS.some((d) => url.includes(d));
}

function isSlowArchiveUrl(url: string): boolean {
  return /\/\/(?:www\.)?(?:archive\.org|ia\d+\.us\.archive\.org)\//i.test(url);
}

export async function downloadAndSend(
  bot: TelegramBot,
  chatId: number,
  pdfUrl: string,
  bookName: string,
  token: string,
  _noFollow = false   // BUG-D: يمنع متابعة HTML redirect مرتين (لا حلقة لانهائية)
): Promise<DownloadResult> {
  if (isSlowArchiveUrl(pdfUrl)) {
    L.warn("download", "Skipping slow archive.org URL", { url: pdfUrl.slice(0, 80) });
    await recordUrlFailure(pdfUrl);
    return { ok: false, permanent: true };
  }

  if (await isBlacklisted(pdfUrl)) {
    L.dlFail(pdfUrl, "blacklisted");
    return { ok: false };
  }

  L.dlStart(pdfUrl, bookName);
  const t0 = Date.now();

  // ── محاولة 1: URL مباشر لـ Telegram ──────────
  // نتخطاها لـ domains معروفة بحجب Telegram
  if (!shouldSkipDirect(pdfUrl)) {
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
            caption:    `📚 *${escMd(bookName)}*\n\n✅ من خلاصة الكتب`,
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
        return { ok: true, fileId: d.result?.document?.file_id, sizeMB, sendMode: "direct" };
      }

      // خطأ 4xx — إذا كان "failed to get HTTP URL content" جرّب محلياً بدل الاستسلام
      if (d.error_code && d.error_code >= 400 && d.error_code < 500) {
        const desc: string = d.description || "";
        if (
          desc.includes("failed to get HTTP URL content") ||
          desc.includes("Wrong URL") ||
          desc.includes("file must be non-empty")
        ) {
          L.warn("download", "Telegram direct blocked, trying local", {
            code: d.error_code, desc: desc.slice(0, 80),
          });
          // نكمل للمحاولة المحلية
        } else {
          // خطأ دائم حقيقي (file too large, etc.)
          L.dlFail(pdfUrl, `Telegram error ${d.error_code}: ${desc}`);
          await recordUrlFailure(pdfUrl);
          return { ok: false, permanent: true };
        }
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

  // ── محاولة 2: تحميل محلي بـ stream pipeline ──
  ensureTempDir();
  const tempPath = path.join(
    TEMP_DIR,
    `${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`
  );

  const ctrl      = new AbortController();
  // C2 FIX: timer يُعرَّف خارج try/finally لضمان clearTimeout دائماً
  // النمط السابق: clearTimeout() في كل مسار return منفصل → يُفوَّت في outer catch
  // النمط الصحيح: finally يضمن التنظيف بغض النظر عن أي مسار خروج
  const timer     = setTimeout(() => ctrl.abort(), TIMEOUT_DOWNLOAD);

  try {
    const r = await fetch(pdfUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "application/pdf,*/*",
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
    if (ct.includes("html")) {
      // BUG-D FIX: الكود القديم يفشل فوراً عند أي HTML response.
      // المشكلة: كثير من مواقع الكتب العربية تُعيد صفحة HTML تحتوي على رابط PDF
      //   (مثل صفحة تحميل مباشرة أو صفحة redirect إلى PDF)
      // الحل: نقرأ أول 6KB من HTML، نبحث عن رابط .pdf مباشر
      //   إذا وجدناه، نُعيد المحاولة بالرابط الجديد مباشرةً (مرة واحدة فقط — _noFollow يمنع التكرار)
      //   إذا لم نجد، نفشل كالمعتاد
      if (!_noFollow) {
        try {
          const htmlPeek = (await r.text().catch(() => "")).slice(0, 6000);
          const pdfInPage =
            // href مع .pdf
            htmlPeek.match(/href=["']([^"']+\.pdf(?:[?#][^"']*)?)/i)?.[1] ??
            // URL عادي مع .pdf
            htmlPeek.match(/(https?:\/\/[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?)/i)?.[1];

          if (pdfInPage) {
            // أكمل رابطاً نسبياً
            let fullPdfUrl = pdfInPage;
            if (!fullPdfUrl.startsWith("http")) {
              try { fullPdfUrl = new URL(fullPdfUrl, pdfUrl).href; } catch {}
            }
            if (fullPdfUrl.startsWith("http") && fullPdfUrl !== pdfUrl) {
              L.info("download", "Extracted PDF URL from HTML page — following", {
                original: pdfUrl.slice(0, 60), found: fullPdfUrl.slice(0, 80),
              });
              safeDeleteTemp(tempPath); // احذف الملف المؤقت الفارغ
              clearTimeout(timer);      // أوقف الـ timer قبل الـ recursive call
              // _noFollow=true يمنع متابعة HTML مرة ثانية
              // ملاحظة: clearTimeout هنا صحيح — finally الخارجي يستدعيه مجدداً لكن clearTimeout(id) idempotent آمن
              return downloadAndSend(bot, chatId, fullPdfUrl, bookName, token, true);
            }
          }
        } catch { /* HTML غير قابل للقراءة → نكمل للفشل الطبيعي */ }
      }

      L.dlFail(pdfUrl, "response is HTML not PDF");
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    // Stream pipeline مع size limiter — ctrl.signal لا يزال نشطاً يحمي الـ stream
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

    // تحقق من الملف
    if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size < 1024) {
      L.dlFail(pdfUrl, "temp file too small or missing");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    // BUG FIX: كان يستخدم fs.openSync/readSync/closeSync — يُعطّل event loop + fd leak إذا throw
    // الحل: fs/promises مع try/finally يضمن إغلاق fd في كل الحالات
    let magic: Buffer;
    {
      const magicBuf = Buffer.alloc(10);
      const fhMagic  = await fsPromises.open(tempPath, "r");
      try {
        await fhMagic.read(magicBuf, 0, 10, 0);
      } finally {
        await fhMagic.close();
      }
      magic = magicBuf;
    }

    if (!magic.includes(Buffer.from("%PDF"))) {
      L.dlFail(pdfUrl, "no PDF signature in file");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    // ── تحقق من محتوى الـ PDF (anti false-positive) ──────
    // نتحقق أن الملف المُحمَّل هو فعلاً الكتاب المطلوب
    // قبل رفعه لـ Telegram — نمنع false positives
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
      // ملاحظة: لا نستدعي recordUrlFailure هنا
      // لأن الـ URL نجح في تقديم PDF صالح — المشكلة في المحتوى وليس الـ URL
      // recordUrlFailure مخصص لـ URLs التي تفشل في تقديم ملف PDF أصلاً
      return { ok: false, rejectedContent: true };
    }

    let fname = "";
    try { fname = decodeURIComponent(pdfUrl.split("/").pop()?.split("?")[0] || ""); } catch {}
    if (!fname.toLowerCase().endsWith(".pdf")) {
      fname = `${bookName.replace(/[/\\:*?"<>|]/g, "_")}.pdf`;
    }

    // ── إرسال الملف لـ Telegram ───────────────────
    // finally يضمن حذف الملف في كل الحالات:
    //   ✅ نجح الإرسال       → حُذف
    //   ✅ فشل بـ exception  → حُذف
    //   ✅ انتهى JOB_TIMEOUT → حُذف فوراً (لا ينتظر sendDocument)
    //
    // FIX — timer leak: لو sendDocument نجح قبل 120s، كان الـ timer يفضل معلّق
    // الحل: نحتفظ بـ uploadTimerId ونُلغيه بعد نجاح sendDocument
    //
    // FIX — UPLOAD_TIMEOUT ≠ URL failure: التأخير من Telegram وليس من الـ URL
    // لذا لا نستدعي recordUrlFailure عند UPLOAD_TIMEOUT بل نرجع { ok: false } فقط
    let sent: TelegramBot.Message;
    let uploadTimerId: ReturnType<typeof setTimeout> | null = null;
    try {
      sent = await Promise.race([
        bot.sendDocument(
          chatId,
          tempPath,
          { caption: `📚 *${escMd(bookName)}*\n\n✅ من خلاصة الكتب`, parse_mode: "Markdown" },
          { filename: fname, contentType: "application/pdf" }
        ),
        new Promise<never>((_, rej) => {
          uploadTimerId = setTimeout(() => rej(new Error("UPLOAD_TIMEOUT")), TIMEOUT_UPLOAD);
        }),
      ]);
    } finally {
      // BUG FIX: uploadTimerId يجب إلغاؤه في finally وليس فقط عند النجاح.
      // إذا sendDocument رمى خطأ غير UPLOAD_TIMEOUT، الـ timer يظل يعمل
      // ويُطلق reject على Promise مُستقرة → UnhandledPromiseRejection.
      if (uploadTimerId !== null) clearTimeout(uploadTimerId);
      // يُشغَّل دائماً — الملف لن يبقى على السيرفر بعد محاولة الإرسال
      safeDeleteTemp(tempPath);
    }

    const sizeMB = (totalBytes / 1024 / 1024).toFixed(1);
    const ms     = Date.now() - t0;
    L.dlLocal(bookName, sizeMB, ms);
    await recordUrlSuccess(pdfUrl);

    return { ok: true, fileId: sent.document?.file_id, sizeMB, sendMode: "local" };
  } catch (e: any) {
    const err = String(e?.message || e);
    if (err.includes("UPLOAD_TIMEOUT")) {
      // Telegram بطيء في استقبال الملف — ليس خطأ الـ URL → لا نُسجّله كفشل
      // BUG FIX: كان يفوّت safeDeleteTemp عند UPLOAD_TIMEOUT → ملف مؤقت يبقى على الديسك
      // الـ finally الداخلي (في try sendDocument) يُشغَّل دائماً، لكن لو الـ race ربح
      // timeoutPromise فإن finally الخارجي هو المسؤول عن التنظيف
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
    // C2 FIX: يُشغَّل دائماً — سواء نجح أو فشل أو throw — لا timer leak
    clearTimeout(timer);
  }
}
