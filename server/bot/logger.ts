import * as fs from "fs";
import * as path from "path";

// ══════════════════════════════════════════════
// LOGGER — نظام تسجيل منظّم ومتعدد المستويات
//
// المستويات: DEBUG → INFO → WARN → ERROR
// الفئات:   search | download | verify | queue | worker | cache | admin | bot
// المخرج:   console (ملوّن) + log file (اختياري)
// ══════════════════════════════════════════════

export type LogLevel    = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogCategory = "search" | "download" | "verify" | "queue" | "worker"
                        | "cache"  | "admin"    | "bot"    | "rate"  | "system"
                        | "analytics" | "trace" | "alerts" | "server" | "engine" | "firecrawl" | "pdfValidator"
                        // BUG-E FIX: كانت "bookNameParser" و"weekly" مستخدمتَين في ملفاتهما
                        // لكن غير موجودتَين في هذا الـ type → TypeScript error + EMOJI[cat]=undefined
                        // → جميع سجلات هذين الملفَين تظهر "undefined" كـ emoji بدل أيقونة حقيقية
                        | "bookNameParser" | "weekly";

interface LogEntry {
  ts:       string;
  level:    LogLevel;
  category: LogCategory;
  msg:      string;
  meta?:    Record<string, unknown>;
}

// ── الألوان في Terminal ───────────────────────
const COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[90m",   // رمادي
  INFO:  "\x1b[36m",   // سماوي
  WARN:  "\x1b[33m",   // أصفر
  ERROR: "\x1b[31m",   // أحمر
};
const RESET = "\x1b[0m";
const DIM   = "\x1b[2m";
const BOLD  = "\x1b[1m";

const EMOJI: Record<LogCategory, string> = {
  search:    "🔍",
  download:  "📥",
  verify:    "✔️ ",
  queue:     "📋",
  worker:    "⚙️ ",
  cache:     "⚡",
  admin:     "🛠️ ",
  bot:       "🤖",
  rate:      "🛡️ ",
  system:    "💻",
  analytics: "📊",
  trace:     "🔬",
  alerts:    "🚨",
  server:    "🌐",
  engine:    "⚙️",
  firecrawl:    "🔥",
  pdfValidator: "🔏",
  // BUG-E FIX: أيقونات الفئتَين المضافتَين
  bookNameParser: "📝",
  weekly:         "📅",
};

// ── Config ────────────────────────────────────
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "INFO";
const LOG_FILE  = process.env.LOG_FILE || "";      // مسار الملف (اختياري)
const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let logStream: fs.WriteStream | null = null;
if (LOG_FILE) {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
}

// ── Core ──────────────────────────────────────

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  const parts = Object.entries(meta).map(([k, v]) => {
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    return `${DIM}${k}=${RESET}${val}`;
  });
  return `  ${parts.join("  ")}`;
}

export function logger(
  level:    LogLevel,
  category: LogCategory,
  msg:      string,
  meta?:    Record<string, unknown>
): void {
  if (!shouldLog(level)) return;

  const now     = new Date();
  const ts      = now.toISOString().replace("T", " ").slice(0, 23);
  const color   = COLORS[level];
  const emoji   = EMOJI[category];

  // Console output
  const line = `${DIM}${ts}${RESET} ${color}${BOLD}${level.padEnd(5)}${RESET} ${emoji} ${BOLD}[${category}]${RESET} ${msg}${formatMeta(meta)}`;
  console.log(line);

  // File output (JSON lines for parsing)
  if (logStream) {
    const entry: LogEntry = { ts, level, category, msg, ...(meta ? { meta } : {}) };
    logStream.write(JSON.stringify(entry) + "\n");
  }
}

// ── Graceful close ────────────────────────────
/** يُستدعى عند الـ shutdown لإغلاق الملف وتفريغ الـ buffer */
export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

