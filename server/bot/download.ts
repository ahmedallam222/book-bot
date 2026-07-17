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
import { redis } from "./redis.js";
import { isBlacklisted, recordUrlFailure, recordUrlSuccess } from "./blacklist.js";
import { ensureTempDir, safeDeleteTemp } from "./tempFiles.js";
import { escMd, urlFilenameRelevance } from "./text.js";
import { validatePdfContent } from "./pdfValidator.js";
import { downloadNoorBookPdf } from "./noorBookResolver.js";
import { downloadWelibPdf, isWelibHost } from "./welibResolver.js";
import {
  downloadTelegramFile,
  isTelegramUrl,
  parseTelegramUrl,
} from "./telegramFallback.js";
import type { DownloadResult } from "./types.js";


// ══════════════════════════════════════════════
// SIZE / UPLOAD ERROR HELPERS
// Telegram Bot API hard-caps sendDocument at 50MB. Channel files (via
// userbot) and some web hosts serve larger PDFs. Without early rejection
// we download → validate → upload → 413, then bookRequest retries the
// same URL as a "transient" failure (production 2026-07-15: إحياء علوم
// الدين burned 4 attempts / ~6 min on two 413s).
// ══════════════════════════════════════════════
export function isTelegramUploadSizeError(err: unknown): boolean {
  const e = String((err as any)?.message || err || "").toLowerCase();
  return (
    e.includes("413") ||
    e.includes("request entity too large") ||
    e.includes("file is too big") ||
    e.includes("file_too_big") ||
    e.includes("payload too large") ||
    (e.includes("document_invalid") && e.includes("size"))
  );
}

export function rejectIfTempTooLarge(tempPath: string, pdfUrl: string): DownloadResult | null {
  try {
    if (!fs.existsSync(tempPath)) return null;
    const size = fs.statSync(tempPath).size;
    if (size > MAX_PDF_SIZE) {
      L.dlTooLarge(pdfUrl, size / 1024 / 1024);
      redis.incr("tel:dl:too_large").catch(() => {});
      safeDeleteTemp(tempPath);
      // permanent: bookRequest must NOT re-download the same URL
      return { ok: false, permanent: true, tooLarge: true };
    }
  } catch {
    /* ignore stat errors — upload path will surface real failures */
  }
  return null;
}

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
  "mktbtypdf.com",
  "kutub.info",
  // kutubdl.site was here (added in PR #124, removed in PR #126 —
  // turned out to be a content-farm SEO domain, not an actual library).

  // ══ domains إضافية من .env بدون إعادة deploy ══
  ...(process.env.SKIP_DOMAINS_EXTRA || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean),
];

function shouldSkipDirect(url: string): boolean {
  return SKIP_DIRECT_DOMAINS.some((d) => url.includes(d));
}

// ══════════════════════════════════════════════
// DIRECT-SEND SAFETY GATE
//
// Direct mode (Telegram fetches the URL itself via sendDocument with a
// remote URL) is faster but **completely bypasses pdfValidator**: there
// is no local file to inspect for /Title metadata, no Mistral re-rank,
// no metaTitle vs bookName check. Without a content-side gate, any
// trusted-but-unrelated URL the search ranker hands us can be delivered
// to the user verbatim.
//
// Production incident 2026-05-03: user requested "الموجز في فن التفاوض";
// the bot direct-sent archive.org URL
// `dn790006.ca.archive.org/.../dalilkuwa-s2021-a.pdf` (= "الدليل إلى
// القوة والدهاء", a completely different book). The url's slug is
// informative-looking (not digit-only) so neither the direct path's
// pre-validate step nor pdfValidator's trusted-domain bypass would have
// caught it — but they never ran anyway because direct mode skipped
// validation entirely.
//
// Returns true when direct mode is unsafe and the caller must fall
// through to local-download + full pdfValidator + Mistral.
//
// Heuristic: if the URL filename has insufficient token overlap with
// the requested book name, we have no signal that the URL is the right
// book.
//
// FIX-WRONG-FILE (BUG-5): the original threshold (0.15) left a
// "validation dead zone" between 0.15 and PDF_VALIDATE_ACCEPT_THRESHOLD
// (0.40). URLs scoring inside that band were direct-sent to Telegram
// without ever entering pdfValidator → no metadata check, no Mistral
// → wrong-but-similar books (e.g. "العقيدة الواسطية" vs
// "العقيدة السفارينية" — only "العقيدة" overlaps, score ~0.30) leaked
// through. Raising to 0.40 closes the dead zone: only confidently
// matching filenames stay in direct mode; everything else falls
// through to local-download + full validation.
//
// Digit-only/neutral filenames (urlFilenameRelevance returns 0.3) are
// now flagged unsafe — but those domains are typically already in
// SKIP_DIRECT_DOMAINS (Hindawi/foulabook/archive.org-style), and the
// trusted-domain branch in pdfValidator handles them after local
// download with proper title verification.
function directSendUnsafe(bookName: string, pdfUrl: string): boolean {
  const score = urlFilenameRelevance(bookName, pdfUrl);
  return score < 0.40;
}

// ══════════════════════════════════════════════
// CONTENT-DISPOSITION FILENAME PARSER
// HTTP `Content-Disposition` header بيحمل اسم الملف الحقيقي حتى لو الـ URL
// pathname رقم بحت (مثلاً Hindawi /books/62575295.pdf، foulabook
// /book/downloading/123). الـ header بيكون بصيغتين:
//   1. RFC 5987: filename*=UTF-8''<percent-encoded>   ← الأصدق (Unicode-safe)
//   2. RFC 2616: filename="..." أو filename=...        ← fallback (ASCII)
// لو الاتنين موجودين، RFC 6266 بيقول نفضّل filename* لأنها بتدعم Unicode.
// ══════════════════════════════════════════════

