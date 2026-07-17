// ══════════════════════════════════════════════
// LOGGER — رفيق
// ══════════════════════════════════════════════

import { pushLog } from "./logBuffer.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const IS_PROD = process.env.NODE_ENV === "production";

function log(level: LogLevel, ns: string, msg: string, meta?: Record<string, unknown>): void {
  if (level === "debug" && IS_PROD) return;
  const ts   = new Date().toISOString();
  const line = meta
    ? `[${ts}] [${level.toUpperCase()}] [${ns}] ${msg} ${JSON.stringify(meta)}`
    : `[${ts}] [${level.toUpperCase()}] [${ns}] ${msg}`;
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
  // FEAT-DASH: نسخة في الذاكرة للـ dashboard log viewer
  pushLog(level.toUpperCase() as "DEBUG" | "INFO" | "WARN" | "ERROR", ns, msg, meta);
}

export const L = {
  debug:       (ns: string, msg: string, meta?: Record<string, unknown>) => log("debug", ns, msg, meta),
  info:        (ns: string, msg: string, meta?: Record<string, unknown>) => log("info",  ns, msg, meta),
  warn:        (ns: string, msg: string, meta?: Record<string, unknown>) => log("warn",  ns, msg, meta),
  error:       (ns: string, msg: string, meta?: Record<string, unknown>) => log("error", ns, msg, meta),

  // ── Convenience helpers ───────────────────────
  dlStart:   (url: string, book: string)            => log("info",  "download", `⬇️  Starting`, { url: url.slice(0,80), book: book.slice(0,50) }),
  dlDirect:  (book: string, size: string)           => log("info",  "download", `✅ Direct send`, { book: book.slice(0,50), size }),
  dlLocal:   (book: string, size: string, ms: number) => log("info","download", `✅ Local send`, { book: book.slice(0,50), size, ms }),
  dlFail:    (url: string, reason: string)          => log("warn",  "download", `❌ Failed`, { url: url.slice(0,80), reason: reason.slice(0,120) }),
  dlTimeout: (url: string, ms: number)              => log("warn",  "download", `⏱️  Timeout`, { url: url.slice(0,80), ms }),
  dlTooLarge:(url: string, mb: number)              => log("warn",  "download", `📦 Too large`, { url: url.slice(0,80), mb }),

  adminAction: (who: string, action: string) => log("info", "admin", `🔧 ${action}`, { who }),

  queueProcess: (jobId: string, userId: string, book: string) =>
    log("info", "worker", `⏳ Job ${jobId} processing`, { userId, book: book.slice(0, 50) }),
  queueDone:    (jobId: string, userId: string, book: string) =>
    log("info", "worker", `✅ Job ${jobId} done`,        { userId, book: book.slice(0, 50) }),
};
