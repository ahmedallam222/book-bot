import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { getQueueStats } from "./queue.js";
import { getDailyStats } from "./analytics.js";
import { runDailyDigest } from "./dailyDigest.js";
import {
  FC_QUOTA_EXCEEDED_KEY,
  FC_RATE_LIMITED_KEY,
  ADMIN_IDS,
} from "./config.js";
import { getDeliveryStats } from "./deliveryMetrics.js";

// ══════════════════════════════════════════════
// ALERT WATCHER — تنبيهات تلقائية للأدمن
//
// يفحص كل 5 دقائق:
//   • DLQ ≥ DLQ_ALERT_THRESHOLD        → تنبيه
//   • نسبة النجاح < SUCCESS_THRESHOLD  → تنبيه
//   • Firecrawl quota exceeded          → تنبيه (مرة واحدة/يوم)
//   • Delivery p95 / success rate       → تنبيه
//   • Daily digest at DAILY_DIGEST_HOUR_CAIRO → ملخص يومي للأدمن
// ══════════════════════════════════════════════

const DLQ_ALERT_THRESHOLD     = 20;
const SUCCESS_ALERT_THRESHOLD = 50;
const MIN_REQUESTS_TO_ALERT  = 20;
const ALERT_COOLDOWN_SEC      = 3600;

const LAST_DLQ_ALERT    = "alert:last:dlq";
const LAST_SUCC_ALERT   = "alert:last:success";
const LAST_FC_QUOTA_ALT = "alert:last:fc_quota";
const LAST_FC_RATE_ALT  = "alert:last:fc_rate";

async function sendToAdmins(bot: TelegramBot, text: string): Promise<void> {
  if (ADMIN_IDS.size === 0) {
    L.warn("alerts", "No ADMIN_IDS set — alert not sent");
    return;
  }
  await Promise.allSettled(
    [...ADMIN_IDS].map((id) => bot.sendMessage(Number(id), text, { parse_mode: "Markdown" }))
  );
}

