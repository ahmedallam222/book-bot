import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import {
  getDailyStats,
  getTopBooks,
  getSourceStats,
  type SourceStat,
} from "./analytics.js";
import { cairoDateString, cairoHourNumber } from "./text.js";
import {
  ADMIN_IDS,
  DAILY_DIGEST_HOUR_CAIRO,
  DAILY_DIGEST_DISABLED,
  SOURCE_RANK_MIN_SAMPLES,
} from "./config.js";

// ══════════════════════════════════════════════
// DAILY ADMIN DIGEST — once-per-day summary
//
// Fires at DAILY_DIGEST_HOUR_CAIRO (default 09:00 Cairo). Reuses the
// alertWatcher's 5-minute polling loop and the same SET-NX-EX cooldown
// pattern as the other alerts, so:
//   • runs only when current cairoHour === target hour
//   • acquires `alert:last:daily_digest` with 23h TTL on success
//   • restart-safe: the lock survives bot restarts within the day
//   • no separate scheduler / cron / interval to wire up
//
// Content:
//   • active users in last 24 h (zcount on user:lastSeen)
//   • yesterday's daily success rate (found / requests)
//   • top 3 books from yesterday's downloads (or all-time fallback)
//   • failing sources — trustRate < threshold over rolling 7d window
// ══════════════════════════════════════════════

const LAST_DIGEST_KEY = "alert:last:daily_digest";
const LOCK_TTL_SEC    = 23 * 3600;           // 23 h — fits inside a 24 h cycle
const FAILING_TRUST_THRESHOLD = 0.30;        // sources < 30% trust → flagged

interface DigestData {
  /** Cairo date string for which the digest reports (yesterday). */
  reportDate:    string;
  /** Active distinct users observed in the last 24 h. */
  activeUsers24h: number;
  /** Daily stats hash from `stats:daily:{reportDate}`. */
  daily:         Record<string, number>;
  /** Top 3 books by all-time download count. */
  topBooks:      { book: string; count: number }[];
  /** Sources with low trust over the rolling 7-day window. */
  failingSources: SourceStat[];
}

// Cairo `YYYY-MM-DD` for the day before `now`. Subtracting 86 400 000 ms
// works across DST because cairoDateString re-parses the wall clock.
export function yesterdayCairoKey(now: Date = new Date()): string {
  return cairoDateString(new Date(now.getTime() - 86_400_000));
}

