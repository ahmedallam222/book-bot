// ══════════════════════════════════════════════
// CONFIG — خلاصة الكتب
// ══════════════════════════════════════════════

// ── Redis keys ────────────────────────────────
export const MAINTENANCE_KEY          = "flag:maintenance";
export const BOT_ANNOUNCE_KEY         = "bot:announce";
export const PREMIUM_SET_KEY          = "premium:users";
export const FC_QUOTA_EXCEEDED_KEY    = "fc:quota_exceeded";
export const FC_RATE_LIMITED_KEY      = "fc:rate_limited";

// ── Limits ────────────────────────────────────
export const DAILY_LIMIT              = 3;   // FIX: غُيّر من 5 → 3
export const PREMIUM_LIMIT            = 15;  // FIX: غُيّر من 30 → 15 ليتطابق مع رسالة /premium
export const MAX_BOOK_NAME_LEN        = 200;
export const MAX_PDF_SIZE             = 50 * 1024 * 1024; // 50 MB
// FIX-PREFILTER: حد أدنى لطول الاستعلام — أقل من 3 أحرف لا يستحق Firecrawl call
export const MIN_QUERY_LENGTH         = 3;

// ── Timeouts (ms) ─────────────────────────────
export const TIMEOUT_DOWNLOAD         = 90_000;
export const TIMEOUT_TELEGRAM         = 30_000;
export const TIMEOUT_UPLOAD           = 120_000;
export const TIMEOUT_FC_SEARCH        = 30_000;
export const TIMEOUT_FC_SCRAPE        = 20_000;
export const TIMEOUT_MISTRAL          = 15_000;

// ── Cache TTLs (ms) ───────────────────────────
export const SEARCH_CACHE_TTL_HIT     = 3_600_000;  // 1 hour
export const SEARCH_CACHE_TTL_MISS    = 300_000;    // 5 minutes

// ── Rate limits ───────────────────────────────
export const FC_RATE_LIMITED_TTL_SEC  = 60;
export const FC_QUOTA_TTL_SEC         = 86_400;     // 24h

// ── PDF Validation thresholds ─────────────────
export const PDF_VALIDATE_ACCEPT_THRESHOLD = 0.40;
export const PDF_VALIDATE_REJECT_THRESHOLD = 0.12;

// ── Blacklist ─────────────────────────────────
export const BLACKLIST_THRESHOLD      = 3;

// ── Filesystem ────────────────────────────────

// ── HTTP ──────────────────────────────────────
// FIX v29: تحديث UA لـ Chrome 124 — بعض المواقع ترفض Chrome القديم
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Admin IDs ─────────────────────────────────
const _envAdminIds = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => /^\d{5,15}$/.test(s));

export const ADMIN_IDS = new Set<string>([
  "5469997406",
  ..._envAdminIds.filter((id) => id !== "5469997406"),
]);

