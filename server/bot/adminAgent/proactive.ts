// ══════════════════════════════════════════════════════════
// Admin Agent — Proactive Monitoring & Auto-Remediation
// ══════════════════════════════════════════════════════════
// Runs periodic health checks and dispatches Telegram alerts
// to all ADMIN_IDS when anomalies are detected. Can also auto-
// pause failing sources without human intervention.
//
// Lifecycle:
//   startProactiveMonitoring(bot)   ← called in startAdminAgent()
//   stopProactiveMonitoring()       ← called in stopAdminAgent()
//
// Alert cooldown: same alert type won't fire twice within
// ALERT_COOLDOWN_MS (default 4h) to prevent spam.
//
// Storage:
//   admin:agent:last_alert  — Hash (field=alertType, value=unixMs)
//   admin:agent:proactive:log — List (capped at 100, latest health check results)

import TelegramBot from "node-telegram-bot-api";
import { redis }   from "../redis.js";
import { L }       from "../logger.js";
import { ADMIN_IDS } from "../config.js";
import {
  getDailyStats,
  getSourceStats,
  setSourceManuallyDisabled,
  type SourceStat,
} from "../analytics.js";
import { getQueueStats } from "../queue.js";
import { getDeliveryStats } from "../deliveryMetrics.js";
import { buildProductionPulse } from "../productionPulse.js";
import { cairoDateString } from "../text.js";

// ── Thresholds ────────────────────────────────────────────

const THRESHOLDS = {
  /** Alert if daily success rate < 50%. */
  SUCCESS_RATE_MIN:        0.5,
  /** Auto-pause source if failure rate > 80% (with ≥5 attempts). */
  SOURCE_FAILURE_RATE_MAX: 0.8,
  /** Alert if DLQ has more than this many jobs. */
  DLQ_SIZE_MAX:            20,
  /** Alert if pending queue > this. */
  QUEUE_BACKLOG_MAX:       50,
  /** Minimum requests before we evaluate rates. */
  MIN_REQUESTS:            10,
  /** Minimum source attempts before we evaluate. */
  MIN_SOURCE_ATTEMPTS:     5,
  /** Check interval (ms). Default 1 hour. */
  CHECK_INTERVAL_MS:       60 * 60 * 1000,
  /** Delay before first check (ms). Let the bot stabilize. */
  INITIAL_DELAY_MS:        5 * 60 * 1000,
  /** Alert if delivery p95 exceeds this (ms) with enough samples. */
  DELIVERY_P95_MAX_MS:     120_000,
  /** Min delivery samples before evaluating p95. */
  MIN_DELIVERY_SAMPLES:    8,
} as const;

const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h
const LAST_ALERT_KEY    = "admin:agent:last_alert";
const PROACTIVE_LOG_KEY = "admin:agent:proactive:log";
const PROACTIVE_LOG_MAX = 100;

// ── Types ─────────────────────────────────────────────────

export interface ProactiveAlert {
  type:     string;
  severity: "info" | "warning" | "critical";
  message:  string;
  data?:    Record<string, unknown>;
  ts:       number;
}

// ── State ─────────────────────────────────────────────────

let _intervalId: ReturnType<typeof setInterval> | null = null;
let _timeoutId:  ReturnType<typeof setTimeout>  | null = null;
let _bot: TelegramBot | null = null;

// ── Cooldown ──────────────────────────────────────────────

async function shouldSendAlert(alertType: string): Promise<boolean> {
  try {
    const raw = await redis.hget(LAST_ALERT_KEY, alertType);
    if (!raw) return true;
    return Date.now() - Number(raw) > ALERT_COOLDOWN_MS;
  } catch {
    return true;
  }
}

async function markAlertSent(alertType: string): Promise<void> {
  try {
    await redis.hset(LAST_ALERT_KEY, alertType, String(Date.now()));
    await redis.expire(LAST_ALERT_KEY, 7 * 24 * 3600); // 7d TTL on the hash
  } catch { /* non-fatal */ }
}

// ── Alert dispatch ────────────────────────────────────────