// Pure formatter — turns the raw stats payload into the Markdown body
// of the digest. Exported so it can be unit-tested deterministically
// without spinning up Telegram or Redis.
export function buildDailyDigestMessage(d: DigestData): string {
  const requests = d.daily.requests   ?? 0;
  const found    = d.daily.found      ?? 0;
  const downloads = d.daily.downloads ?? 0;
  const cacheHits = d.daily.cache_hits ?? 0;
  const searches  = d.daily.searches   ?? 0;
  const successPct = requests > 0
    ? `${((found / requests) * 100).toFixed(1)}%`
    : "—";

  const lines: string[] = [];
  lines.push(`📊 *تقرير يومي — ${d.reportDate}*`);
  lines.push(`▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔`);
  lines.push("");
  lines.push(`👥 *المستخدمون النشطون (آخر 24 ساعة):* ${d.activeUsers24h}`);
  lines.push("");
  lines.push(`📥 *الطلبات:* ${requests}`);
  lines.push(`✅ *تم التسليم:* ${found} (${successPct})`);
  lines.push(`📦 *تحميلات حقيقية:* ${downloads} — 💾 cache: ${cacheHits}`);
  lines.push(`🔍 *عمليات بحث:* ${searches}`);

  if (d.topBooks.length > 0) {
    lines.push("");
    lines.push(`🏆 *أكثر الكتب (طوال الوقت):*`);
    d.topBooks.slice(0, 3).forEach((b, i) => {
      // Strip leading control chars + truncate long titles for one-line layout
      const safe = b.book.replace(/[*_`[\]]/g, "").slice(0, 40);
      lines.push(`  ${i + 1}. ${safe} — ${b.count}`);
    });
  }

  if (d.failingSources.length > 0) {
    lines.push("");
    lines.push(`⚠️ *مصادر منخفضة الثقة (آخر 7 أيام):*`);
    for (const s of d.failingSources.slice(0, 5)) {
      const trustPct = `${Math.round(s.trustRate * 100)}%`;
      lines.push(`  • ${s.domain} — ${trustPct} (${s.totalWithRejects} محاولة)`);
    }
  } else {
    lines.push("");
    lines.push(`✅ كل المصادر النشطة فوق ${Math.round(FAILING_TRUST_THRESHOLD * 100)}% ثقة`);
  }

  lines.push("");
  lines.push(`_/admin للوحة التحكم الكاملة_`);
  return lines.join("\n");
}

async function sendDigestToAdmins(bot: TelegramBot, text: string): Promise<void> {
  if (ADMIN_IDS.size === 0) {
    L.warn("digest", "No ADMIN_IDS set — daily digest not sent");
    return;
  }
  await Promise.allSettled(
    [...ADMIN_IDS].map((id) =>
      bot.sendMessage(Number(id), text, { parse_mode: "Markdown" })
    )
  );
}

/**
 * Runs the daily-digest check. Safe to call every 5 minutes — exits
 * cheaply if it's not the configured hour, and a SET-NX-EX lock prevents
 * duplicate sends within the 23-hour cooldown.
 *
 * Surfaces a structured log line on send so we can grep production logs
 * to confirm the digest fired (and only once).
 */
export async function runDailyDigest(
  bot: TelegramBot,
  now: Date = new Date(),
): Promise<void> {
  if (DAILY_DIGEST_DISABLED) return;
  if (cairoHourNumber(now) !== DAILY_DIGEST_HOUR_CAIRO) return;

  // Atomic lock — only the first 5-minute tick within the target hour
  // (across restarts in a 23-h window) acquires it.
  const lockAcquired = await redis
    .set(LAST_DIGEST_KEY, String(Math.floor(now.getTime() / 1000)), "EX", LOCK_TTL_SEC, "NX")
    .catch(() => null);
  if (lockAcquired !== "OK") return;

  // Yesterday's full-day stats are final at 09:00 Cairo (today is
  // ~9 hours old at this point — too partial to summarize).
  const reportDate = yesterdayCairoKey(now);
  const since24hMs = now.getTime() - 24 * 3600 * 1000;

  const [activeUsers24h, daily, topBooks, sourceStats] = await Promise.all([
    redis.zcount("user:lastSeen", since24hMs, "+inf").catch(() => 0),
    getDailyStats(reportDate).catch(() => ({} as Record<string, number>)),
    getTopBooks(3).catch(() => [] as { book: string; count: number }[]),
    getSourceStats().catch(() => [] as SourceStat[]),
  ]);

  // Only flag sources with enough samples to trust the rate (avoid
  // listing a brand-new source after 1 unlucky failed attempt).
  const failingSources = sourceStats
    .filter((s) =>
      s.totalWithRejects >= SOURCE_RANK_MIN_SAMPLES &&
      !s.autoDisabled &&  // already-disabled sources don't need a digest line
      s.trustRate < FAILING_TRUST_THRESHOLD,
    )
    .sort((a, b) => a.trustRate - b.trustRate);  // worst first

  const message = buildDailyDigestMessage({
    reportDate,
    activeUsers24h,
    daily,
    topBooks,
    failingSources,
  });

  await sendDigestToAdmins(bot, message);
  L.info("digest", "Daily digest sent", {
    reportDate,
    activeUsers24h,
    requests:       daily.requests ?? 0,
    found:          daily.found    ?? 0,
    failingSources: failingSources.length,
    admins:         ADMIN_IDS.size,
  });
}