// FIX-MOJIBAKE: Node's `fetch` يقرأ HTTP headers كـ Latin-1 (طبقاً لـ RFC 7230)،
// لكن سيرفرات حقيقية (مثلاً Google Drive) بترسل UTF-8 raw في
// `Content-Disposition: filename=` بدون RFC 5987 percent-encoding. النتيجة:
// "أرض زيكولا" بيتقرأ كـ "Ø§ÙØ±Ø¶ Ø²ÙÙÙÙØ§" (mojibake). الـ pdfValidator
// بعدها بيرفض لأن الـ filename مفهوش حروف عربي ولا لاتيني → "meaningless".
//
// الـ heuristic: re-encode الـ string كـ Latin-1 bytes → UTF-8 string. لو الناتج
// فيه حروف عربي صحيحة، نستخدمه؛ لو لأ نسيب الأصل كما هو.
function fixHeaderMojibake(s: string): string {
  if (!s) return s;
  // ASCII فقط → مفيش mojibake محتمل
  if (!/[\u0080-\u00FF]/.test(s)) return s;
  // الـ string فيه Unicode حقيقي (عربي، CJK، Cyrillic، ...) → مش mojibake
  if (/[\u0100-\u05FF\u0700-\uFFFF]/.test(s)) return s;
  try {
    const reEncoded = Buffer.from(s, "latin1").toString("utf8");
    // لو الإعادة طلعت حروف عربي صحيحة، استخدمها
    if (/[\u0600-\u06FF]/.test(reEncoded)) return reEncoded;
    // أو لو طلعت حروف Latin extended صحيحة بدون replacement chars
    if (/[\u00C0-\u017F]/.test(reEncoded) && !/\uFFFD/.test(reEncoded)) {
      return reEncoded;
    }
  } catch { /* ignore */ }
  return s;
}

function parseContentDispositionFilename(header: string | null): string {
  if (!header) return "";

  // RFC 5987 — filename*=charset'lang'percent-encoded-value
  // مثال: filename*=UTF-8''%D8%B2%D9%82%D8%A7%D9%82_%D8%A7%D9%84%D9%85%D8%AF%D9%82.pdf
  const ext = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (ext) {
    try {
      const charset = (ext[1] || "utf-8").trim().toLowerCase();
      // strip optional surrounding quotes
      const raw = ext[2].trim().replace(/^"|"$/g, "");
      // نفك ترميز الـ percent-encoding. لو charset غير UTF-8 (نادر جداً)
      // decodeURIComponent ممكن يفشل → نسيب الـ value الخام بدون encoding.
      if (charset === "utf-8" || charset === "utf8") {
        return fixHeaderMojibake(decodeURIComponent(raw));
      }
      return fixHeaderMojibake(raw);
    } catch { /* fallback to filename= */ }
  }

  // RFC 2616 — filename="..." (مع مسافات داخلية محتملة) أو filename=token (بدون quotes)
  const basic = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(header);
  if (basic) {
    const value = (basic[2] ?? basic[3] ?? "").trim();
    // بعض الـ servers بترسل filename=ASCII-version بصيغة percent-encoded حتى من
    // غير filename*. نحاول decode لو فيه %xx.
    if (/%[0-9A-Fa-f]{2}/.test(value)) {
      try { return fixHeaderMojibake(decodeURIComponent(value)); } catch { /* fall through */ }
    }
    return fixHeaderMojibake(value);
  }

  return "";
}

function isSlowArchiveUrl(url: string): boolean {
  return /\/\/(?:www\.)?(?:archive\.org|ia\d+\.us\.archive\.org)\//i.test(url);
}

// ══════════════════════════════════════════════
// FILENAME / CAPTION BUILDERS
// Use the actual book title from PDF metadata (or, when extraction fails,
// the search-result title) instead of the user's raw query for the file
// name shown in Telegram. This prevents the "file labeled X but contains Y"
// deception that occurred when the trusted-domain validator bypass let
// unrelated PDFs through. The caption keeps the user's query so they see
// what they asked for AND what they got side-by-side when the two differ.
// ══════════════════════════════════════════════
function sanitizePdfBaseName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
}

// metaTitle from validatePdfContent is the *real* book title (or empty
// for trusted-domain fast-path with no search title). When it is present
// and meaningfully different from bookName, prefer it for the filename
// so the file's identity is honest.
export function buildPdfFilename(bookName: string, metaTitle: string): string {
  const sanitizedBook = sanitizePdfBaseName(bookName);
  const cleanMeta = (metaTitle || "")
    .replace(/\.pdf$/i, "")
    .trim();
  if (cleanMeta && cleanMeta.length >= 4) {
    const sanitizedMeta = sanitizePdfBaseName(cleanMeta);
    if (sanitizedMeta && sanitizedMeta !== sanitizedBook) {
      return `${sanitizedMeta}.pdf`;
    }
  }
  return `${sanitizedBook || "book"}.pdf`;
}

