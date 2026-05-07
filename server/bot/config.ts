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

// ── Cache TTLs (seconds; consumed by redis.setex) ──
// BUG-FIX: قبل كده كانت القيم بالـ milliseconds (3_600_000، 300_000)
// لكن `engine.ts` بيمرّرها لـ `redis.setex(key, seconds, value)` —
// اللي بيقبل ثواني فقط (شاهد ioredis RedisCommander.d.ts). يعني الـ
// hit cache كان بيعيش 3,600,000 ثانية ≈ 41 يوم، والـ miss cache
// 300,000 ثانية ≈ 3.5 يوم — بدل "1 ساعة" و "5 دقائق" المُذكورة في
// التعليق. ده كان بيخلي:
//   - استعلام رجع بدون نتايج يفضل cached "no results" لمدة 3.5 يوم،
//     فيُحجَب البحث الحقيقي حتى لما Firecrawl يبقى عنده الكتاب فعلاً.
//   - استعلام رجع نتايج يفضل cached للأبد تقريباً، فالـ blacklist
//     evolution والـ source disable changes بياخد وقت طويل عشان
//     يـ propagate.
// الآن: القيم بالثواني فعلاً، مطابقة لاستخدام `setex`.
export const SEARCH_CACHE_TTL_HIT     = 3_600;      // 1 hour
export const SEARCH_CACHE_TTL_MISS    = 300;        // 5 minutes

// ── Rate limits ───────────────────────────────
export const FC_RATE_LIMITED_TTL_SEC  = 60;
export const FC_QUOTA_TTL_SEC         = 86_400;     // 24h

// ── PDF Validation thresholds ─────────────────
//
// Three bands (by score):
//   score >= ACCEPT_THRESHOLD               → accept locally (no Mistral)
//                                             مع علامة CONFIRM_THRESHOLD
//                                             نضيف فحص Mistral للتأكيد لو
//                                             الدرجة بين الاتنين
//   REJECT_THRESHOLD <= score < ACCEPT      → ambiguous, ask Mistral
//   score < REJECT_THRESHOLD (clear title)  → reject locally (no Mistral)
//
// Confirm band (CONFIRM_THRESHOLD < score < ACCEPT)
//   تم استحداثه لأن "ACCEPT_THRESHOLD = 0.40" كانت تقبل candidates ذات
//   تشابه ضعيف-إلى-متوسط بدون مراجعة. مثال شائع: bookName "كتاب الفقه"
//   ضد metaTitle "الفقه السلوكي" → ratio 0.50 يقبل بدون Mistral، رغم
//   إن الكتابين مختلفان. الـ confirm band بيمسك دي ويعدّيها على Mistral.
//
//   اضبطه = ACCEPT_THRESHOLD لتعطيل الـ band (back-compat).
//   اضبطه < ACCEPT_THRESHOLD ليبدأ الفحص من تلك القيمة فما فوق.
export const PDF_VALIDATE_ACCEPT_THRESHOLD  = 0.40;
export const PDF_VALIDATE_CONFIRM_THRESHOLD = 0.55;
export const PDF_VALIDATE_REJECT_THRESHOLD  = 0.12;

// ── Blacklist ─────────────────────────────────
export const BLACKLIST_THRESHOLD      = 3;

// ── Filesystem ────────────────────────────────

// ── HTTP ──────────────────────────────────────
// FIX v29: تحديث UA لـ Chrome 124 — بعض المواقع ترفض Chrome القديم
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Admin IDs ─────────────────────────────────
// SECURITY: تُقرأ فقط من env. تم حذف الـ ID المثبت في المصدر — كان مكشوفاً
// لأي شخص يقرأ الـ repo (والـ repo public). انظر deployment notes في الـ PR.
const _envAdminIds = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => /^\d{5,15}$/.test(s));

export const ADMIN_IDS = new Set<string>(_envAdminIds);

