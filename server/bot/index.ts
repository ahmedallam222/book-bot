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
let _started       = false;

export function activeWorkerCount(): number {
  return _workerCount;
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
    message: string; parse_mode?: string
  }) => {
    await broadcastToAll(payload.message, payload.parse_mode || "Markdown");
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

  L.info("bot", `${WORKER_COUNT} workers started`);

  // تشغيل مراقب التنبيهات
  startAlertWatcher(_bot);
}

// ── Worker loop ───────────────────────────────

function startWorker(workerId: number): void {
  _workerCount++;

  const loop = async () => {
    while (true) {
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

        const success = await processJobSafe(job);
        if (success) {
          await completeJob(job);
        } else {
          await failJob(job);
        }
      } catch (e) {
        L.error("worker", `Worker ${workerId} loop error`, { err: String(e).slice(0, 100) });
        await sleep(1000);
      }
    }
  };

  loop().catch((e) => {
    _workerCount--;
    L.error("worker", `Worker ${workerId} crashed`, { err: String(e).slice(0, 100) });
    // أعد تشغيل الـ worker بعد 5 ثوانٍ
    setTimeout(() => startWorker(workerId), 5000);
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

async function broadcastToAll(message: string, parseMode = "Markdown"): Promise<void> {
  if (!_bot) return;
  try {
    const userIds = await storage.getAllUserIds();
    L.adminAction("system", `broadcast to ${userIds.length} users`);

    let sent = 0, failed = 0;
    for (const uid of userIds) {
      try {
        await _bot.sendMessage(parseInt(uid, 10), message, {
          parse_mode: parseMode as any,
        });
        sent++;
        await sleep(50); // تجنب حد الـ rate limit لـ Telegram
      } catch {
        failed++;
      }
    }

    L.info("bot", `Broadcast done`, { sent, failed, total: userIds.length });
  } catch (e) {
    L.error("bot", `Broadcast error`, { err: String(e).slice(0, 100) });
  }
}

// ── Helpers ───────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Graceful shutdown ─────────────────────────
process.on("SIGTERM", async () => {
  L.info("bot", "SIGTERM received — shutting down...");
  if (_bot) await _bot.stopPolling().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(0);
});

process.on("SIGINT", async () => {
  L.info("bot", "SIGINT received — shutting down...");
  if (_bot) await _bot.stopPolling().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(0);
});