async function dispatchAlerts(alerts: ProactiveAlert[]): Promise<number> {
  if (!_bot || alerts.length === 0) return 0;
  const adminIds = Array.from(ADMIN_IDS);
  if (adminIds.length === 0) return 0;

  // Import notification prefs check (lazy to avoid circular deps)
  let checkSeverity: ((s: string) => Promise<boolean>) | null = null;
  try {
    const { shouldAlertBySeverity } = await import("./tools.js");
    checkSeverity = shouldAlertBySeverity;
  } catch { /* fallback: send all */ }

  let sent = 0;
  for (const alert of alerts) {
    if (!(await shouldSendAlert(alert.type))) continue;
    // Check notification preferences — skip if severity below threshold
    if (checkSeverity && !(await checkSeverity(alert.severity))) continue;
    const emoji =
      alert.severity === "critical" ? "🚨"
        : alert.severity === "warning" ? "⚠️"
          : "ℹ️";
    const text =
      `${emoji} *تنبيه تلقائي — ${alert.severity}*\n\n${alert.message}`;
    for (const adminId of adminIds) {
      try {
        await _bot.sendMessage(Number(adminId), text, { parse_mode: "Markdown" });
        sent++;
      } catch (e) {
        L.warn("proactive", `alert dispatch failed to ${adminId}: ${String(e).slice(0, 80)}`);
      }
    }
    await markAlertSent(alert.type);
  }
  return sent;
}

// ── Core health check ─────────────────────────────────────

async function runHealthCheck(): Promise<ProactiveAlert[]> {
  const alerts: ProactiveAlert[] = [];
  const ts = Date.now();

  try {
    // ── 1. Daily success rate ──
    const stats = await getDailyStats();
    const requests  = stats.requests  ?? 0;
    const found     = stats.found     ?? 0;
    const downloads = stats.downloads ?? 0;
    const cacheHits = stats.cache_hits ?? 0;

    if (requests >= THRESHOLDS.MIN_REQUESTS) {
      const successRate = found / requests;
      if (successRate < THRESHOLDS.SUCCESS_RATE_MIN) {
        alerts.push({
          type: "low_success_rate", severity: "warning", ts,
          message:
            `نسبة النجاح اليوم *${Math.round(successRate * 100)}%* ` +
            `(${found}/${requests})\n` +
            `تحميلات: ${downloads}، كاش: ${cacheHits}`,
          data: { successRate, found, requests },
        });
      }
    }

    // ── 2. Queue health ──
    const queue = await getQueueStats();
    const pending = queue.highQueue + queue.normalQueue;

    if (pending > THRESHOLDS.QUEUE_BACKLOG_MAX) {
      alerts.push({
        type: "queue_backlog", severity: "warning", ts,
        message:
          `الطابور فيه *${pending}* طلب متراكم ` +
          `(عالي: ${queue.highQueue}، عادي: ${queue.normalQueue})`,
        data: { pending, high: queue.highQueue, normal: queue.normalQueue },
      });
    }

    if (queue.dlqSize > THRESHOLDS.DLQ_SIZE_MAX) {
      alerts.push({
        type: "dlq_overflow", severity: "critical", ts,
        message:
          `الـ DLQ فيه *${queue.dlqSize}* job فاشل ` +
          `(الحد: ${THRESHOLDS.DLQ_SIZE_MAX})`,
        data: { dlq: queue.dlqSize },
      });
    }

    // ── 3. Source health + auto-remediation ──
    const sources = await getSourceStats();
    for (const src of sources) {
      if (src.autoDisabled || src.manuallyDisabled) continue;
      const total = src.ok + src.fail;
      if (total < THRESHOLDS.MIN_SOURCE_ATTEMPTS) continue;

      const failRate = src.fail / total;
      if (failRate > THRESHOLDS.SOURCE_FAILURE_RATE_MAX) {
        try {
          await setSourceManuallyDisabled(src.domain, true);
          alerts.push({
            type: `source_auto_paused:${src.domain}`, severity: "critical", ts,
            message:
              `تم إيقاف *${src.domain}* تلقائياً\n` +
              `فشل: ${Math.round(failRate * 100)}% (${src.fail}/${total})\n` +
              `استخدم \`unpause_source\` لإعادة التفعيل.`,
            data: { domain: src.domain, failRate, ok: src.ok, fail: src.fail },
          });
        } catch (e) {
          L.warn("proactive", `auto-pause failed for ${src.domain}: ${String(e).slice(0, 80)}`);
        }
      }
    }

    // ── 4. Delivery latency (v3) ──
    try {
      const day = cairoDateString();
      const del = await getDeliveryStats(day);
      if (
        del.samples >= THRESHOLDS.MIN_DELIVERY_SAMPLES &&
        del.p95Ms > THRESHOLDS.DELIVERY_P95_MAX_MS
      ) {
        alerts.push({
          type: "delivery_slow", severity: "warning", ts,
          message:
            `تسليم بطيء اليوم — p95 *${(del.p95Ms / 1000).toFixed(1)}ث* ` +
            `(حد ${(THRESHOLDS.DELIVERY_P95_MAX_MS / 1000).toFixed(0)}ث)\n` +
            `نجاح تسليم: ${del.successRate}% · عينات: ${del.samples}`,
          data: { p95Ms: del.p95Ms, p50Ms: del.p50Ms, successRate: del.successRate },
        });
      }
      if (
        del.samples >= THRESHOLDS.MIN_DELIVERY_SAMPLES &&
        del.successRate < 50
      ) {
        alerts.push({
          type: "delivery_low_success", severity: "warning", ts,
          message:
            `نسبة نجاح *التسليم* ${del.successRate}% (من outcomes) ` +
            `— p50 ${(del.p50Ms / 1000).toFixed(1)}ث`,
          data: { successRate: del.successRate, outcomes: del.outcomes },
        });
      }
    } catch (e) {
      L.warn("proactive", `delivery check failed: ${String(e).slice(0, 80)}`);
    }

    // ── 4b. Production pulse quality (found_no_send ratio) ──
    try {
      const pulse = await buildProductionPulse();
      const ratio = pulse.quality.found_no_send_ratio_pct;
      if (
        ratio != null &&
        ratio >= 35 &&
        pulse.quality.found_no_send >= 5 &&
        pulse.delivery.samples >= THRESHOLDS.MIN_DELIVERY_SAMPLES
      ) {
        alerts.push({
          type: "found_no_send_high",
          severity: ratio >= 50 ? "critical" : "warning",
          ts,
          message:
            `وجد نتائج ولم يُرسل PDF: *${ratio}%* ` +
            `(${pulse.quality.found_no_send} حالة) — الصحة ${pulse.healthScore}/100`,
          data: {
            ratio,
            found_no_send: pulse.quality.found_no_send,
            healthScore: pulse.healthScore,
          },
        });
      }
      if (pulse.healthScore < 40 && pulse.delivery.samples >= THRESHOLDS.MIN_DELIVERY_SAMPLES) {
        alerts.push({
          type: "health_score_low",
          severity: "critical",
          ts,
          message: `درجة صحة الإنتاج *${pulse.healthScore}/100* (${pulse.healthLabel})`,
          data: { healthScore: pulse.healthScore, alerts: pulse.alerts },
        });
      }
    } catch (e) {
      L.warn("proactive", `pulse check failed: ${String(e).slice(0, 80)}`);
    }

    // ── Log the check ──
    const logEntry = JSON.stringify({
      ts,
      alerts: alerts.length,
      requests,
      successRate: requests > 0 ? Math.round((found / requests) * 100) : null,
      pending,
      dlq: queue.dlqSize,
    });
    try {
      await redis.lpush(PROACTIVE_LOG_KEY, logEntry);
      await redis.ltrim(PROACTIVE_LOG_KEY, 0, PROACTIVE_LOG_MAX - 1);
    } catch { /* non-fatal */ }

  } catch (e) {
    L.warn("proactive", `health check failed: ${String(e).slice(0, 200)}`);
  }

  return alerts;
}

