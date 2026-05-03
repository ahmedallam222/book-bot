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

// ── AI Summary providers ──────────────────────
// Multi-provider failover stack for the book-summary feature. Each
// key is independently optional — missing keys just remove that
// provider from the rotation; the registry continues with whatever
// is configured. See server/bot/aiProviders/registry.ts.
export const GEMINI_API_KEY           = process.env.GEMINI_API_KEY           || "";
export const GROQ_API_KEY             = process.env.GROQ_API_KEY             || "";
export const CEREBRAS_API_KEY         = process.env.CEREBRAS_API_KEY         || "";
export const SAMBANOVA_API_KEY        = process.env.SAMBANOVA_API_KEY        || "";
export const OPENROUTER_API_KEY       = process.env.OPENROUTER_API_KEY       || "";
export const GITHUB_MODELS_TOKEN      = process.env.GITHUB_MODELS_TOKEN      || "";
export const CLOUDFLARE_AI_ACCOUNT_ID = process.env.CLOUDFLARE_AI_ACCOUNT_ID || "";
export const CLOUDFLARE_AI_API_TOKEN  = process.env.CLOUDFLARE_AI_API_TOKEN  || "";
// Premium-tier — paid you.com Smart API. Routed only for `isPremium` users.
export const YOU_COM_API_KEY          = process.env.YOU_COM_API_KEY          || "";

// Per-provider HTTP timeout. Slow providers (Cloudflare, OpenRouter)
// occasionally exceed 30s; we cap at 45s and let the registry fail
// over rather than blocking the user any longer.
export const TIMEOUT_AI_PROVIDER = parseInt(
  process.env.TIMEOUT_AI_PROVIDER || "45000",
  10,
);

// Per-user daily summary quota for free users. Premium users are
// unmetered (routed to you.com which is paid). Set to 0 to disable
// the rate limit.
export const SUMMARY_DAILY_LIMIT_FREE = parseInt(
  process.env.SUMMARY_DAILY_LIMIT_FREE || "3",
  10,
);

// Global, bot-wide daily ceiling on AI summary calls (cache hits do
// not count). Exists to protect the free Gemini quota (1500/day) from
// a viral spike or abuse — once we hit this number, new requests
// receive a "try again tomorrow" message while cached summaries keep
// flowing. Default 1200 = 80% of Gemini's free tier with 300-call
// headroom for retries / failover noise. Set to 0 to disable.
export const SUMMARY_DAILY_LIMIT_GLOBAL = parseInt(
  process.env.SUMMARY_DAILY_LIMIT_GLOBAL || "1200",
  10,
);

// How long to keep generated summaries in Redis. The same book
// always yields the same summary, so caching effectively eliminates
// repeat-cost — most production traffic should be cache hits after
// a warm-up period.
export const SUMMARY_CACHE_TTL_SECONDS = parseInt(
  process.env.SUMMARY_CACHE_TTL_SECONDS || String(30 * 24 * 3600),
  10,
);

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
//
// downloads.hindawi.org belongs here because Hindawi serves PDFs by
// numeric ID (e.g. /books/62575295.pdf) — there is no filename slug
// for the validator to score, and Mistral's URL-hint rule rejects all
// digit-only filenames. The PDF metadata's /Title sits beyond the
// 64KB scan window in their files. The numeric ID resolves
// 1-to-1 to a published book in their public-domain Arabic catalog,
// so the failure mode (search-ranker mismatch) is the same as libgen.
export const TRUSTED_PDF_DOMAINS: string[] = [
  "dl.waqfeya.net",
  "books-library.net",
  "1lib.sk",
  "libgen.is",
  "libgen.rs",
  "libgen.st",
  "library.lol",
  "z-lib.org",
  "downloads.hindawi.org",
];

// ── Filename-trusted PDF domains ──────────────
// (Originally introduced in PR #17. The constants were dropped during
// the PR #18 merge resolution leaving pdfValidator.ts unable to
// compile against main; restoring them here.)
//
// Curated content libraries that reliably serve real PDFs but host
// many unrelated books too (so a search ranker mistake is plausible).
// We trust filename match as ground truth on these and skip Mistral
// only when urlFilenameRelevance(bookName, pdfUrl) is high enough —
// see MISTRAL_BYPASS_FILENAME_THRESHOLD below.
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

// ── Download attempt caps (find-to-send loss mitigation) ──
// Production audit (2026-05-03) showed 44% of "found" searches never
// deliver a PDF. Root cause: the download loop in bookRequest.ts had
// NO cap — every candidate URL was tried until one succeeded. Low-
// success domains (Hindawi 16%, foulabook 25%) crowded the loop with
// 4-8 doomed attempts each, burning ~90s × N per request before the
// user got "links_only".
//
// Two caps mitigate this without changing existing success paths:
//
//   * MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST — global ceiling on URL
//     attempts per single book request. After this many tries we
//     stop and surface "links_only" instead of timing out.
//   * MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN — per-domain ceiling within
//     one request. Once we've tried this many URLs from the same
//     host and they all failed, we skip remaining URLs from that
//     host and move to the next domain.
//
// Tunable via env. Set to 0 to disable a cap entirely.
export const MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST = parseInt(
  process.env.MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST || "6",
  10,
);
export const MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN = parseInt(
  process.env.MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN || "2",
  10,
);

// Soft penalty for domains whose observed success rate (over recent
// requests) is below this threshold. Applied in URL ranking — a low-
// rate domain still appears in the candidate list, but gets pushed
// behind higher-rate alternatives. Distinct from UNRELIABLE_DOMAINS
// which is a static block-list with a hard penalty.
//
// Default 0.30 = "domains succeeding less than 30% of the time get
// soft-penalized in scoring". Set to 0 to disable the soft penalty.
export const LOW_SUCCESS_RATE_PENALTY_THRESHOLD = parseFloat(
  process.env.LOW_SUCCESS_RATE_PENALTY_THRESHOLD || "0.30",
);

// After this many consecutive Mistral NO verdicts on the same book
// request, stop calling Mistral for the remaining candidates and fall
// back to heuristics (metadata title score + filename relevance).
// Rationale: prod logs showed up to 5 Mistral calls in a single 20s
// window for one book request — every NO costs API budget without
// changing the answer (when 3 candidates already failed Mistral, the
// 4th is unlikely to flip; we should let the heuristics decide and
// either reject quickly or fail-open without the paid round-trip).
// 0 disables the early-stop entirely.
export const MISTRAL_NO_STREAK_LIMIT = parseInt(
  process.env.MISTRAL_NO_STREAK_LIMIT || "3",
  10,
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
