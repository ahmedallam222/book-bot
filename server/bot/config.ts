import * as path from "path";

// ══════════════════════════════════════════════
// BOT CONFIG — Single source of truth
// غيّر هنا وكل شيء يتبعك
// ══════════════════════════════════════════════

// ── Limits ───────────────────────────────────
export const DAILY_LIMIT       = 6;
export const PREMIUM_LIMIT     = 30;
export const MAX_PDF_SIZE      = 50  * 1024 * 1024;   // 50 MB
export const MAX_BOOK_NAME_LEN = 120;

// ── Timeouts (ms) ────────────────────────────
export const TIMEOUT_VERIFY    = 10_000;   // HEAD/GET للتحقق من PDF
export const TIMEOUT_DOWNLOAD  = 90_000;   // تحميل الملف كاملاً
export const TIMEOUT_TELEGRAM  = 30_000;   // إرسال لـ Telegram API (URL مباشر)
export const TIMEOUT_UPLOAD    = 120_000;  // رفع ملف محلي لـ Telegram (50MB تحتاج وقتاً)
export const TIMEOUT_JOB       = 10 * 60 * 1000; // 10 دقائق ثم timeout للجوب

// ── Rate Limiting ────────────────────────────
// طلبات عامة
export const RATE_LIMIT_MAX    = 4;
export const RATE_LIMIT_WINDOW = 60_000;
// معدل البحث — FIX-v11-1: كان 5 (أكبر من RATE_LIMIT_MAX=4 → لا يُطبَّق أبداً)
// الآن 3 → يمنع spam البحث قبل وصول الـ general limit
export const SEARCH_RATE_MAX    = 3;
export const SEARCH_RATE_WINDOW = 60_000;

// ── Blacklist ────────────────────────────────
export const BLACKLIST_THRESHOLD = 3;
export const BLACKLIST_TTL       = 2 * 60 * 60 * 1000;

// ── Cache TTLs (ms) ──────────────────────────
export const VERIFY_CACHE_TTL      =  5 * 60 * 1000;   // 5 دقائق (300000ms → 300 ثانية في setex)
export const SEARCH_CACHE_TTL_HIT  = 10 * 60 * 1000;   // 10 دقائق
export const SEARCH_CACHE_TTL_MISS =  2 * 60 * 1000;   // دقيقتان
export const RECENT_SEARCHES_TTL   = 30 * 1000;        // 30 ثانية

// ── Cleanup ──────────────────────────────────
export const TEMP_CLEANUP_INTERVAL = 15 * 60 * 1000;  // كل 15 دقيقة
export const TEMP_FILE_MAX_AGE     = 10 * 60 * 1000;  // احذف لو أقدم من 10 دقائق

// ── Queue ────────────────────────────────────
export const QUEUE_WORKERS          = 5;
export const QUEUE_MAX_PER_USER     = 2;
export const QUEUE_JOB_TTL_SEC      = 600;
export const QUEUE_MAX_RETRIES      = 2;
export const QUEUE_HIGH_KEY         = "q:high";
export const QUEUE_NORMAL_KEY       = "q:normal";
export const QUEUE_DLQ_KEY          = "q:dlq";
export const QUEUE_JOBS_HASH        = "q:jobs";
export const QUEUE_USER_PENDING_KEY = (uid: string) => `q:user:${uid}:pending`;

// ── Feature Flags (Redis keys) ───────────────
export const MAINTENANCE_KEY     = "flag:maintenance";
export const PREMIUM_SET_KEY     = "premium:users";
export const USER_LIMIT_KEY      = (uid: string) => `ulimit:${uid}`;
export const BOT_ANNOUNCE_KEY    = "announce:msg";

// ── Analytics (Redis keys) ───────────────────
export const ANALYTICS_PREFIX    = "stats";
export const ANALYTICS_TTL       = 32 * 24 * 60 * 60;  // 32 يوم

// ── Group Trigger Words ───────────────────────
export const GROUP_TRIGGER_WORDS = ["بوت", "bot", "بوتي", "البوت"];

// ── Misc ─────────────────────────────────────
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
export const TEMP_DIR = path.join(process.cwd(), "temp");

// ── Session ───────────────────────────────────
/** مدة صلاحية retry key في session store — ساعة واحدة */
export const RETRY_KEY_TTL = 60 * 60 * 1000;

// ── Env Sets ─────────────────────────────────
// ⚠️  مهم: ADMIN_IDS و BANNED_IDS يجب أن تكون Telegram numeric user IDs فقط
//          (أرقام مثل 123456789) — وليس usernames مثل @ahmed
//          للحصول على ID: أرسل رسالة للبوت @userinfobot
function parseNumericIds(envStr: string): string[] {
  return envStr.split(",")
    .map(s => s.trim())
    // BUG-5 FIX: كان {5,12} → يرفض معرّفات Telegram الجديدة التي تتجاوز 12 رقماً
    // Telegram بدأ يُصدر معرّفات 13-15 رقماً للحسابات الجديدة
    .filter(s => /^\d{5,15}$/.test(s));
}

