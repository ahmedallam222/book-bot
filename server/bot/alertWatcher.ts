import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { getQueueStats } from "./queue.js";
import { getDailyStats } from "./analytics.js";
import {
  FC_QUOTA_EXCEEDED_KEY,
  FC_RATE_LIMITED_KEY,
  ADMIN_IDS,
} from "./config.js";

// ══════════════════════════════════════════════
// ALERT WATCHER — تنبيهات تلقائية للأدمن
//
// يفحص كل 5 دقائق:
//   • DLQ ≥ DLQ_ALERT_THRESHOLD        → تنبيه
//   • نسبة النجاح < SUCCESS_THRESHOLD  → تنبيه
//   • Firecrawl quota exceeded          → تنبيه (مرة واحدة/يوم)
// ══════════════════════════════════════════════

const DLQ_ALERT_THRESHOLD     = 20;
const SUCCESS_ALERT_THRESHOLD = 50;
// BUG-G FIX: كانت 10 — بهذا الحجم الصغير، إضافة فشل واحد تُغيّر النسبة بشكل كبير
// (مثلاً: 10 محاولات، 6 نجاح = 60% → 7 فشل = 30% فجأة بسبب فشل واحد إضافي)
// والتنبيه يُرسَل مرة واحدة/ساعة فيُزعج الأدمن دون سبب حقيقي.
// الحل: رفع العتبة إلى 20 لأخذ عينة إحصائية أكثر موثوقية قبل التنبيه.
const MIN_DOWNLOADS_TO_ALERT  = 20;
const ALERT_COOLDOWN_SEC      = 3600; // ساعة بين كل تنبيه وآخر لنفس السبب

const LAST_DLQ_ALERT    = "alert:last:dlq";
const LAST_SUCC_ALERT   = "alert:last:success";
const LAST_FC_QUOTA_ALT = "alert:last:fc_quota";
const LAST_FC_RATE_ALT  = "alert:last:fc_rate";

// I2-style FIX: كانت getAdminIds() تُعيد تحليل env.ADMIN_IDS محلياً بـ parseInt() بدون validation
// weekly.ts و guards.ts يستخدمان ADMIN_IDS من config — الآن alertWatcher موحَّد معهم
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

  // FIX-v10-B: كانت 4 await متسلسلة (4 × Redis round-trip في أسوأ حال)
  // الآن: جلب كل البيانات الأساسية بالتوازي → وقت فحص أقل بكثير
  const [qs, stats, fcQuota, fcRate] = await Promise.all([
    getQueueStats().catch(() => ({ dlqSize: 0, highQueue: 0, normalQueue: 0, totalActiveJobs: 0 })),
    getDailyStats().catch(() => null),
    redis.get(FC_QUOTA_EXCEEDED_KEY).catch(() => null),
    redis.get(FC_RATE_LIMITED_KEY).catch(() => null),
  ]);

  // ── 1. فحص DLQ ────────────────────────────────
  if (qs.dlqSize >= DLQ_ALERT_THRESHOLD) {
    // BUG-D FIX: كان GET → sendToAdmins → setex منفصلَين
    // لو تأخّر runCheck أكثر من 5 دقائق وبدأت دورة جديدة قبل انتهائه:
    //   كلا الاستدعاءَين يقرآن last=0 → كلاهما يُرسلان نفس التنبيه مرتين
    // الحل: SET NX EX ذري — يكتب فقط إذا المفتاح غير موجود → واحد فقط ينجح
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
  if (stats && stats.downloads >= MIN_DOWNLOADS_TO_ALERT) {
    const pct = (stats.success / stats.downloads) * 100;
    if (pct < SUCCESS_ALERT_THRESHOLD) {
      const lockAcquired = await redis.set(LAST_SUCC_ALERT, String(now), "EX", ALERT_COOLDOWN_SEC, "NX").catch(() => null);
      if (lockAcquired === "OK") {
        await sendToAdmins(
          bot,
          `⚠️ *تنبيه: نسبة النجاح منخفضة*\n\n` +
          `📉 ${pct.toFixed(1)}% من التحميلات ناجحة اليوم\n` +
          `📥 ${stats.downloads} محاولة — ✅ ${stats.success} — ❌ ${stats.fail}\n\n` +
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

  // ── 4. فحص Firecrawl rate limit ───────────────
  if (fcRate) {
    // cooldown أقصر لأن rate limit مؤقت (120 ثانية) — تنبيه كل 10 دقائق كافٍ
    // IMP-6 FIX: TTL=700 > cooldown(600s) → منع تنبيهات مكررة عند انتهاء الـ key قبل الـ cooldown
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
}

/** يُستدعى مرة واحدة عند بدء البوت */
export function startAlertWatcher(bot: TelegramBot): void {
  const INTERVAL = 5 * 60 * 1000; // كل 5 دقائق

  // انتظر دقيقتين بعد البدء قبل أول فحص (يسمح لـ Redis بالاستقرار)
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
