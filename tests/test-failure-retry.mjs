// Test: auto-retry-on-improvement feature
//
// Background: PR #97 fixed the rescue-low-relevance bug, but the
// users who failed BEFORE the fix never got their books. This
// feature records every failure with a 7-day TTL and a background
// worker (every 30min) replays the search; on success it sends the
// PDF as a reply-quote to the user's original message with an
// apology preface. Also adds /retry_failures admin command.
//
// This test verifies (without spinning up the full bot):
//   1. failureRetry.ts exports the public API expected by the rest
//      of the system (recordFailure, listPendingFailures,
//      removeFailure, runRetryPass, startFailureRetryWorker,
//      failureKey)
//   2. recordFailure is wired into all 3 fail-message sites in
//      bookRequest.ts and is awaited fire-and-forget (.catch)
//   3. The retry worker is started in index.ts after alertWatcher
//   4. /retry_failures admin command is registered in commands.ts
//   5. Bundle markers — the compiled dist/index.cjs contains all
//      the new strings (so we know tree-shaking didn't drop the
//      feature)
//   6. recordFailure is skipped on the showPaidBookMessage path
//      (paid books won't suddenly become free; retrying spams)
//   7. Cooldown / max-attempts constants are non-zero (regression:
//      a typo to 0 would cause the worker to spam delivery)
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

let pass = 0, fail = 0;
function check(label, condition, expected, actual) {
  if (condition) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  expected=${JSON.stringify(expected)}  actual=${JSON.stringify(actual)}`); }
}

// ── 1. Static module exports + constants ──
const retrySrc = await readFile(path.join(root, "../server/bot/failureRetry.ts"), "utf-8");

const exportedNames = [
  "recordFailure",
  "removeFailure",
  "listPendingFailures",
  "runRetryPass",
  "startFailureRetryWorker",
  "failureKey",
];
for (const name of exportedNames) {
  const re = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${name}\\b`);
  check(`failureRetry exports ${name}`, re.test(retrySrc));
}