async function runCheck(bot: TelegramBot): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  const [qs, stats, fcQuota, fcRate] = await Promise.all([
    getQueueStats().catch(() => ({ dlqSize: 0, highQueue: 0, normalQueue: 0, totalActiveJobs: 0 })),
    getDailyStats().catch(() => null),
    redis.get(FC_QUOTA_EXCEEDED_KEY).catch(() => null),
    redis.get(FC_RATE_LIMITED_KEY).catch(() => null),
  ]);

  // ── 1. فحص DLQ ────────────────────────────────
  if (qs.dlqSize >= DLQ_ALERT_THRESHOLD) {
    const lockAcquired = await redis.set(LAST_DLQ_ALERT, String(now), "EX", ALERT_COOLDOWN_SEC, "NX").catch(() => null);
    if (lockAcquired === "OK") {
      await sendToAdmins(
        bot,
        `🚨 *تنبيه: DLQ مرتفع*\n\n` +
        `📬 ${qs.dlqSize} طلب في قائمة الفشل\n\n` +
        `افتح لوحة الإدارة /admin لمراجعة الأسباب`
      );
      L.warn("alerts", `DLQ alert sent: ${qs.dlqSize} jobs`);
    }
  }

  // ── 2. فحص نسبة النجاح ────────────────────────
  const requests = stats?.requests ?? 0;
  const found    = stats?.found    ?? 0;
  if (requests >= MIN_REQUESTS_TO_ALERT) {
    const failures = Math.max(0, requests - found);
    const pct = (found / requests) * 100;
    if (pct < SUCCESS_ALERT_THRESHOLD) {
      const lockAcquired = await redis.set(LAST_SUCC_ALERT, String(now), "EX", ALERT_COOLDOWN_SEC, "NX").catch(() => null);
      if (lockAcquired === "OK") {
        await sendToAdmins(
          bot,
          `⚠️ *تنبيه: نسبة النجاح منخفضة*\n\n` +
          `📉 ${pct.toFixed(1)}% من الطلبات وجدت نتيجة اليوم\n` +
          `📥 ${requests} طلب — ✅ ${found} — ❌ ${failures}\n\n` +
          `قد تكون المصادر معطّلة — تحقق من /admin`
        );
        L.warn("alerts", `Success rate alert: ${pct.toFixed(1)}%`);
      }
    }
  }

  // ── 3. فحص Firecrawl quota ────────────────────
  if (fcQuota) {
    const lockAcquired = await redis.set(LAST_FC_QUOTA_ALT, String(now), "EX", ALERT_COOLDOWN_SEC, "NX").catch(() => null);
    if (lockAcquired === "OK") {
      const exceededAt = new Date(parseInt(fcQuota, 10)).toLocaleString("ar-EG");
      await sendToAdmins(
        bot,
        `🔥 *تنبيه: Firecrawl quota انتهت*\n\n` +
        `⏰ منذ: ${exceededAt}\n\n` +
        `⛔ البوت متوقف عن البحث حتى تجديد الـ quota.\n` +
        `🔗 لتجديد الـ quota: https://www.firecrawl.dev/dashboard`
      );
      L.warn("alerts", "Firecrawl quota alert sent to admins");
    }
  }

  // ── 4. Daily digest ───────────────────────────
  await runDailyDigest(bot).catch((e) =>
    L.error("alerts", "Daily digest error", { err: String(e).slice(0, 100) }),
  );

  // ── 5. فحص Firecrawl rate limit ───────────────
  if (fcRate) {
    const lockAcquired = await redis.set(LAST_FC_RATE_ALT, String(now), "EX", 700, "NX").catch(() => null);
    if (lockAcquired === "OK") {
      const sinceMs  = Date.now() - parseInt(fcRate, 10);
      const sinceSec = Math.max(0, Math.round(sinceMs / 1000));
      const remaining = Math.max(0, 120 - sinceSec);
      await sendToAdmins(
        bot,
        `⚡ *Firecrawl rate limited*\n\n` +
        `⏱️ منذ ${sinceSec} ثانية\n` +
        `⏳ البوت في انتظار انتهاء circuit breaker تلقائياً.\n` +
        `Circuit breaker سيُفتح خلال ${remaining > 0 ? `${remaining} ثانية` : "ثوانٍ"}.`
      );
      L.warn("alerts", "Firecrawl rate-limit alert sent to admins");
    }
  }

  // ── 6. Delivery latency p95 + success (new metrics) ──
  try {
    const ds = await getDeliveryStats();
    if (ds.samples >= 15 && ds.p95Ms > 90_000) {
      const lock = await redis.set("alert:last:latency_p95", String(now), "EX", ALERT_COOLDOWN_SEC, "NX").catch(() => null);
      if (lock === "OK") {
        await sendToAdmins(
          bot,
          `⏱ *تنبيه: بطء التسليم*\n\n` +
          `p95 = *${(ds.p95Ms / 1000).toFixed(1)}ث* (عتبة 90ث)\n` +
          `p50 = ${(ds.p50Ms / 1000).toFixed(1)}ث · نجاح ${ds.successRate}% · عينات ${ds.samples}\n` +
          `_/ops_delivery للتفاصيل_`,
        );
        L.warn("alerts", "latency p95 alert", { p95: ds.p95Ms, samples: ds.samples });
      }
    }
    if (ds.samples >= 20 && ds.successRate > 0 && ds.successRate < 55) {
      const lock = await redis.set("alert:last:delivery_success", String(now), "EX", ALERT_COOLDOWN_SEC, "NX").catch(() => null);
      if (lock === "OK") {
        await sendToAdmins(
          bot,
          `📉 *تنبيه: انخفاض نجاح التسليم*\n\n` +
          `نسبة النجاح اليوم: *${ds.successRate}%*\n` +
          `found_no_send: ${ds.outcomes.fail_found_no_send || 0} · no_results: ${ds.outcomes.fail_no_results || 0}`,
        );
      }
    }
  } catch { /* metrics optional */ }
}

/** يُستدعى مرة واحدة عند بدء البوت */
export function startAlertWatcher(bot: TelegramBot): void {
  const INTERVAL = 5 * 60 * 1000;

  setTimeout(() => {
    runCheck(bot).catch(() => {});
    setInterval(() => {
      runCheck(bot).catch((e) =>
        L.error("alerts", "Alert watcher error", { err: String(e).slice(0, 100) })
      );
    }, INTERVAL).unref();
  }, 2 * 60 * 1000);

  L.info("alerts", `Alert watcher started — admins: ${ADMIN_IDS.size}`);
}
