import TelegramBot                    from "node-telegram-bot-api";
import { L }                          from "./logger.js";
import { redis }                      from "./redis.js";
import { registerCommands, registerMessageHandler } from "../bot/commands.js";
import { registerCallbackHandler }    from "../bot/callbacks.js";
import { dequeue, completeJob, failJob, recoverStuckJobs } from "./queue.js";
import { processBookRequest }         from "./bookRequest.js";
import { cleanOldTempFiles }          from "./tempFiles.js";
import { startAlertWatcher }          from "./alertWatcher.js";
import { storage }                    from "../storage.js";
import { announceMaintenanceEnd }     from "./maintenanceAnnounce.js";
import { listPremiumUsers }           from "./userSettings.js";
import { shutdownNoorBookBrowser }    from "./noorBookResolver.js";
import type { QueueJob }              from "./types.js";

// ══════════════════════════════════════════════
// INDEX — نقطة بدء البوت والـ Workers
// ══════════════════════════════════════════════

const BOT_TOKEN     = process.env.BOT_TOKEN || "";
const WORKER_COUNT  = parseInt(process.env.WORKER_COUNT || "3", 10);
const POLL_INTERVAL = 500; // ms

let _bot:          TelegramBot | null = null;
let _botUsername   = "";
let _botId         = 0;
let _workerCount   = 0;
let _activeJobs    = 0;
let _started       = false;
let _shuttingDown  = false;

export function activeWorkerCount(): number {
  return _workerCount;
}

export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/**
 * Graceful shutdown:
 *   1. مَنع dequeue jobs جديدة
 *   2. أوقِف Telegram polling
 *   3. انتظر الـ jobs النشطة حالياً تنتهي (حتى timeoutMs)
 *   4. أعِد Q_ACTIVE entries إلى الطابور (لو فشلنا في إنهائهم في الوقت)
 */
export async function gracefulShutdown(timeoutMs = 30_000): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  L.info("bot", "Graceful shutdown initiated");

  if (_bot) {
    try { await _bot.stopPolling({ cancel: true }); }
    catch (e) { L.warn("bot", "stopPolling failed", { err: String(e).slice(0, 80) }); }
  }

  const deadline = Date.now() + timeoutMs;
  while (_activeJobs > 0 && Date.now() < deadline) {
    L.info("bot", `Waiting for ${_activeJobs} active jobs to finish...`);
    await sleep(500);
  }

  if (_activeJobs > 0) {
    L.warn("bot", `Shutdown timeout: ${_activeJobs} jobs still active — they will be recovered on next start`);
  } else {
    L.info("bot", "All workers idle");
  }

  // أغلق noor-book Playwright browser لو لسه شغّال (idle close timer قد يكون
  // بعيد). بدونه، Chromium child process يبقى لحظة قبل ما الـ exit يقتله من
  // الـ OS، وتظهر warnings عن orphan processes في الـ container logs.
  try { await shutdownNoorBookBrowser(); }
  catch (e) { L.warn("bot", "shutdownNoorBookBrowser failed", { err: String(e).slice(0, 80) }); }
}

// ── startBot ──────────────────────────────────

export async function startBot(): Promise<void> {
  if (_started) return;
  _started = true;

  if (!BOT_TOKEN) {
    L.error("bot", "BOT_TOKEN not set — bot will not start");
    return;
  }

  L.info("bot", "Starting Kholasa Books bot...");

  _bot = new TelegramBot(BOT_TOKEN, { polling: true });

  // جلب معلومات البوت
  try {
    const me   = await _bot.getMe();
    _botUsername = me.username || "";
    _botId       = me.id;
    L.info("bot", `Bot started: @${_botUsername} (${_botId})`);
  } catch (e) {
    L.error("bot", `getMe failed: ${String(e).slice(0, 80)}`);
  }

  // تسجيل handlers
  registerCommands(_bot, BOT_TOKEN, () => _botUsername, () => _botId);
  registerMessageHandler(_bot, BOT_TOKEN, () => _botUsername);
  registerCallbackHandler(_bot, BOT_TOKEN);

  // استماع لأحداث البث من الـ dashboard
  (process as NodeJS.EventEmitter).on("dashboard:broadcast", async (payload: {
    message: string; parse_mode?: string; target?: string
  }) => {
    await broadcastToAll(payload.message, payload.parse_mode || "Markdown", payload.target || "all");
  });

  // استماع لإنهاء الصيانة من الـ dashboard — يبعث إعلان للجروبات
  (process as NodeJS.EventEmitter).on("bot:maintenance_ended", async () => {
    if (!_bot) return;
    try {
      await announceMaintenanceEnd(_bot);
    } catch (e) {
      L.error("bot", "announceMaintenanceEnd (event) failed", { err: String(e).slice(0, 100) });
    }
  });

  // FIX v29: استرجاع الـ jobs العالقة من الـ restart السابق
  // يجب أن يكون قبل تشغيل الـ workers لأنهم قد يلتقطون jobs مباشرة
  await recoverStuckJobs().catch((e) =>
    L.error("bot", "recoverStuckJobs failed", { err: String(e).slice(0, 80) })
  );

  // تشغيل Workers
  for (let i = 0; i < WORKER_COUNT; i++) {
    startWorker(i + 1);
  }

  // تنظيف الملفات المؤقتة كل ساعة
  setInterval(() => cleanOldTempFiles(), 3_600_000).unref();

  // تنظيف صفوف daily_limits الأقدم من 7 أيام كل 24 ساعة
  // (الجدول كان يكبر للأبد قبل ذلك — 10K مستخدم × 365 يوم بعد سنة)
  const runDailyLimitsCleanup = async (): Promise<void> => {
    try {
      const deleted = await storage.cleanupOldDailyLimits();
      if (deleted > 0) L.info("cleanup", `Deleted ${deleted} old daily_limits rows`);
    } catch (e) {
      L.error("cleanup", "daily_limits cleanup failed", { err: String(e).slice(0, 120) });
    }
  };
  // أول تشغيل بعد دقيقة (نسمح للـ DB connection يستقر) ثم كل 24 ساعة
  setTimeout(runDailyLimitsCleanup, 60_000).unref();
  setInterval(runDailyLimitsCleanup, 24 * 3_600_000).unref();

  L.info("bot", `${WORKER_COUNT} workers started`);

  // تشغيل مراقب التنبيهات
  startAlertWatcher(_bot);
}