export const ADMIN_IDS = new Set<string>([
  "5469997406",  // الأدمن الرئيسي
  ...parseNumericIds(process.env.ADMIN_IDS || ""),
]);
export const BANNED_USERS = new Set<string>(
  parseNumericIds(process.env.BANNED_IDS || "")
);

// ── Mistral API ──────────────────────────────
/** مفتاح Mistral API — اختياري، يُستخدم فقط كحَكَم في الحالات الغامضة */
export const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";

/** Timeout لاستدعاء Mistral (ms) */
export const TIMEOUT_MISTRAL = 10_000;

/**
 * PDF Content Validation Thresholds
 *
 * ACCEPT_THRESHOLD: score >= هذه القيمة → قبول تلقائي بدون Mistral
 * REJECT_THRESHOLD: score < هذه القيمة → رفض تلقائي بدون Mistral
 * المنطقة بينهما → Mistral يحكم
 *
 * القيم الافتراضية مُعايَرة لـ Arabic PDFs:
 *   - 0.40 accept: لو 40%+ من كلمات العنوان موجودة → كتاب صحيح
 *   - 0.12 reject: لو أقل من 12% → كتاب خاطئ واضح
 */
export const PDF_VALIDATE_ACCEPT_THRESHOLD = parseFloat(process.env.PDF_VALIDATE_ACCEPT_THRESHOLD || "0.40");
export const PDF_VALIDATE_REJECT_THRESHOLD = parseFloat(process.env.PDF_VALIDATE_REJECT_THRESHOLD || "0.12");

// ── Firecrawl Timeouts (ms) ───────────────────
export const TIMEOUT_FC_SEARCH = 45_000;   // /search endpoint
export const TIMEOUT_FC_SCRAPE = 30_000;   // /scrape endpoint
export const TIMEOUT_FC_AGENT  = 90_000;   // /agent endpoint

// ── Trusted PDF Domains ───────────────────────
// I2 FIX: مصدر واحد للحقيقة بدل قائمتين منفصلتين في firecrawl.ts و engine.ts
// تُستخدم في: isPdfUrl (dl=1 check), isTrustedDomain, sort scoring في engine
// archive.org مُزال نهائياً: يفشل 10+ مرات/يوم ويُرسل ملفات خاطئة
// noor-book.com مُزال نهائياً: يُرجع محتوى عشوائي لا علاقة له بالكتاب
export const TRUSTED_PDF_DOMAINS = [
  // مواقع عربية متخصصة
  "dl.hindawi.com", "hindawi.org",
  "waqfeya.net", "waqfeya.com",
  "foulabook.com",
  "kutub-pdf.net",
  "books-library.net",
  "islamhouse.com",
  "kotobati.com",
  "mhtktb.com",
  "ktab.cc", "pdf4arab.com",
  // مصادر جديدة (v19+)
  "islamweb.net",
  "al-mostafa.com",
  // مواقع دولية
  "pdfdrive.com",
  "z-lib.org", "1lib.sk", "annas-archive.org",
  "libgen.is", "libgen.st", "library.lol",
  "openlibrary.org",
];

/**
 * UNRELIABLE_DOMAINS — مواقع تُعطي ملفات خاطئة أو لا صلة لها بالكتاب المطلوب.
 * تُحمَّل كآخر خيار فقط بعد استنفاد الروابط الموثوقة.
 */
export const UNRELIABLE_DOMAINS: string[] = ["archive.org", "ia800"];

export const SOURCE_AUTO_DISABLE_MIN_ATTEMPTS = parseInt(
  process.env.SOURCE_AUTO_DISABLE_MIN_ATTEMPTS || "8",
  10,
);
export const SOURCE_AUTO_DISABLE_MAX_RATE = parseFloat(
  process.env.SOURCE_AUTO_DISABLE_MAX_RATE || "0.15",
);

// ── Firecrawl Alert ─────────────────────────
/** Redis key يُضبط لما quota Firecrawl تنتهي — يراقبه alertWatcher */
export const FC_QUOTA_EXCEEDED_KEY = "alert:fc:quota";
/** مدة الـ key قبل انتهائه تلقائياً (24 ساعة) */
export const FC_QUOTA_TTL_SEC      = 24 * 3600;

/** Redis key يُضبط لما Firecrawl يرجع 429 rate limit */
export const FC_RATE_LIMITED_KEY   = "alert:fc:ratelimit";
/** مدة الـ cooldown — 2 دقيقة ثم يعيد المحاولة تلقائياً */
export const FC_RATE_LIMITED_TTL_SEC = 120;