if (ADMIN_IDS.size === 0) {
  // log فقط — لا نوقف التشغيل لأن النشر قد يكون قبل ضبط الـ env بدقيقة
  console.warn("[config] ADMIN_IDS is empty — /admin and admin alerts will be disabled until set");
}

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
//
// أُضيفت بناءً على تدقيق الإنتاج (2026-05-06):
// - scholar.archive.org: نسبة نجاح تاريخية 9% (1 ok / 10 fail). يستخدم
//   wayback ranges ضخمة على EKB Egyptian journals وهي عادةً لا تصمد للتحميل.
// - dn790009.ca.archive.org: 0 نجاح، 7 رفض من Mistral — IA mirror يرجع ملفات
//   لا تطابق العنوان المطلوب. (التقاط الـ subdomain العام archive.org/ia800
//   لا يكفي لأن CA mirror خارج النطاق المطابق.)
// - arabic-book.net: 0/2 — عيّنة صغيرة لكن صفر نجاح؛ نخفّض ترتيبه احتياطاً.
export const UNRELIABLE_DOMAINS: string[] = [
  "archive.org",
  "ia800",
  "noor-book.com",
  "makalatt.com",
  "islamhouse.com",
  "scholar.archive.org",
  "dn790009.ca.archive.org",
  "arabic-book.net",
  ...(process.env.UNRELIABLE_DOMAINS_EXTRA || "")
    .split(",")
    .map(d => d.trim())
    .filter(Boolean),
];