export const L = {
  debug: (cat: LogCategory, msg: string, meta?: Record<string, unknown>) => logger("DEBUG", cat, msg, meta),
  info:  (cat: LogCategory, msg: string, meta?: Record<string, unknown>) => logger("INFO",  cat, msg, meta),
  warn:  (cat: LogCategory, msg: string, meta?: Record<string, unknown>) => logger("WARN",  cat, msg, meta),
  error: (cat: LogCategory, msg: string, meta?: Record<string, unknown>) => logger("ERROR", cat, msg, meta),

  // ── دوال سريعة لكل حدث مهم ──────────────────

  searchStart:    (book: string, userId: string) =>
    logger("INFO",  "search",   `Started`,            { book: book.slice(0, 60), userId }),

  searchDone:     (book: string, count: number, ms: number, wave2Used: boolean) =>
    logger("INFO",  "search",   `Finished`,           { results: count, ms, wave2: wave2Used }),

  searchFail:     (book: string, err: string) =>
    logger("WARN",  "search",   `No results`,         { book: book.slice(0, 60), err: err.slice(0, 100) }),

  searchTimeout:  (book: string, ms: number) =>
    logger("WARN",  "search",   `Timeout`,            { book: book.slice(0, 60), afterMs: ms }),

  sourceOk:       (domain: string, count: number, ms: number) =>
    logger("DEBUG", "search",   `Source OK`,          { domain, results: count, ms }),

  sourceFail:     (domain: string, err: string) =>
    logger("WARN",  "search",   `Source failed`,      { domain, err: err.slice(0, 80) }),

  dlStart:        (url: string, book: string) =>
    logger("INFO",  "download", `Started`,            { url: url.slice(0, 80), book: book.slice(0, 50) }),

  dlDirect:       (book: string, sizeMB: string) =>
    logger("INFO",  "download", `Sent via Telegram`,  { book: book.slice(0, 50), sizeMB }),

  dlLocal:        (book: string, sizeMB: string, ms: number) =>
    logger("INFO",  "download", `Sent via local`,     { book: book.slice(0, 50), sizeMB, ms }),

  dlFail:         (url: string, reason: string) =>
    logger("WARN",  "download", `Failed`,             { url: url.slice(0, 80), reason: reason.slice(0, 100) }),

  dlTooLarge:     (url: string, sizeMB: number) =>
    logger("WARN",  "download", `File too large`,     { url: url.slice(0, 80), sizeMB: sizeMB.toFixed(1) }),

  dlTimeout:      (url: string, ms: number) =>
    logger("WARN",  "download", `Timeout`,            { url: url.slice(0, 80), afterMs: ms }),

  verifyStart:    (url: string) =>
    logger("DEBUG", "verify",   `Checking`,           { url: url.slice(0, 80) }),

  verifyOk:       (url: string, sizeMB?: number) =>
    logger("DEBUG", "verify",   `Valid PDF`,          { url: url.slice(0, 80), sizeMB }),

  verifyFail:     (url: string, reason: string) =>
    logger("DEBUG", "verify",   `Invalid`,            { url: url.slice(0, 80), reason }),

  verifyTimeout:  (url: string) =>
    logger("WARN",  "verify",   `Timeout`,            { url: url.slice(0, 80) }),

  queueEnqueue:   (jobId: string, userId: string, book: string, priority: string, pos: number) =>
    logger("INFO",  "queue",    `Enqueued`,           { jobId: jobId.slice(0, 8), userId, book: book.slice(0, 50), priority, pos }),

  queueDequeue:   (jobId: string, priority: string) =>
    logger("DEBUG", "queue",    `Dequeued`,           { jobId: jobId.slice(0, 8), priority }),

  // BUG-A FIX: كانت موجودة في worker.ts لكن مش موجودة في logger.ts
  // → TypeError: L.queueProcess is not a function عند معالجة كل job
  // → البوت يقبل الطلب ويـ crash قبل ما يعالجه → "يُعالَج الآن" وخلاص بدون نتيجة
  queueProcess:   (jobId: string, userId: string, book: string) =>
    logger("INFO",  "queue",    `Processing`,         { jobId: jobId.slice(0, 8), userId, book: book.slice(0, 50) }),

  // BUG-C FIX: كانت موجودة في worker.ts لكن مش موجودة في logger.ts
  // → بعد كل job ناجح: completeJob() ينجح، L.queueDone() يـ crash بـ TypeError
  // → catch block يُشغّل failJob() → يُعيد الـ job للطابور
  // → المستخدم يتلقى الكتاب مرتين أو ثلاث حتى QUEUE_MAX_RETRIES!
  queueDone:      (jobId: string, userId: string, book: string) =>
    logger("INFO",  "queue",    `Done ✅`,             { jobId: jobId.slice(0, 8), userId, book: book.slice(0, 50) }),

  queueRetry:     (jobId: string, attempt: number, max: number) =>
    logger("WARN",  "queue",    `Retry`,              { jobId: jobId.slice(0, 8), attempt, max }),

  queueDLQ:       (jobId: string, reason: string) =>
    logger("ERROR", "queue",    `→ DLQ`,              { jobId: jobId.slice(0, 8), reason: reason.slice(0, 100) }),

  queueTimeout:   (jobId: string, userId: string, book: string) =>
    logger("WARN",  "queue",    `Job timeout`,        { jobId: jobId.slice(0, 8), userId, book: book.slice(0, 50) }),

  workerStart:    (id: string) =>
    logger("INFO",  "worker",   `Started`,            { workerId: id }),

  workerIdle:     (id: string) =>
    logger("DEBUG", "worker",   `Idle (no jobs)`,     { workerId: id }),

  workerJobStart: (id: string, jobId: string, book: string) =>
    logger("INFO",  "worker",   `Processing job`,     { workerId: id, jobId: jobId.slice(0, 8), book: book.slice(0, 50) }),

  workerJobDone:  (id: string, jobId: string, ms: number) =>
    logger("INFO",  "worker",   `Job completed ✅`,   { workerId: id, jobId: jobId.slice(0, 8), ms }),

  workerJobFail:  (id: string, jobId: string, err: string) =>
    logger("ERROR", "worker",   `Job failed`,         { workerId: id, jobId: jobId.slice(0, 8), err: err.slice(0, 100) }),

  cacheHit:       (key: string) =>
    logger("DEBUG", "cache",    `Hit`,                { key: key.slice(0, 60) }),

  cacheMiss:      (key: string) =>
    logger("DEBUG", "cache",    `Miss`,               { key: key.slice(0, 60) }),

  cacheSet:       (key: string, ttl: number) =>
    logger("DEBUG", "cache",    `Stored`,             { key: key.slice(0, 60), ttlSec: ttl }),

  rateLimit:      (userId: string) =>
    logger("WARN",  "rate",     `Rate limited`,       { userId }),

  rateLimitSearch:(userId: string) =>
    logger("WARN",  "rate",     `Search rate limited`,{ userId }),

  blacklist:      (url: string, fails: number) =>
    logger("WARN",  "system",   `URL blacklisted`,    { url: url.slice(0, 80), fails }),

  tempClean:      (count: number, totalMB: number) =>
    logger("INFO",  "system",   `Temp cleanup`,       { deleted: count, freedMB: totalMB.toFixed(1) }),

  adminAction:    (userId: string, action: string) =>
    logger("INFO",  "admin",    `Action`,             { userId, action }),

  botStart:       (username: string, workers: number, sources: number) =>
    logger("INFO",  "bot",      `Started ✅`,          { username: `@${username}`, workers, sources }),

  botError:       (err: string) =>
    logger("ERROR", "bot",      `Polling error`,      { err: err.slice(0, 200) }),
};