// ── Banned users (env, fast-path) ────────────
export const BANNED_USERS = new Set<string>(
  (process.env.BANNED_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// ── Mistral API key ───────────────────────────
export const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";

// ── Unreliable domains ────────────────────────
// FIX-RUNTIME: أضفنا دعم UNRELIABLE_DOMAINS_EXTRA في .env
export const UNRELIABLE_DOMAINS: string[] = [
  "archive.org",
  "ia800",
  "noor-book.com",
  "makalatt.com",
  "islamhouse.com",
  ...(process.env.UNRELIABLE_DOMAINS_EXTRA || "")
    .split(",")
    .map(d => d.trim())
    .filter(Boolean),
];

export const SOURCE_AUTO_DISABLE_MIN_ATTEMPTS = parseInt(
  process.env.SOURCE_AUTO_DISABLE_MIN_ATTEMPTS || "8",
  10,
);
export const SOURCE_AUTO_DISABLE_MAX_RATE = parseFloat(
  process.env.SOURCE_AUTO_DISABLE_MAX_RATE || "0.15",
);

// ── Trusted PDF domains ───────────────────────
// Aggregators / mirrors. Anything served from these download/dl paths
// is assumed to be the requested book — we skip Mistral entirely.
// (libgen-class hosts only resolve the requested ID to a binary, so a
// content mismatch would imply a deliberately-wrong upload, not a
// search-ranker mistake.)
export const TRUSTED_PDF_DOMAINS: string[] = [
  "dl.waqfeya.net",
  "books-library.net",
  "1lib.sk",
  "libgen.is",
  "libgen.rs",
  "libgen.st",
  "library.lol",
  "z-lib.org",
];

// ── Filename-trusted PDF domains ──────────────
// Curated content libraries that reliably serve real PDFs but host
// many unrelated books too (so a search ranker mistake is plausible).
// We trust filename match as ground truth on these and skip Mistral
// only when urlFilenameRelevance(bookName, pdfUrl) is high enough —
// see MISTRAL_BYPASS_FILENAME_THRESHOLD below.
//
// Selection criteria (post-deploy of #14, observed on prod):
//   - 100% historical success rate over 10+ deliveries, AND
//   - filenames carry the book title (not opaque numeric IDs only).
// Sources whose filenames are pure numeric IDs (e.g. archive.org
// item paths like /details/20200914_20200914_0831) won't pass the
// filename threshold anyway — urlFilenameRelevance returns 0.3 for
// those, below the 0.5 default — so they fall through to Mistral.
export const FILENAME_TRUSTED_PDF_DOMAINS: string[] = [
  "archive.org",
  "bookleaks.com",
  "book-shadow.com",
];

// Above this filename-relevance score, a FILENAME_TRUSTED domain
// short-circuits the Mistral call. 0.5 means "≥ half of the book's
// content words appear in the filename" — strong evidence the source
// indexed the right title.
export const MISTRAL_BYPASS_FILENAME_THRESHOLD = parseFloat(
  process.env.MISTRAL_BYPASS_FILENAME_THRESHOLD || "0.5",
);

// ── Viewer-only domains — لا PDF قابل للتحميل منها أبداً ──
// هذه منصات عرض فقط — المحاولة معها دائماً تفشل وتهدر 90 ثانية لكل رابط
// يُصفَّر هذه الروابط في verify.ts قبل حلقة التحميل
export const VIEWER_ONLY_DOMAINS: string[] = [
  "fliphtml5.com",     // عارض HTML5 — لا تحميل
  "scribd.com",        // يتطلب حساب مدفوع
  "issuu.com",         // عارض مجلات — لا تحميل
  "calameo.com",       // عارض وثائق — لا تحميل
  "yumpu.com",         // عارض مجلات — لا تحميل
  "slideshare.net",    // عارض شرائح — لا تحميل مباشر
  "heyzine.com",       // عارض PDF — لا تحميل مباشر
  "pubhtml5.com",      // عارض HTML5 — لا تحميل
  "online.anyflip.com", // عارض flash — لا تحميل
  // domains إضافية من .env بدون إعادة deploy
  ...(process.env.VIEWER_ONLY_DOMAINS_EXTRA || "")
    .split(",")
    .map(d => d.trim())
    .filter(Boolean),
];

// ── Group trigger words ───────────────────────
export const GROUP_TRIGGER_WORDS: string[] = [
  "بوت ",
  "bot ",
  "كتاب ",
  "رواية ",
];

// ── Queue Workers (للتوافق مع worker.ts) ─────
export const QUEUE_WORKERS   = parseInt(process.env.WORKER_COUNT || "3", 10);
export const TIMEOUT_JOB     = 120_000;  // 2 minutes per job
export const QUEUE_HIGH_KEY  = "queue:high";    // FIX: كان "q:high" — مخالف لـ queue.ts
export const QUEUE_NORMAL_KEY = "queue:normal"; // FIX: كان "q:normal"
export const QUEUE_DLQ_KEY   = "queue:dlq";     // FIX: كان "q:dlq"
export const QUEUE_ACTIVE_KEY = "queue:active"; // FIX: أُضيف — كان غائباً
export const QUEUE_JOBS_HASH = "queue:jobs";    // FIX: كان "q:jobs"
export const QUEUE_USER_PENDING_KEY = (uid: string) => `queue:user:${uid}`;  // FIX: كان q:user:...:pending
export const QUEUE_MAX_PER_USER = 2;   // FIX: كان 3 — queue.ts يستخدم 2
export const QUEUE_MAX_RETRIES  = 3;
export const QUEUE_JOB_TTL_SEC  = 300;        // FIX: كان 86_400 — queue.ts يستخدم 300 (5 دقائق)
export const TEMP_FILE_MAX_AGE  = 3_600_000;  // 1 hour

// ── Analytics ─────────────────────────────────
export const ANALYTICS_PREFIX = "analytics";
export const ANALYTICS_TTL    = 8 * 86_400;   // 8 days

// ── Payments ───────────────────────────────────
export const PREMIUM_STARS_PRICE = 100;  // Telegram Stars لـ Premium شهري

export const TEMP_DIR = process.env.TEMP_DIR || "/tmp/kholasa_books";