// FailedSearch / RetryPassResult interfaces
check("FailedSearch interface declared",   /export interface FailedSearch\s*\{/.test(retrySrc));
check("RetryPassResult interface declared", /export interface RetryPassResult\s*\{/.test(retrySrc));

// Tunables — guard against zero-ing accidentally
const ttlMatch       = retrySrc.match(/RETRY_TTL_DAYS\s*=\s*(\d+)/);
const maxAttempts    = retrySrc.match(/RETRY_MAX_ATTEMPTS\s*=\s*(\d+)/);
const cooldownMatch  = retrySrc.match(/RETRY_MIN_COOLDOWN_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
const intervalMatch  = retrySrc.match(/RETRY_WORKER_INTERVAL_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
const startupMatch   = retrySrc.match(/RETRY_WORKER_STARTUP_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);

check("RETRY_TTL_DAYS >= 1 day",       ttlMatch && Number(ttlMatch[1]) >= 1);
check("RETRY_MAX_ATTEMPTS >= 2",       maxAttempts && Number(maxAttempts[1]) >= 2);
check("RETRY_MIN_COOLDOWN_MS >= 5min", cooldownMatch && Number(cooldownMatch[1]) * Number(cooldownMatch[2]) * Number(cooldownMatch[3]) >= 5 * 60 * 1000);
check("RETRY_WORKER_INTERVAL_MS >= 5min", intervalMatch && Number(intervalMatch[1]) * Number(intervalMatch[2]) * Number(intervalMatch[3]) >= 5 * 60 * 1000);
check("RETRY_WORKER_STARTUP_MS >= 1min",  startupMatch && Number(startupMatch[1]) * Number(startupMatch[2]) * Number(startupMatch[3]) >= 60 * 1000);

// Rescue thresholds mirror bookRequest.ts (so retries see same candidate set)
const bookReqSrc = await readFile(path.join(root, "../server/bot/bookRequest.ts"), "utf-8");
const reqBest    = bookReqSrc.match(/RESCUE_BEST_PDF_THRESHOLD\s*=\s*([\d.]+)/);
const retryBest  = retrySrc.match(/RETRY_RESCUE_BEST_PDF_THRESHOLD\s*=\s*([\d.]+)/);
check("RETRY_RESCUE_BEST_PDF_THRESHOLD matches bookRequest.ts",
  reqBest && retryBest && reqBest[1] === retryBest[1],
  reqBest?.[1], retryBest?.[1]);

const reqFb   = bookReqSrc.match(/RESCUE_FALLBACK_THRESHOLD\s*=\s*([\d.]+)/);
const retryFb = retrySrc.match(/RETRY_RESCUE_FALLBACK_THRESHOLD\s*=\s*([\d.]+)/);
check("RETRY_RESCUE_FALLBACK_THRESHOLD matches bookRequest.ts",
  reqFb && retryFb && reqFb[1] === retryFb[1],
  reqFb?.[1], retryFb?.[1]);

// Lock + Redis safety
check("PASS_LOCK_KEY guards concurrent passes", /PASS_LOCK_KEY\s*=\s*["']retry:fail:lock["']/.test(retrySrc));
check("Lock acquired with NX", /redis\.set\([\s\S]*?PASS_LOCK_KEY[\s\S]*?"NX"/.test(retrySrc));
check("Lock released in finally",                /finally\s*\{[^}]*redis\.del\(PASS_LOCK_KEY\)/s.test(retrySrc));

// Idempotency: existing record should bump attempts/lastTs not duplicate
check("recordFailure merges existing record",    /existing\s*=\s*await\s+redis\.get/.test(retrySrc));
check("recordFailure refreshes TTL on merge",    /redis\.set\(key,\s*JSON\.stringify\(merged\),\s*"EX",\s*RETRY_TTL_DAYS/.test(retrySrc));

// Skip admin failures — admins running probes shouldn't pile up retry records
check("recordFailure skips ADMIN_IDS", /ADMIN_IDS\.has\(rec\.userId\)/.test(retrySrc));

// Reply-quote in apology + allow_sending_without_reply guard
check("retry sends apology with reply_to_message_id", /reply_to_message_id:\s*rec\.userMessageId/.test(retrySrc));
check("retry uses allow_sending_without_reply",       /allow_sending_without_reply:\s*true/.test(retrySrc));

// Markdown-escape regression — production logs (2026-05-07/08) showed the
// retry scheduler crashing on `apology send failed (non-fatal) … can't
// parse entities … starting at by`. Cause: bookName + userName were
// interpolated into Markdown without escaping, so any `_` in a Telegram
// username (officially allowed) or any `*`/`_`/`` ` `` in a book name
// broke the `_…_` italic wrapper. Fix mirrors PR #102's `/invite` fix.
check("apology imports escMd from text",
  /import\s+\{[^}]*\bescMd\b[^}]*\}\s+from\s+["']\.\/text/.test(retrySrc));
check("apology escapes bookName via escMd",
  /escMd\(rec\.bookName\.slice\(0,\s*60\)\)/.test(retrySrc));
check("apology escapes userName via escMd",
  /escMd\(rec\.userName\)/.test(retrySrc));
// Defensive: the apology must NOT interpolate raw bookName/userName into
// the Markdown template literal anymore. Catch regressions where someone
// reverts to `${rec.bookName}` directly.
check("apology never references rec.bookName.slice without escMd",
  !/"\$\{rec\.bookName\.slice\(0,\s*60\)\}"/.test(retrySrc));

// Telemetry counter (matches the existing tel:dl:* / tel:retry:* convention)
check("retry counter tel:retry:delivered", /redis\.incr\(["']tel:retry:delivered["']\)/.test(retrySrc));

// ── 2. Hook into bookRequest.ts at all 3 fail sites ──
// We import recordFailure plus removeFailure + failureKey (to clear
// stale records on successful delivery — see bug fix 2026-05-24).
check("bookRequest imports recordFailure",
  /import\s+\{[^}]*\brecordFailure\b[^}]*\}\s+from\s+["']\.\/failureRetry/.test(bookReqSrc));
check("bookRequest imports removeFailure (for clear-on-success)",
  /import\s+\{[^}]*\bremoveFailure\b[^}]*\}\s+from\s+["']\.\/failureRetry/.test(bookReqSrc));
check("bookRequest imports failureKey (for clear-on-success)",
  /import\s+\{[^}]*\bfailureKey\b[^}]*\}\s+from\s+["']\.\/failureRetry/.test(bookReqSrc));

// Each success-path must clear any pending failure record so the
// retry worker doesn't redeliver with an "وجدتُ الكتاب الآن" apology.
const removeCallCount = (bookReqSrc.match(/removeFailure\(failureKey\(/g) || []).length;
check("bookRequest calls removeFailure on >=3 success paths",
  removeCallCount >= 3, ">=3", removeCallCount);

const recordCalls = (bookReqSrc.match(/recordFailure\(\{/g) || []).length;
check("bookRequest calls recordFailure at >=3 sites",
  recordCalls >= 3, ">=3", recordCalls);

// Each call must be fire-and-forget (.catch) — never await, never throw
const fireForget = (bookReqSrc.match(/recordFailure\(\{[\s\S]*?\}\)\.catch\(/g) || []).length;
check("recordFailure calls are fire-and-forget (.catch)",
  fireForget >= 3, ">=3", fireForget);

// All 3 reasons must be represented
check("bookRequest passes reason: 'no_results'",          /reason:\s*["']no_results["']/.test(bookReqSrc));
check("bookRequest passes reason: 'all_attempts_failed'", /reason:\s*["']all_attempts_failed["']/.test(bookReqSrc));
check("bookRequest passes reason: 'error'",               /reason:\s*["']error["']/.test(bookReqSrc));

// Skip recording on paid-book signal — those books won't suddenly become free
check("recordFailure skipped when showPaidBookMessage",
  /!showPaidBookMessage\s*&&\s*userMessageId/.test(bookReqSrc));

// ── 3. Bot startup wiring ──
const indexSrc = await readFile(path.join(root, "../server/bot/index.ts"), "utf-8");
check("index.ts imports startFailureRetryWorker",
  /import\s+\{\s*startFailureRetryWorker\s*\}\s+from\s+["']\.\/failureRetry/.test(indexSrc));
check("index.ts calls startFailureRetryWorker",
  /startFailureRetryWorker\(_bot,\s*BOT_TOKEN\)/.test(indexSrc));
// Order matters: alertWatcher first (existing infra), then retry worker
const startAlertIdx = indexSrc.indexOf("startAlertWatcher(_bot)");
const startRetryIdx = indexSrc.indexOf("startFailureRetryWorker(_bot");
check("retry worker started after alertWatcher",
  startAlertIdx > 0 && startRetryIdx > startAlertIdx);

// ── 4. /retry_failures admin command ──
const cmdSrc = await readFile(path.join(root, "../server/bot/commands.ts"), "utf-8");
check("commands.ts imports runRetryPass + listPendingFailures",
  /import\s+\{\s*runRetryPass,\s*listPendingFailures\s*\}\s+from\s+["']\.\/failureRetry/.test(cmdSrc));
check("/retry_failures regex registered", /bot\.onText\(\s*\/\^\\\/retry_failures/.test(cmdSrc));
check("/retry_failures gated on isAdmin",   /\/retry_failures[\s\S]{0,500}isAdmin\(userId\)/.test(cmdSrc));
check("/retry_failures triggers runRetryPass with triggeredBy='admin'",
  /runRetryPass\(bot,\s*token,\s*\{\s*triggeredBy:\s*["']admin["']/.test(cmdSrc));

// ── 5. Compiled-bundle markers ──
let bundle = "";
try {
  bundle = await readFile(path.join(root, "../dist/index.cjs"), "utf-8");
} catch {
  console.log("SKIP  bundle markers (dist/index.cjs not built — run npm run build)");
}
if (bundle) {
  const wantedMarkers = [
    "retry:fail",                 // Redis key prefix
    "tel:retry:delivered",        // counter
    "Failure recorded for later replay",  // log line
    "Retry pass complete",        // log line
    "Failure retry worker started", // startup log
    "/retry_failures",            // admin cmd marker (literal text in regex source)
  ];
  for (const m of wantedMarkers) {
    check(`bundle contains marker: ${JSON.stringify(m).slice(0, 50)}`, bundle.includes(m));
  }
  // Arabic strings in templates are unicode-escaped by esbuild; check the
  // u-escape form so we know the apology copy + admin response made it in.
  // Updated PR #99 (2026-05-06): "آسف على" → "أعتذر على" (Modern Standard
  // Arabic). Both u-escaped forms accepted to remain forward-compatible
  // if the copy is re-tweaked again.
  // FIX 2026-05-07: esbuild emits hex with mixed case (e.g. \u062A vs
  // \u062a). Compare on a lowercased copy so case differences don't fail.
  const bundleLc = bundle.toLowerCase();
  check("bundle contains apology Arabic (u-escaped أعتذر or آسف)",
    bundleLc.includes("\\u0623\\u0639\\u062a\\u0630\\u0631") || bundle.includes("أعتذر") ||
    bundleLc.includes("\\u0622\\u0633\\u0641")               || bundle.includes("آسف على"));
  check("bundle contains admin response Arabic (u-escaped or raw إعادة)",
    bundleLc.includes("\\u0625\\u0639\\u0627\\u062f\\u0629") || bundle.includes("إعادة"));
}

console.log(`\nTotal: ${pass + fail}  pass=${pass}  fail=${fail}`);
if (fail > 0) process.exit(1);