// ── Hard-blocked domains ─────────────────────
// قائمة سوداء "حقيقية" — أي URL يطابقها يُسقط فوراً في verify.ts
// قبل أي HEAD/GET. مختلفة عن UNRELIABLE_DOMAINS اللي بس بيخفض الترتيب.
// نستخدمها لـ domains معطوبة بالكامل (wayback academic ranges، إلخ).
//
// 2026-05-07 (Donna): scholar.archive.org تم رفعه لـ hard block — رغم
// كونه في unreliable من قبل، لا تزال تظهر روابط منه في results عند
// عدم وجود بدائل. الـ hard block يضمن إنه لا يُحاول معه أبداً.
export const HARD_BLOCKED_DOMAINS: string[] = [
  "scholar.archive.org",
  ...(process.env.HARD_BLOCKED_DOMAINS_EXTRA || "")
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

// ── Hard-fail tier ────────────────────────────
// مصادر بتفشل فشل كاتاستروفي (HTML بدل PDF، 5xx متكرر، DNS فشل …) —
// لازم يتحجبوا أسرع. Tier ثاني: عدد محاولات أقل + نسبة نجاح ≤ 0% فعلياً.
// المستخدم يضيع وقته 5 محاولات في مصدر باظ بدل 8.
export const SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS = parseInt(
  process.env.SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS || "5",
  10,
);
export const SOURCE_AUTO_DISABLE_HARD_MAX_RATE = parseFloat(
  process.env.SOURCE_AUTO_DISABLE_HARD_MAX_RATE || "0.0",
);

// ── Trust tier (مرجع لـ Mistral) ──────────────
// مصادر بترجّع PDFs بنجاح، لكن Mistral بيرفضها (يعني الكتاب الغلط).
// كأنها fail من منظور المستخدم. مثال: downloads.hindawi.org عنده
// 13 ok / 34 fail / 29 mistral_rejected. الـ successRate التقليدي = 27%،
// أعلى من حد الـ tier-1 (15%)، فما يتحجبش. لكن الـ trustRate الحقيقي
// (ok / total_with_rejects) = 17% وده اللي يمسّ المستخدم فعلاً.
//
// نحجب لو: total_with_rejects ≥ 10 محاولات، فيها mistral_rejected
// حقيقي > 0 (مش كل rejection signal من timeout)، وtrustRate ≤ 20%.
export const SOURCE_AUTO_DISABLE_TRUST_MIN_ATTEMPTS = parseInt(
  process.env.SOURCE_AUTO_DISABLE_TRUST_MIN_ATTEMPTS || "10",
  10,
);
export const SOURCE_AUTO_DISABLE_TRUST_MAX_RATE = parseFloat(
  process.env.SOURCE_AUTO_DISABLE_TRUST_MAX_RATE || "0.20",
);

// ── Mistral-only catastrophic tier ────────────
// مصادر بـ ok/fail قليلين لكن Mistral بيرفض بكثافة — يعني الـ search
// بيلاقي PDF صحيح من ناحية الشكل لكن المحتوى كتاب غلط مرارا. الـ TRUST
// tier محتاج 10 محاولات إجمالية، لكن لو المصدر رجّع 7 رفض Mistral و 0
// نجاح فعلي، الـ trust tier ما يقدرش يحجبه (totalWithRejects=7 < 10).
// مثال حقيقي: dn790009.ca.archive.org → 0 ok / 0 fail / 7 mistralRejected،
// ظل بيتحاول كل بحث فيه نتائج archive.org ثقيلة.
//
// نحجب لو: mistralRejected ≥ MIN_REJECTS، و mistralRejected ≥ ok × RATIO
// (يعني الرفض غالب على النجاح).
export const SOURCE_AUTO_DISABLE_MISTRAL_ONLY_MIN_REJECTS = parseInt(
  process.env.SOURCE_AUTO_DISABLE_MISTRAL_ONLY_MIN_REJECTS || "5",
  10,
);
export const SOURCE_AUTO_DISABLE_MISTRAL_ONLY_REJECT_RATIO = parseFloat(
  process.env.SOURCE_AUTO_DISABLE_MISTRAL_ONLY_REJECT_RATIO || "2.0",
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
// short-circuits the Mistral call. Default 0.6 means "> half of the
// book's content words appear in the filename" — strong evidence the
// source indexed the right title.
//
// Why not 0.5: short Arabic queries (2 content words) where one is a
// generic common prefix often produce 0.5 against a *different* book
// that shares that prefix. Example: "العقيدة الواسطية" (Ibn Taymiyyah's
// creed treatise) scoring 0.5 against `archive.org/.../العقيدة-السفارينية.pdf`
// (al-Saffarini's creed treatise) — both share "العقيدة" but the books
// are unrelated. Bumping to 0.6 forces ≥ 2/3 word match for 3-word
// queries and full match for 2-word queries; bypass still triggers for
// ALL the canonical strong-match cases (English "atomic-habits", Arabic
// exact slug "كافكا-على-الشاطئ", etc.) since they hit ≥ 0.67 or 1.0.
export const MISTRAL_BYPASS_FILENAME_THRESHOLD = parseFloat(
  process.env.MISTRAL_BYPASS_FILENAME_THRESHOLD || "0.6",
);

// Minimum filename-relevance for the TRUSTED_PDF_DOMAINS bypass branch
// (validator shortcut when no Firecrawl <title> was available).
//
// Audit 2026-05-04 found this branch hard-coded to 0.15 — same wrong-
// book pattern as the FILENAME_TRUSTED bypass below 0.6: "العقيدة
// الواسطية" (Ibn Taymiyyah) vs `dl.waqfeya.net/.../العقيدة-السفارينية.pdf`
// (al-Saffarini) shares 1-of-2 tokens → score 0.5 → bypass → wrong book.
//
// 0.55 forces ≥ 2/3 token overlap for 3-word queries and BOTH words
// for 2-word queries while still letting strong matches (English exact
// slug, Arabic exact slug) through. Override with the env var if you
// need to revert during incident investigation.
export const TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD = parseFloat(
  process.env.TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD || "0.55",
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

// Minimum samples (totalWithRejects = ok + fail + mistralRejected) over
// the rolling 7-day window before a source's observed trustRate is
// allowed to override its static priority order in `searchAllSources`.
// Sources with fewer samples keep their hand-picked priority — so a
// brand-new source isn't promoted to #1 just because its first lucky
// hit produced a 100% trustRate, and a momentarily flaky veteran isn't
// demoted by 1-2 noisy failures. Set to 0 to disable the threshold (and
// rank by trustRate alone for any source with stats).
export const SOURCE_RANK_MIN_SAMPLES = parseInt(
  process.env.SOURCE_RANK_MIN_SAMPLES || "3",
  10,
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

// ── Daily digest ──────────────────────────────
// Hour-of-day (Cairo TZ, 0-23) at which alertWatcher fires the daily
// admin digest. The watcher's 5-minute polling loop checks `cairoHour
// === DAILY_DIGEST_HOUR_CAIRO` and uses a 23-hour SET-NX lock so the
// digest is sent at most once per day even if the bot restarts mid-
// hour. Default 9 = 09:00 Cairo (a quiet morning hour, after midnight
// Cairo so yesterday's stats are final).
export const DAILY_DIGEST_HOUR_CAIRO = parseInt(
  process.env.DAILY_DIGEST_HOUR_CAIRO || "9",
  10,
);

// Disable the daily digest entirely without removing ADMIN_IDS or
// touching code paths. Set to "1" / "true" to opt out.
export const DAILY_DIGEST_DISABLED =
  process.env.DAILY_DIGEST_DISABLED === "1" ||
  process.env.DAILY_DIGEST_DISABLED === "true";

// ── Payments ───────────────────────────────────
export const PREMIUM_STARS_PRICE = 100;  // Telegram Stars لـ Premium شهري

export const TEMP_DIR = process.env.TEMP_DIR || "/tmp/kholasa_books";
