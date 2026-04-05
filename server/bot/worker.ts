import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { dequeue, completeJob, failJob, recoverStuckJobs } from "./queue.js";
import { processBookRequest } from "./bookRequest.js";
import { QUEUE_WORKERS, TIMEOUT_JOB } from "./config.js";

// ══════════════════════════════════════════════
// WORKER — Queue consumer
//
// يشغّل N عاملاً (QUEUE_WORKERS) بالتوازي.
// كل عامل:
//  1. BRPOP من q:high ثم q:normal (بأولوية)
//  2. معالجة الـ job مع JOB_TIMEOUT
//  3. completeJob أو failJob
// ══════════════════════════════════════════════

let _running  = false;
let _workers: Promise<void>[] = [];
let _active   = 0;

export function activeWorkerCount(): number {
  return _active;
}

export function initWorkers(bot: TelegramBot): void {
  if (_running) {
    L.warn("worker", "initWorkers called while already running — ignoring");
    return;
  }
  _running = true;
  _active  = 0;

  // ── Crash recovery عند بدء التشغيل ──────────
  // BUG-2 FIX: كان fire-and-forget → العمال يبدأون قبل انتهاء الاسترداد
  // قد يُعالج العامل نفس الـ job مرتين: مرة من الاسترداد ومرة من الـ queue
  // الحل: نُشغّل الاسترداد أولاً بـ async IIFE ثم نُطلق العمال بعده
  (async () => {
    try {
      await recoverStuckJobs(bot);
    } catch (e) {
      L.error("worker", "recoverStuckJobs error", { err: String(e).slice(0, 100) });
    }
    // ── إطلاق N عامل بعد اكتمال الاسترداد ───────
    _workers = Array.from({ length: QUEUE_WORKERS }, (_, i) =>
      runWorker(bot, i)
    );
    L.info("worker", `${QUEUE_WORKERS} worker(s) started (after recovery)`);
  })();
}

export function stopWorkers(): void {
  _running = false;
  L.info("worker", "Workers signalled to stop");
}

// ── Worker loop ────────────────────────────────

async function runWorker(bot: TelegramBot, id: number): Promise<void> {
  L.info("worker", `Worker #${id} started`);

  while (_running) {
    let job = null;
    try {
      job = await dequeue();
    } catch (e) {
      // Redis خطأ مؤقت — انتظر ثانية قبل إعادة المحاولة
      await sleep(1000);
      continue;
    }

    if (!job) continue; // BRPOP timeout → حاول مجدداً

    _active++;
    L.queueProcess(job.id, job.userId, job.bookName);

    // ── JOB_TIMEOUT ────────────────────────────
    // يضمن أن الـ worker لا يتعلق بـ job واحد للأبد
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, rej) => {
      timeoutId = setTimeout(
        () => rej(new Error("JOB_TIMEOUT")),
        TIMEOUT_JOB
      );
    });

    try {
      await Promise.race([
        processBookRequest(bot, job),
        timeoutPromise,
      ]);
      await completeJob(job);
      L.queueDone(job.id, job.userId, job.bookName);
    } catch (e: any) {
      const err  = String(e?.message || e);
      const isTimeout = err.includes("JOB_TIMEOUT");

      L.error("worker", `Job ${job.id} failed: ${err.slice(0, 100)}`, {
        userId:   job.userId,
        book:     job.bookName.slice(0, 50),
        retries:  job.retries,
        isTimeout,
      });

      const wentToDLQ = await failJob(job, err.slice(0, 100));
      if (wentToDLQ) {
        // وصل للـ DLQ — أشعر المستخدم (failJob لم يُشعره)
        await bot.sendMessage(
          job.chatId,
          `❌ *لم أتمكن من إيجاد "${job.bookName.slice(0, 40)}"*\n\nحاول مرة أخرى لاحقاً.`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      _active = Math.max(0, _active - 1);
    }
  }

  L.info("worker", `Worker #${id} stopped`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