// ── Worker loop ───────────────────────────────

function startWorker(workerId: number): void {
  _workerCount++;

  const loop = async () => {
    while (!_shuttingDown) {
      try {
        const job = await dequeue();
        if (!job) {
          await sleep(POLL_INTERVAL);
          continue;
        }

        L.info("worker", `Processing job`, {
          worker: workerId, jobId: job.id,
          book: job.bookName.slice(0, 50), userId: job.userId
        });

        _activeJobs++;
        try {
          const success = await processJobSafe(job);
          if (success) {
            await completeJob(job);
          } else {
            await failJob(job);
          }
        } finally {
          _activeJobs--;
        }
      } catch (e) {
        L.error("worker", `Worker ${workerId} loop error`, { err: String(e).slice(0, 100) });
        await sleep(1000);
      }
    }
    L.info("worker", `Worker ${workerId} exited (shutdown)`);
  };

  loop().catch((e) => {
    _workerCount--;
    L.error("worker", `Worker ${workerId} crashed`, { err: String(e).slice(0, 100) });
    // لا تُعِد التشغيل أثناء الإغلاق — اسمح للـ process بالخروج
    if (!_shuttingDown) {
      setTimeout(() => startWorker(workerId), 5000);
    }
  });
}

async function processJobSafe(job: QueueJob): Promise<boolean> {
  if (!_bot) return false;
  try {
    await processBookRequest(_bot, job);
    return true;
  } catch (e) {
    L.error("worker", `processBookRequest threw`, {
      jobId: job.id, err: String(e).slice(0, 150)
    });
    return false;
  }
}

// ── Broadcast ─────────────────────────────────

async function resolveBroadcastTargets(target: string): Promise<string[]> {
  if (target === "premium") {
    return await listPremiumUsers();
  }
  if (target === "active7") {
    // المستخدمون الذين أرسلوا بحثاً خلال آخر 7 أيام
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    try {
      const ids = await redis.zrangebyscore("user:lastSeen", since, "+inf");
      if (ids?.length) return ids;
    } catch { /* fallback below */ }
    // fallback: كل المستخدمين
    return await storage.getAllUserIds();
  }
  return await storage.getAllUserIds();
}

async function broadcastToAll(message: string, parseMode = "Markdown", target = "all"): Promise<void> {
  if (!_bot) return;
  try {
    const userIds = await resolveBroadcastTargets(target);
    L.adminAction("system", `broadcast to ${userIds.length} users [target=${target}]`);

    let sent = 0, failed = 0;
    for (const uid of userIds) {
      try {
        await _bot.sendMessage(parseInt(uid, 10), message, {
          parse_mode: parseMode as any,
          disable_web_page_preview: true,
        });
        sent++;
        await sleep(50); // تجنب حد الـ rate limit لـ Telegram
      } catch {
        failed++;
      }
    }

    L.info("bot", `Broadcast done`, { sent, failed, total: userIds.length, target });
  } catch (e) {
    L.error("bot", `Broadcast error`, { err: String(e).slice(0, 100) });
  }
}

// ── Helpers ───────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Graceful shutdown ─────────────────────────
//
// لا نسجّل process.on("SIGTERM"|"SIGINT") هنا — التعامل مع إشارات النظام
// مسؤولية server/index.ts فقط، ويستدعي gracefulShutdown() أعلاه قبل
// process.exit. الـ duplicate handlers السابقة كانت تستدعي process.exit(0)
// مباشرة بدون انتظار _activeJobs، مما يكسر الـ graceful-shutdown logic
// لأن Node.js يُشغّل جميع الـ handlers المُسجّلة بالتوازي، وأول واحد يصل
// لـ process.exit يُنهي العملية.