// Caption shown in Telegram. Always includes user query so they see
// what they asked for. If validation surfaced a different real title,
// surface it explicitly so users can spot mismatches before opening.
export function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Caption shown in Telegram. Always includes user query so they see
// what they asked for. If validation surfaced a different real title,
// surface it explicitly so users can spot mismatches before opening.
export function buildCaption(bookName: string, metaTitle: string): string {
  const cleanMeta = (metaTitle || "").trim();
  // Show the actual title only when it diverges meaningfully from the
  // requested name (case- and whitespace-insensitive) so we don't add
  // noise on perfect matches.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const showActual = cleanMeta &&
                     cleanMeta.length >= 4 &&
                     norm(cleanMeta) !== norm(bookName);
  if (showActual) {
    return `📚 <b>${escHtml(bookName)}</b>\n📖 <i>${escHtml(cleanMeta)}</i>\n\n✅ من خلاصة الكتب`;
  }
  return `📚 <b>${escHtml(bookName)}</b>\n\n✅ من خلاصة الكتب`;
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
      // P3 (audit 2026-05-09): per-reason telemetry so ops can distinguish
      // "URL serves HTML disguised as PDF" (recurring with mislabelled CT)
      // from "URL is binary but not a PDF" (epub/zip/image). Both bail
      // here, but the headline ("191 extract_failed = 68% of validator
      // hits") needed a way to attribute the reject to download-time
      // vs validator-time.
      const head = buf.slice(0, Math.min(buf.length, 16)).toString("ascii").toLowerCase();
      const isHtml = head.includes("<!doc") || head.includes("<html") || head.includes("<?xml");
      if (isHtml) {
        redis.incr("tel:dl:prevalidate_html_rejected").catch(() => {});
      } else {
        redis.incr("tel:dl:prevalidate_bad_magic_rejected").catch(() => {});
      }
      L.warn("download", `preValidate: not a PDF (bad magic, html=${isHtml}) — skipping`, {
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
// MKTBTYPDF RESOLVER
// mktbtypdf.com/book/<slug>/   هو landing page بـ HTML.
// الـ download button بيوصّل لـ /download?id=<n>&external=1 → 301 →
// /download/?id=<n>&external=1 → 302 redirect لـ Google Drive
// (drive.usercontent.google.com/download?id=<gid>&export=download)
// → PDF حقيقي. Fetch redirect:"follow" بيمشي معاهم كلهم بدون
// تدخل إضافي.
// ══════════════════════════════════════════════
async function expandMktbtypdfUrl(url: string): Promise<string | null> {
  if (!/mktbtypdf\.com\/book\//i.test(url)) return null;

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
    // FIX: mktbtypdf بيخدّم الـ PDFs من backend-ين مختلفين:
    //   1. `?id=N&external=1`  → redirect لـ Google Drive (مثلاً "أرض زيكولا" id=662)
    //   2. `?id=N` (بدون external) → ملف محلي على نفس الـ host (مثلاً "شيفرة
    //      دافنشي" id=190)
    // كل كتاب بيظهر في الـ landing بـ form واحد بس. لو طلبنا `external=1` على
    // كتاب محلي بنرجع "Book file not found"، والعكس صحيح.
    // الحل: خذ الرابط من الـ HTML كما هو (نفضّل external لو موجود لأن CDN
    // بيكون أسرع، نفـ fallback للـ bare لو مش موجود).
    const extM =
      html.match(/mktbtypdf\.com\/download\/?\?id=(\d+)(?:&|&amp;)external=1/i);
    const bareM =
      extM ?? html.match(/mktbtypdf\.com\/download\/?\?id=(\d+)/i);
    if (!bareM) return null;

    // Trailing slash يتجنّب الـ 301 hop الأول من /download إلى /download/.
    const directUrl = extM
      ? `https://mktbtypdf.com/download/?id=${bareM[1]}&external=1`
      : `https://mktbtypdf.com/download/?id=${bareM[1]}`;
    L.info("download", "Resolved mktbtypdf landing → direct PDF", {
      landing: url.slice(0, 80),
      id:      bareM[1],
      external: !!extM,
    });
    return directUrl;
  } catch (e) {
    clearTimeout(timer);
    L.warn("download", `expandMktbtypdfUrl error: ${String(e).slice(0, 80)}`);
    return null;
  }
}

// ══════════════════════════════════════════════
// MAIN — downloadAndSend
// ══════════════════════════════════════════════
export async function downloadAndSend(
  bot:               TelegramBot,
  chatId:            number,
  pdfUrl:            string,
  bookName:          string,
  token:             string,
  _noFollow          = false,
  skipMistral        = false,
  searchResultTitle  = "",
): Promise<DownloadResult> {
  if (isSlowArchiveUrl(pdfUrl)) {
    L.warn("download", "Skipping slow archive.org URL", { url: pdfUrl.slice(0, 80) });
    await recordUrlFailure(pdfUrl);
    return { ok: false, permanent: true };
  }

  // عند تحويل الـ landing page لرابط داخلي بدون اسم الكتاب،
  // نحتفظ بالأصل ليصل لـ validatePdfContent كـ URL hint للـ Mistral
  // (الـ landing فيه slug الكتاب — مفيد للتحقق من التطابق)
  const originalUrl = pdfUrl;

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

  // ── mktbtypdf.com/book/<slug> → /download/?id=<n>&external=1 ──
  if (/mktbtypdf\.com\/book\//i.test(pdfUrl)) {
    const expanded = await expandMktbtypdfUrl(pdfUrl);
    if (expanded) {
      pdfUrl = expanded;
    } else {
      L.warn("download", "Could not resolve mktbtypdf landing — will try as-is", {
        url: pdfUrl.slice(0, 80),
      });
    }
  }

  if (await isBlacklisted(pdfUrl)) {
    L.dlFail(pdfUrl, "blacklisted");
    return { ok: false };
  }

  // ── noor-book.com → Playwright (CF + JS-driven download) ──
  // الموقع محمي بطبقتين CF + بروتوكول tokens داخلي. لا HTTP-only path
  // ممكن يحمّل الـ PDF — لازم browser session كامل.
  // noorBookDownload بتحمّل لـ tempPath ثم بنكمل بنفس validate + sendDocument.
  if (/(?:^|\.)noor-book\.com\//i.test(pdfUrl)) {
    return noorBookDownloadAndSend(bot, chatId, pdfUrl, bookName, token, originalUrl, skipMistral, searchResultTitle);
  }

  // ── *.welib.st / *.welib.org → Playwright (CF + 35-60s wait timer) ──
  // الموقع محمي بـ Cloudflare وعنده بروتوكول wait-then-reveal
  // للـ download URL. فلا HTTP-only path ممكن يوصل لـ PDF — بنسلّم لـ welibResolver
  // اللي بيفتح Chromium ، يستنّى ظهور الـ anchor على welib-public.org ، ثم
  // يسحب الرابط الـsigned ويحمّل بـ fetch عادي.
  if (isWelibHost(pdfUrl)) {
    return welibDownloadAndSend(bot, chatId, pdfUrl, bookName, token, originalUrl, skipMistral, searchResultTitle);
  }

  // ── tg://msg/* or https://t.me/<ch>/<id> → gramjs userbot ──
  // Telegram-channels fallback (3rd parallel search leg in engine.ts).
  // The userbot is a member of ~30 Arabic book channels and pulls the
  // PDF directly from the source message via MTProto. No CF, no slow-
  // download timer, no Cloudflare bypass — Telegram's own CDN serves
  // the bytes at line rate. Same pdfValidator + Mistral gating as any
  // other source.
  if (isTelegramUrl(pdfUrl)) {
    return telegramDownloadAndSend(bot, chatId, pdfUrl, bookName, token, originalUrl, skipMistral, searchResultTitle);
  }

  L.dlStart(pdfUrl, bookName);
  const t0 = Date.now();

  // ══════════════════════════════════════════════
  // محاولة 1: URL مباشر لـ Telegram
  // ══════════════════════════════════════════════
  // مهم: direct mode بيتخطّى pdfValidator بالكامل لأن السيرفر مش
  // بيحمّل الملف محلياً. نضيف gate قبل: لو اسم الملف ما يطابقش اسم
  // الكتاب أبداً → نسقط للـ local download (اللي بيشغّل validation
  // كامل: metaTitle + Mistral). شوف directSendUnsafe أعلاه للتفصيل.
  const directUnsafe = directSendUnsafe(bookName, pdfUrl);
  if (directUnsafe) {
    L.warn("download", "direct_send_skipped — filename has no overlap with book; using local download for full validation", {
      url: pdfUrl.slice(0, 80),
      book: bookName.slice(0, 50),
    });
    // Audit 2026-05-04 (Bug E): added telemetry counter — observability
    // gap parity with `tel:cache:opaque_url_skipped` and
    // `tel:cache:hit_revalidated_skip`. Lets ops grep how often the
    // direct-send safety gate kicks in without trawling logs.
    redis.incr("tel:dl:direct_send_skipped").catch(() => {});
  }
  if (!shouldSkipDirect(pdfUrl) && !directUnsafe) {
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
            // For direct send we don't have PDF /Title yet — Telegram
            // fetches the file itself. Pass searchResultTitle so the
            // caption can flag it when the search-result page title
            // diverges from the user's query.
            caption:    buildCaption(bookName, searchResultTitle),
            parse_mode: "HTML",
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

  // P3 (audit 2026-05-09): pre-validate the URL serves a real PDF before
  // we stream MB into temp. Previously preValidate ran only on the
  // direct-send Telegram path; if direct-send was skipped (domain in
  // SKIP list, or directUnsafe), we'd stream the entire body to disk
  // first and only then check magic bytes — which wasted bandwidth on
  // mislabelled-CT HTML interstitials and on the 191 audit hits where
  // the validator later rejected with `extract_failed`. By gating the
  // local path with the same Range:bytes=0-4 probe, HTML-as-PDF and
  // wrong-magic responses get dropped *before* download.
  //
  // Skipped when direct-send already preValidated this URL — no point
  // re-checking the same head bytes.
  const directWasPreValidated = !shouldSkipDirect(pdfUrl) && !directUnsafe;
  if (!directWasPreValidated) {
    const localPreValid = await preValidatePdfUrl(pdfUrl);
    if (!localPreValid) {
      L.warn("download", "preValidate (local path): not a PDF — skipping permanently", {
        url: pdfUrl.slice(0, 80),
      });
      redis.incr("tel:dl:local_prevalidate_rejected").catch(() => {});
      return { ok: false, permanent: true };
    }
  }

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

    // FIX (CD-filename): اسم الملف الحقيقي من HTTP `Content-Disposition` header.
    // مهم للـ hosts بتخدّم URL رقمي بحت (مثلاً Hindawi /books/62575295.pdf،
    // foulabook /book/downloading/123) لكن بترسل الاسم الفعلي في الـ header.
    // بدون ده الـ Mistral validator بيرفضها لأن الـ URL مفهوش معلومة.
    const cdFilename = parseContentDispositionFilename(r.headers.get("content-disposition"));
    if (cdFilename) {
      L.debug("download", "Got Content-Disposition filename", {
        filename: cdFilename.slice(0, 60),
        url:      pdfUrl.slice(0, 60),
      });
    }

    let totalBytes = 0;

    // ── HTML response → افحص magic bytes قبل ما نـ scrape ─
    // FIX-MISLABELED-CT: بعض الـ servers (مثلاً mktbtypdf.com/download/?id=190
    // لكتاب "شيفرة دافنشي") بيخدّموا PDF binary بـ `Content-Type: text/html`
    // غلطاناً. لو دخلنا الـ HTML-scrape branch بدون ما نتحقق من الـ magic bytes،
    // الـ %PDF binary بيتقري كـ "HTML غير قابل للقراءة" والـ download بيفشل.
    // الحل: read body مرة واحدة، فحص magic bytes، ولو %PDF نكمل عادي؛ ولو HTML
    // فعلاً نـ scrape زي ما كنا.
    if (ct.includes("html")) {
      const bodyBuf = Buffer.from(
        await r.arrayBuffer().catch(() => new ArrayBuffer(0)),
      );
      const isPdfMagic =
        bodyBuf.length >= 5 &&
        bodyBuf.subarray(0, 5).toString("ascii") === "%PDF-";

      if (isPdfMagic) {
        L.info(
          "download",
          "Server sent PDF with text/html Content-Type — proceeding as PDF",
          { url: pdfUrl.slice(0, 80), bytes: bodyBuf.length },
        );
        if (bodyBuf.length > MAX_PDF_SIZE) {
          L.dlTooLarge(pdfUrl, bodyBuf.length / 1024 / 1024);
          redis.incr("tel:dl:too_large").catch(() => {});
          return { ok: false, permanent: true, tooLarge: true };
        }
        try {
          await fsPromises.writeFile(tempPath, bodyBuf);
          totalBytes = bodyBuf.length;
        } catch (e) {
          L.dlFail(pdfUrl, `writeFile failed: ${String(e).slice(0, 80)}`);
          safeDeleteTemp(tempPath);
          await recordUrlFailure(pdfUrl);
          return { ok: false };
        }
        // fall through to magic-byte verification + validatePdfContent
      } else {
        // ── HTML فعلي → ابحث عن رابط PDF داخله ─
        if (!_noFollow) {
          try {
            const htmlPeek = bodyBuf.toString("utf8").slice(0, 6000);
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
                // Forward skipMistral + searchResultTitle so the recursive
                // call honors both the Mistral early-stop streak and the
                // new title-gate / metaTitle fallback. Without these the
                // L1/L4 fixes are bypassed for any HTML-redirect PDF.
                return downloadAndSend(bot, chatId, fullPdfUrl, bookName, token, true, skipMistral, searchResultTitle);
              }
            }
          } catch { /* HTML غير قابل للقراءة → نكمل للفشل الطبيعي */ }
        }

        L.dlFail(pdfUrl, "response is HTML not PDF");
        await recordUrlFailure(pdfUrl);
        return { ok: false };
      }
    } else {
      // ── Stream pipeline مع size limiter ──────────
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
          redis.incr("tel:dl:too_large").catch(() => {});
          return { ok: false, permanent: true, tooLarge: true };
        }
        if (String(pipeErr).includes("abort") || String(pipeErr).includes("timeout")) {
          L.dlTimeout(pdfUrl, Date.now() - t0);
        } else {
          L.dlFail(pdfUrl, String(pipeErr));
        }
        await recordUrlFailure(pdfUrl);
        return { ok: false };
      }
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

    // P3 (audit 2026-05-09): require strict %PDF- prefix at byte 0,
    // matching preValidatePdfUrl + pdfValidator.ts:934. The previous
    // permissive `includes(%PDF)` over the first 10 bytes accepted PDFs
    // with leading garbage (BOM / whitespace) — these passed download
    // but later failed extraction in the validator (counted as
    // tel:pdf:extract_failed without explanation). Strict prefix check
    // catches them at download time with a clearer reason and saves
    // wasted Mistral cycles.
    const magicHead = magic.subarray(0, 5).toString("ascii");
    if (magicHead !== "%PDF-") {
      const isHtmlBody = /<!doc|<html|<\?xml/i.test(
        magic.subarray(0, 10).toString("ascii"),
      );
      L.dlFail(pdfUrl, `bad magic at byte 0 (got "${magicHead.slice(0, 5)}", html=${isHtmlBody})`);
      if (isHtmlBody) {
        redis.incr("tel:dl:post_stream_html_rejected").catch(() => {});
      } else {
        redis.incr("tel:dl:post_stream_bad_magic_rejected").catch(() => {});
      }
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    // ── size gate (Telegram bot upload limit) ───
    {
      const tooBig = rejectIfTempTooLarge(tempPath, pdfUrl);
      if (tooBig) {
        await recordUrlFailure(pdfUrl);
        return tooBig;
      }
    }

    // ── validatePdfContent — تحقق من المحتوى ─────
    // نمرّر originalUrl (لا الـ resolved) كـ URL hint:
    // الأصل بيحتوي slug الكتاب (مثل …/book/آنا-كارنينا-pdf) المفيد لـ Mistral،
    // أما الـ resolved (مثل …/book/downloading/578333652) فمعرّف رقمي بلا معنى.
    // FIX (CD-filename): cdFilename بيغطّي الحالة اللي originalUrl نفسه ميحملش
    // slug (مثلاً Hindawi /books/62575295.pdf لـ "زقاق المدق").
    // searchResultTitle = HTML <title> from Firecrawl, used as a title-mismatch
    // gate even on trusted domains and as metaTitle fallback for hosts whose
    // /Title sits beyond the validator's 64KB scan window.
    const validation = await validatePdfContent(tempPath, bookName, originalUrl, skipMistral, cdFilename, searchResultTitle);
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
      return {
        ok: false,
        rejectedContent: true,
        // Surface to bookRequest.ts so it can count consecutive Mistral NOs
        // and short-circuit further paid calls on this query.
        mistralRejected: validation.mistralUsed,
      };
    }

    // ── اسم الملف ─────────────────────────────────
    // Use the actual book title from validation (PDF metadata or search result)
    // when it diverges meaningfully from the user query. Prevents the
    // "file labeled 'X' but contains Y" deception that the trusted-domain
    // bypass used to enable. The user query stays in the caption so the
    // user knows what they asked for.
    const fname = buildPdfFilename(bookName, validation.metaTitle);

    // ── إرسال لـ Telegram ─────────────────────────
    let sent: TelegramBot.Message;
    let uploadTimerId: ReturnType<typeof setTimeout> | null = null;
    // مجرد الإشارة للـ sendDocument promise عشان لو غلب الـ timeout (فاز بالـ
    // race) وبعدين الـ sendDocument فشل لاحقاً، نمسك الـ rejection بدل ما تتحول
    // لـ unhandled-rejection warning في الـ logs.
    const sendDocPromise = bot.sendDocument(
      chatId,
      tempPath,
      {
        caption:    buildCaption(bookName, validation.metaTitle),
        parse_mode: "HTML",
      },
      { filename: fname, contentType: "application/pdf" },
    ) as Promise<TelegramBot.Message>;
    try {
      sent = await Promise.race([
        sendDocPromise,
        new Promise<never>((_, rej) => {
          uploadTimerId = setTimeout(
            () => rej(new Error("UPLOAD_TIMEOUT")),
            TIMEOUT_UPLOAD
          );
        }),
      ]);
    } catch (raceErr) {
      // خسرنا الـ race (غالباً timeout). لو الـ sendDocument رفض لاحقاً،
      // نمسكه بصمت (لو Telegram تأخر ورجع error بعد ما دعشناه تايماوت).
      sendDocPromise.catch((lateErr) => {
        L.debug("download", "sendDocument late-rejection (race already lost)", {
          err: String(lateErr).slice(0, 100),
        });
      });
      throw raceErr;
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
    } else if (isTelegramUploadSizeError(e)) {
      safeDeleteTemp(tempPath);
      L.dlTooLarge(pdfUrl, 0); // totalBytes not in catch scope
      redis.incr("tel:dl:too_large").catch(() => {});
      await recordUrlFailure(pdfUrl);
      return { ok: false, permanent: true, tooLarge: true };
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

// ══════════════════════════════════════════════
// WELIB SPECIAL FLOW
// downloadWelibPdf بتفتح headless chromium، تبوتستراب الـ cf_clearance
// عبر GET /، تروح لـ /slow_download/{md5}/0/0/convert، تستنّى ظهور anchor
// على welib-public.org، ثم تحمّل الـ signed URL بـ fetch عادي (الـ CDN مفيش
// عليه CF). بعد ما الـ PDF موجود محلياً، نكمل بنفس validate + send.
// ══════════════════════════════════════════════
async function welibDownloadAndSend(
  bot:               TelegramBot,
  chatId:            number,
  pdfUrl:            string,
  bookName:          string,
  _token:            string,
  originalUrl:       string,
  skipMistral        = false,
  searchResultTitle  = "",
): Promise<DownloadResult> {
  L.dlStart(pdfUrl, bookName);
  const t0 = Date.now();

  ensureTempDir();
  const tempPath = path.join(
    TEMP_DIR,
    `${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`,
  );

  const result = await downloadWelibPdf(pdfUrl, tempPath);
  if (!result.ok) {
    L.dlFail(pdfUrl, `welib: ${result.error?.slice(0, 80) ?? "unknown"}`);
    safeDeleteTemp(tempPath);
    await recordUrlFailure(pdfUrl);
    return { ok: false };
  }

  // ── magic bytes ──────────────────────────────
  // لو welib's /convert رجّع حاجة مفهاش PDF magic (مثلاً epub غير معدّل)
  // بنرفضه بدل ما نبعت للمستخدم ملف على إنه PDF وهو لأ.
  try {
    if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size < 1024) {
      L.dlFail(pdfUrl, "welib: temp file too small or missing");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    const magicBuf = Buffer.alloc(10);
    const fh = await fsPromises.open(tempPath, "r");
    try {
      await fh.read(magicBuf, 0, 10, 0);
    } finally {
      await fh.close();
    }

    if (!magicBuf.includes(Buffer.from("%PDF"))) {
      L.dlFail(pdfUrl, "welib: no PDF signature in file");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }
  } catch (e: any) {
    L.dlFail(pdfUrl, `welib: magic check failed: ${String(e).slice(0, 80)}`);
    safeDeleteTemp(tempPath);
    await recordUrlFailure(pdfUrl);
    return { ok: false };
  }

  // ── size gate ────────────────────────────────
  {
    const tooBig = rejectIfTempTooLarge(tempPath, pdfUrl);
    if (tooBig) {
      await recordUrlFailure(pdfUrl);
      return tooBig;
    }
  }

  // ── content validation ───────────────────────
  // originalUrl (e.g. /md5/{hash}) بيدخل لـ Mistral كـ URL hint — الـ md5 فيه
  // مفيش slug للكتاب، لكن الـ metaTitle من PDF بيكون عربي وصحيح.
  const validation = await validatePdfContent(
    tempPath, bookName, originalUrl, skipMistral, "", searchResultTitle,
  );
  if (!validation.accepted) {
    L.warn("download", "welib PDF rejected — content mismatch", {
      book:      bookName.slice(0, 50),
      url:       pdfUrl.slice(0, 80),
      score:     validation.score.toFixed(2),
      metaTitle: validation.metaTitle.slice(0, 60) || "(empty)",
      event:     validation.event,
      mistral:   validation.mistralUsed,
    });
    safeDeleteTemp(tempPath);
    return {
      ok: false,
      rejectedContent: true,
      mistralRejected: validation.mistralUsed,
    };
  }

  // ── sendDocument ─────────────────────────────
  const fname = buildPdfFilename(bookName, validation.metaTitle);
  const sizeBytes = result.sizeBytes ?? fs.statSync(tempPath).size;

  let sent: TelegramBot.Message;
  let uploadTimerId: ReturnType<typeof setTimeout> | null = null;
  const sendDocPromise = bot.sendDocument(
    chatId,
    tempPath,
    {
      caption:    buildCaption(bookName, validation.metaTitle),
      parse_mode: "HTML",
    },
    { filename: fname, contentType: "application/pdf" },
  ) as Promise<TelegramBot.Message>;
  try {
    sent = await Promise.race([
      sendDocPromise,
      new Promise<never>((_, rej) => {
        uploadTimerId = setTimeout(
          () => rej(new Error("UPLOAD_TIMEOUT")),
          TIMEOUT_UPLOAD,
        );
      }),
    ]);
  } catch (e: any) {
    sendDocPromise.catch((lateErr) => {
      L.debug("download", "welib sendDocument late-rejection (race already lost)", {
        err: String(lateErr).slice(0, 100),
      });
    });
    safeDeleteTemp(tempPath);
    L.dlFail(pdfUrl, `welib upload: ${String(e?.message || e).slice(0, 80)}`);
    await recordUrlFailure(pdfUrl);
    if (isTelegramUploadSizeError(e)) {
      redis.incr("tel:dl:too_large").catch(() => {});
      return { ok: false, permanent: true, tooLarge: true };
    }
    return { ok: false };
  } finally {
    if (uploadTimerId !== null) clearTimeout(uploadTimerId);
    safeDeleteTemp(tempPath);
  }

  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  L.dlLocal(bookName, sizeMB, Date.now() - t0);
  await recordUrlSuccess(pdfUrl);

  return {
    ok:       true,
    fileId:   sent.document?.file_id,
    sizeMB,
    sendMode: "local",
  };
}

// ══════════════════════════════════════════════
// NOOR-BOOK SPECIAL FLOW
// downloadNoorBookPdf بتشغّل headless chromium، تتعدّى CF،
// تستخرج /book/internal_download URL وتمسك ملف الـ PDF.
// بعد ما الـ PDF موجود محلياً، نكمل بنفس validate + send.
// ══════════════════════════════════════════════
async function noorBookDownloadAndSend(
  bot:               TelegramBot,
  chatId:            number,
  pdfUrl:            string,
  bookName:          string,
  _token:            string,
  originalUrl:       string,
  skipMistral        = false,
  searchResultTitle  = "",
): Promise<DownloadResult> {
  L.dlStart(pdfUrl, bookName);
  const t0 = Date.now();

  ensureTempDir();
  const tempPath = path.join(
    TEMP_DIR,
    `${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`,
  );

  const result = await downloadNoorBookPdf(pdfUrl, tempPath);
  if (!result.ok) {
    L.dlFail(pdfUrl, `noor-book: ${result.error?.slice(0, 80) ?? "unknown"}`);
    safeDeleteTemp(tempPath);
    await recordUrlFailure(pdfUrl);
    return { ok: false };
  }

  // ── magic bytes ──────────────────────────────
  try {
    if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size < 1024) {
      L.dlFail(pdfUrl, "noor-book: temp file too small or missing");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    const magicBuf = Buffer.alloc(10);
    const fh = await fsPromises.open(tempPath, "r");
    try {
      await fh.read(magicBuf, 0, 10, 0);
    } finally {
      await fh.close();
    }

    if (!magicBuf.includes(Buffer.from("%PDF"))) {
      L.dlFail(pdfUrl, "noor-book: no PDF signature in file");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }
  } catch (e: any) {
    L.dlFail(pdfUrl, `noor-book: magic check failed: ${String(e).slice(0, 80)}`);
    safeDeleteTemp(tempPath);
    await recordUrlFailure(pdfUrl);
    return { ok: false };
  }

  // ── content validation ───────────────────────
  // originalUrl فيه slug الكتاب — مفيد لـ Mistral
  // ── size gate ────────────────────────────────
  {
    const tooBig = rejectIfTempTooLarge(tempPath, pdfUrl);
    if (tooBig) {
      await recordUrlFailure(pdfUrl);
      return tooBig;
    }
  }

  const validation = await validatePdfContent(tempPath, bookName, originalUrl, skipMistral, "", searchResultTitle);
  if (!validation.accepted) {
    L.warn("download", "noor-book PDF rejected — content mismatch", {
      book:      bookName.slice(0, 50),
      url:       pdfUrl.slice(0, 80),
      score:     validation.score.toFixed(2),
      metaTitle: validation.metaTitle.slice(0, 60) || "(empty)",
      event:     validation.event,
      mistral:   validation.mistralUsed,
    });
    safeDeleteTemp(tempPath);
    return {
      ok: false,
      rejectedContent: true,
      mistralRejected: validation.mistralUsed,
    };
  }

  // ── sendDocument ─────────────────────────────
  const fname = buildPdfFilename(bookName, validation.metaTitle);
  const sizeBytes = result.sizeBytes ?? fs.statSync(tempPath).size;

  let sent: TelegramBot.Message;
  let uploadTimerId: ReturnType<typeof setTimeout> | null = null;
  // توثيق الـ sendDocument promise بشكل منفصل عشان نمسك late-rejection لو
  // غلب الـ timeout في الـ race وبعدين Telegram رفض بعدوا.
  const sendDocPromise = bot.sendDocument(
    chatId,
    tempPath,
    {
      caption:    buildCaption(bookName, validation.metaTitle),
      parse_mode: "HTML",
    },
    { filename: fname, contentType: "application/pdf" },
  ) as Promise<TelegramBot.Message>;
  try {
    sent = await Promise.race([
      sendDocPromise,
      new Promise<never>((_, rej) => {
        uploadTimerId = setTimeout(
          () => rej(new Error("UPLOAD_TIMEOUT")),
          TIMEOUT_UPLOAD,
        );
      }),
    ]);
  } catch (e: any) {
    sendDocPromise.catch((lateErr) => {
      L.debug("download", "noor-book sendDocument late-rejection (race already lost)", {
        err: String(lateErr).slice(0, 100),
      });
    });
    safeDeleteTemp(tempPath);
    L.dlFail(pdfUrl, `noor-book upload: ${String(e?.message || e).slice(0, 80)}`);
    await recordUrlFailure(pdfUrl);
    if (isTelegramUploadSizeError(e)) {
      redis.incr("tel:dl:too_large").catch(() => {});
      return { ok: false, permanent: true, tooLarge: true };
    }
    return { ok: false };
  } finally {
    if (uploadTimerId !== null) clearTimeout(uploadTimerId);
    safeDeleteTemp(tempPath);
  }

  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  L.dlLocal(bookName, sizeMB, Date.now() - t0);
  await recordUrlSuccess(pdfUrl);

  return {
    ok:       true,
    fileId:   sent.document?.file_id,
    sizeMB,
    sendMode: "local",
  };
}

// ══════════════════════════════════════════════
// TELEGRAM CHANNELS FALLBACK FLOW
// pdfUrl is a synthetic `tg://msg/<channelId>/<msgId>` or
// `https://t.me/<username>/<msgId>` produced by telegramFallback.
// searchTelegramChannels (the 3rd parallel leg in engine.searchAllSources).
// downloadTelegramFile uses the persistent gramjs userbot session to
// pull the document straight from Telegram's CDN to a local tempfile,
// then we run the same pdfValidator + sendDocument flow as welib/noor.
// ══════════════════════════════════════════════
async function telegramDownloadAndSend(
  bot:               TelegramBot,
  chatId:            number,
  pdfUrl:            string,
  bookName:          string,
  _token:            string,
  originalUrl:       string,
  skipMistral        = false,
  searchResultTitle  = "",
): Promise<DownloadResult> {
  L.dlStart(pdfUrl, bookName);
  const t0 = Date.now();

  const parsed = parseTelegramUrl(pdfUrl);
  if (!parsed) {
    L.dlFail(pdfUrl, "telegram: could not parse channel/msgId from URL");
    await recordUrlFailure(pdfUrl);
    return { ok: false };
  }

  ensureTempDir();
  const tempPath = path.join(
    TEMP_DIR,
    `${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`,
  );

  const result = await downloadTelegramFile(parsed.channelRef, parsed.msgId, tempPath);
  if (!result.ok) {
    const errMsg = result.error?.slice(0, 80) ?? "unknown";
    L.dlFail(pdfUrl, `telegram: ${errMsg}`);
    safeDeleteTemp(tempPath);
    await recordUrlFailure(pdfUrl);
    if (errMsg.startsWith("too_large") || isTelegramUploadSizeError(errMsg)) {
      redis.incr("tel:dl:too_large").catch(() => {});
      return { ok: false, permanent: true, tooLarge: true };
    }
    return { ok: false };
  }

  // Post-download size gate (declared size may be missing on some peers)
  {
    const tooBig = rejectIfTempTooLarge(tempPath, pdfUrl);
    if (tooBig) {
      await recordUrlFailure(pdfUrl);
      return tooBig;
    }
  }

  // ── magic bytes ──────────────────────────────
  // Telegram allows uploading anything with .pdf extension — we still
  // verify the magic header just like welib/noor paths to defend
  // against renamed-epub or HTML-as-PDF tricks.
  try {
    if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size < 1024) {
      L.dlFail(pdfUrl, "telegram: temp file too small or missing");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }

    const magicBuf = Buffer.alloc(10);
    const fh = await fsPromises.open(tempPath, "r");
    try {
      await fh.read(magicBuf, 0, 10, 0);
    } finally {
      await fh.close();
    }

    if (!magicBuf.includes(Buffer.from("%PDF"))) {
      L.dlFail(pdfUrl, "telegram: no PDF signature in file");
      safeDeleteTemp(tempPath);
      await recordUrlFailure(pdfUrl);
      return { ok: false };
    }
  } catch (e: any) {
    L.dlFail(pdfUrl, `telegram: magic check failed: ${String(e).slice(0, 80)}`);
    safeDeleteTemp(tempPath);
    await recordUrlFailure(pdfUrl);
    return { ok: false };
  }

  // ── content validation ───────────────────────
  // searchResultTitle is the Telegram filename (from
  // telegramResultToBookResult) — pass it through so pdfValidator's
  // title-gate has the strongest signal available.
  const validation = await validatePdfContent(
    tempPath, bookName, originalUrl, skipMistral, "", searchResultTitle,
  );
  if (!validation.accepted) {
    L.warn("download", "telegram PDF rejected — content mismatch", {
      book:      bookName.slice(0, 50),
      url:       pdfUrl.slice(0, 80),
      score:     validation.score.toFixed(2),
      metaTitle: validation.metaTitle.slice(0, 60) || "(empty)",
      event:     validation.event,
      mistral:   validation.mistralUsed,
    });
    safeDeleteTemp(tempPath);
    return {
      ok: false,
      rejectedContent: true,
      mistralRejected: validation.mistralUsed,
    };
  }

  // ── sendDocument ─────────────────────────────
  const fname = buildPdfFilename(bookName, validation.metaTitle);
  const sizeBytes = result.size ?? fs.statSync(tempPath).size;

  let sent: TelegramBot.Message;
  let uploadTimerId: ReturnType<typeof setTimeout> | null = null;
  const sendDocPromise = bot.sendDocument(
    chatId,
    tempPath,
    {
      caption:    buildCaption(bookName, validation.metaTitle),
      parse_mode: "HTML",
    },
    { filename: fname, contentType: "application/pdf" },
  ) as Promise<TelegramBot.Message>;
  try {
    sent = await Promise.race([
      sendDocPromise,
      new Promise<never>((_, rej) => {
        uploadTimerId = setTimeout(
          () => rej(new Error("UPLOAD_TIMEOUT")),
          TIMEOUT_UPLOAD,
        );
      }),
    ]);
  } catch (e: any) {
    sendDocPromise.catch((lateErr) => {
      L.debug("download", "telegram sendDocument late-rejection (race already lost)", {
        err: String(lateErr).slice(0, 100),
      });
    });
    safeDeleteTemp(tempPath);
    L.dlFail(pdfUrl, `telegram upload: ${String(e?.message || e).slice(0, 80)}`);
    await recordUrlFailure(pdfUrl);
    if (isTelegramUploadSizeError(e)) {
      redis.incr("tel:dl:too_large").catch(() => {});
      return { ok: false, permanent: true, tooLarge: true };
    }
    return { ok: false };
  } finally {
    if (uploadTimerId !== null) clearTimeout(uploadTimerId);
    safeDeleteTemp(tempPath);
  }

  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  L.dlLocal(bookName, sizeMB, Date.now() - t0);
  await recordUrlSuccess(pdfUrl);

  return {
    ok:       true,
    fileId:   sent.document?.file_id,
    sizeMB,
    sendMode: "local",
  };
}