// ── Public API ────────────────────────────────────────────

export function startProactiveMonitoring(bot: TelegramBot): void {
  if (_intervalId) return;
  _bot = bot;

  _timeoutId = setTimeout(() => {
    _timeoutId = null;
    // First check
    runHealthCheck()
      .then(alerts => dispatchAlerts(alerts))
      .catch(e => L.warn("proactive", `initial check error: ${String(e).slice(0, 80)}`));

    // Recurring checks
    _intervalId = setInterval(() => {
      runHealthCheck()
        .then(alerts => dispatchAlerts(alerts))
        .catch(e => L.warn("proactive", `periodic check error: ${String(e).slice(0, 80)}`));
    }, THRESHOLDS.CHECK_INTERVAL_MS);
  }, THRESHOLDS.INITIAL_DELAY_MS);

  L.info("proactive", `monitoring started (interval=${THRESHOLDS.CHECK_INTERVAL_MS / 60_000}min)`);
}

export function stopProactiveMonitoring(): void {
  if (_timeoutId)   { clearTimeout(_timeoutId);   _timeoutId  = null; }
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  _bot = null;
  L.info("proactive", "monitoring stopped");
}

/** Manual trigger — runs one health check and returns alerts (for the admin tool). */
export async function triggerHealthCheck(): Promise<{
  alerts: ProactiveAlert[];
  dispatched: number;
}> {
  const alerts = await runHealthCheck();
  const dispatched = await dispatchAlerts(alerts);
  return { alerts, dispatched };
}

/** Returns the last N proactive check log entries. */
export async function getProactiveLog(limit = 10): Promise<unknown[]> {
  try {
    const raw = await redis.lrange(PROACTIVE_LOG_KEY, 0, limit - 1);
    return raw.map(r => { try { return JSON.parse(r); } catch { return r; } });
  } catch {
    return [];
  }
}
