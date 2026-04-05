import { randomUUID } from "crypto";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import type { QueueJob, QueueJobStatus } from "./types.js";
import {
  QUEUE_HIGH_KEY, QUEUE_NORMAL_KEY, QUEUE_DLQ_KEY,
  QUEUE_JOBS_HASH, QUEUE_USER_PENDING_KEY,
  QUEUE_JOB_TTL_SEC, QUEUE_MAX_PER_USER, QUEUE_MAX_RETRIES,
} from "./config.js";

// ══════════════════════════════════════════════
// QUEUE ENGINE — نظام طابور بـ Redis Lists
//
// البنية:
//  q:high   → Redis List (LPUSH / BRPOP) للمستخدمين المميزين
//  q:normal → Redis List للمستخدمين العاديين
//  q:dlq    → Dead Letter Queue (فشل نهائي)
//  q:jobs   → Redis Hash { jobId: JSON }
//  q:user:<id>:pending → عداد الطلبات المعلّقة لكل مستخدم
//  q:user:<id>:jobs    → Set لـ job IDs (index سريع لـ cancelUserJobs)
// ══════════════════════════════════════════════

// ── Helpers ──────────────────────────────────

export async function getJob(jobId: string): Promise<QueueJob | null> {
  const raw = await redis.hget(QUEUE_JOBS_HASH, jobId).catch(() => null);
  return raw ? (JSON.parse(raw) as QueueJob) : null;
}

// P2-4: overload يقبل job موجود — يتجنب hget إضافي لمن عنده الكائن مسبقاً
export async function updateJobStatus(jobId: string, status: QueueJobStatus, extra?: Partial<QueueJob>): Promise<void>;
export async function updateJobStatus(job: QueueJob, status: QueueJobStatus, extra?: Partial<QueueJob>): Promise<void>;
export async function updateJobStatus(
  jobOrId: string | QueueJob,
  status: QueueJobStatus,
  extra: Partial<QueueJob> = {}
): Promise<void> {
  let job: QueueJob | null;
  if (typeof jobOrId === "string") {
    job = await getJob(jobOrId);
    if (!job) return;
  } else {
    job = jobOrId;
  }
  const updated: QueueJob = { ...job, ...extra, status };
  await redis.hset(QUEUE_JOBS_HASH, job.id, JSON.stringify(updated));
}

// ── Enqueue ───────────────────────────────────

export interface EnqueueResult {
  ok: boolean;
  jobId?: string;
  position?: number;
  reason?: "maintenance" | "user_limit" | "already_processing";
}

export async function enqueue(
  userId: string,
  chatId: number,
  bookName: string,
  token: string,
  priority: "high" | "normal",
  userName?: string | null
): Promise<EnqueueResult> {
  // ── فحص حد المستخدم المعلّق (atomic via Lua) ───
  // BUG FIX: الـ check والـ INCR الآن في Lua واحدة → atomic حقيقي
  // قبل: GET خارج Lua + INCR في pipeline منفصلة → race condition ممكن
  const pendingKey = QUEUE_USER_PENDING_KEY(userId);
  const luaCheckAndIncr = `
    local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
    if cur >= tonumber(ARGV[1]) then return -1 end
    redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
    return cur
  `;
  const preCheck = await redis.eval(
    luaCheckAndIncr, 1,
    pendingKey,
    String(QUEUE_MAX_PER_USER),
    String(QUEUE_JOB_TTL_SEC)
  ) as number;
  if (preCheck === -1) {
    return { ok: false, reason: "user_limit" };
  }

  const jobId = randomUUID();
  // ⚠️ SECURITY: token (Telegram bot token) لا يُخزَّن في Redis أبداً
  // يُحقَن فقط عند dequeue() من process.env — القيمة المخزنة في Redis خالية منه
  const jobForRedis: Omit<QueueJob, "token"> = {
    id: jobId,
    userId,
    chatId,
    bookName,
    userName,
    priority,
    status: "pending",
    retries: 0,
    createdAt: Date.now(),
  };

  const queueKey    = priority === "high" ? QUEUE_HIGH_KEY : QUEUE_NORMAL_KEY;
  const userJobsKey = `q:user:${userId}:jobs`;

  try {
    await redis
      .pipeline()
      .hset(QUEUE_JOBS_HASH, jobId, JSON.stringify(jobForRedis))
      .lpush(queueKey, jobId)
      // INCR للـ pendingKey يحصل في Lua أعلاه — لا نُعيده هنا
      .setex(`q:ttl:${jobId}`, QUEUE_JOB_TTL_SEC, "1")
      .sadd(userJobsKey, jobId)
      .expire(userJobsKey, 7 * 24 * 3600)
      .exec();
  } catch (pipeErr) {
    // FIX: Lua أعلاه زاد pendingKey بنجاح، لكن الـ pipeline فشل
    // → Job لم يُضَف للقائمة أبداً، لكن العداد مرتفع → المستخدم محجوب 10 دقائق
    // الحل: نُنقص العداد لإعادة الحالة الصحيحة قبل الـ throw
    try {
      const v = await redis.decr(pendingKey);
      if (v <= 0) await redis.del(pendingKey);
    } catch { /* إذا فشل Redis أيضاً — التنظيف سيحصل بعد انتهاء TTL */ }
    throw pipeErr; // أعد الـ throw — المستدعي سيُعالج الخطأ
  }

  const position = await getQueuePosition(priority);

  L.queueEnqueue(jobId, userId, bookName, priority, position);
  return { ok: true, jobId, position };
}

// ── Dequeue (BRPOP بأولوية — HIGH أولاً ثم NORMAL) ──

export async function dequeue(): Promise<QueueJob | null> {
  const result = await redis.brpop(QUEUE_HIGH_KEY, QUEUE_NORMAL_KEY, 1);
  if (!result) return null;

  const [, jobId] = result;

  // FIX BUG-3: عند انتهاء TTL الـ job، كان pending counter يبقى مرتفعاً للأبد
  // الآن نجلب userId من الهاش ونُنقص العداد قبل الـ return
  // P2-1: دمج exists(ttl) + hget(job) في pipeline واحدة — توفير round-trip واحد لكل dequeue
  const [ttlResult, jobResult] = await redis
    .pipeline()
    .exists(`q:ttl:${jobId}`)
    .hget(QUEUE_JOBS_HASH, jobId)
    .exec() as [Error | null, number][];

  const ttlExists = (ttlResult as any)?.[1] as number;
  const jobRaw    = (jobResult  as any)?.[1] as string | null;

  if (!ttlExists) {
    L.info("queue", `Job ${jobId} TTL expired, skipping`);
    if (jobRaw) {
      try {
        const expiredJob = JSON.parse(jobRaw) as QueueJob;
        const pk = QUEUE_USER_PENDING_KEY(expiredJob.userId);
        const v  = await redis.decr(pk);
        if (v <= 0) await redis.del(pk);
      } catch {}
    }
    await redis.hdel(QUEUE_JOBS_HASH, jobId);
    return null;
  }

  const job = jobRaw ? (JSON.parse(jobRaw) as QueueJob) : null;

  // FIX BUG-4: الـ cancelled jobs لم تكن تُنقص pending counter → المستخدم يُحجب
  if (!job || job.status === "cancelled") {
    if (job?.status === "cancelled") {
      const pk = QUEUE_USER_PENDING_KEY(job.userId);
      const v  = await redis.decr(pk);
      if (v <= 0) await redis.del(pk);
    }
    await redis.hdel(QUEUE_JOBS_HASH, jobId);
    return null;
  }

  const updated: QueueJob = { ...job, status: "processing", startedAt: Date.now() };
  // أضف الـ token من env (لم يُخزَّن في Redis لأسباب أمنية)
  updated.token = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  await redis.hset(QUEUE_JOBS_HASH, jobId, JSON.stringify({ ...updated, token: undefined }));
  return updated;
}

// ── Complete / Fail ───────────────────────────

export async function completeJob(job: QueueJob): Promise<void> {
  const userJobsKey = `q:user:${job.userId}:jobs`;
  await redis
    .pipeline()
    .hdel(QUEUE_JOBS_HASH, job.id)
    .del(`q:ttl:${job.id}`)
    .srem(userJobsKey, job.id)
    .exec();
  const pendingKey = QUEUE_USER_PENDING_KEY(job.userId);
  const v = await redis.decr(pendingKey);
  if (v <= 0) await redis.del(pendingKey);
}

// FIX-v10-C: failJob يُعيد boolean:
//   true  = وصل DLQ (فشل نهائي بعد كل المحاولات)
//   false = أُعيد للقائمة (retry لا يزال ممكناً)
// يُغني worker.ts عن getJob إضافي بعد الاستدعاء
export async function failJob(job: QueueJob, reason: string): Promise<boolean> {
  if (job.retries < QUEUE_MAX_RETRIES) {
    const retried: QueueJob = { ...job, status: "pending", retries: job.retries + 1 };
    const qKey = job.priority === "high" ? QUEUE_HIGH_KEY : QUEUE_NORMAL_KEY;
    await redis
      .pipeline()
      .hset(QUEUE_JOBS_HASH, job.id, JSON.stringify(retried))
      .rpush(qKey, job.id)
      .setex(`q:ttl:${job.id}`, QUEUE_JOB_TTL_SEC, "1")
      .exec();
    L.info("queue", `Job ${job.id} retry ${retried.retries}/${QUEUE_MAX_RETRIES}`);
    return false; // لم يصل DLQ — لا تُرسل رسالة نهائية للمستخدم
  } else {
    // FIX-v10-C idempotency: لو كان status=failed بالفعل لا نُضيفه للـ DLQ مرة ثانية
    const existing = await redis.hget(QUEUE_JOBS_HASH, job.id).catch(() => null);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as QueueJob;
        if (parsed.status === "failed") {
          L.warn("queue", `failJob called twice for job ${job.id} — skipping DLQ re-add`);
          return true; // job فاشل بالفعل
        }
      } catch {}
    }
    const failed: QueueJob = { ...job, status: "failed", failReason: reason };
    const DLQ_TTL       = 24 * 60 * 60;
    const userJobsKey   = `q:user:${job.userId}:jobs`;
    const pendingKey    = QUEUE_USER_PENDING_KEY(job.userId);
    // BUG-4 FIX: DLQ branch لم يكن يُنظّف userJobsKey → Set يكبر للأبد
    await redis
      .pipeline()
      .hset(QUEUE_JOBS_HASH, job.id, JSON.stringify(failed))
      .lpush(QUEUE_DLQ_KEY, job.id)
      .ltrim(QUEUE_DLQ_KEY, 0, 199)
      .setex(`q:ttl:${job.id}`, DLQ_TTL, "1")
      .srem(userJobsKey, job.id)   // ← تنظيف index المستخدم
      .exec();
    const v = await redis.decr(pendingKey);
    if (v <= 0) await redis.del(pendingKey);
    L.info("queue", `Job ${job.id} → DLQ: ${reason.slice(0, 80)}`);
    return true; // وصل DLQ — أرسل رسالة نهائية للمستخدم
  }
}

export async function cancelUserJobs(userId: string): Promise<number> {
  const userJobsKey = `q:user:${userId}:jobs`;
  const jobIds = await redis.smembers(userJobsKey).catch(() => [] as string[]);
  if (jobIds.length === 0) return 0;

  // FIX BUG-2: كان N+1 Redis round-trips (hget داخل for loop) → pipeline واحدة الآن
  const fetchPipe = redis.pipeline();
  for (const jid of jobIds) fetchPipe.hget(QUEUE_JOBS_HASH, jid);
  const fetched = (await fetchPipe.exec().catch(() => [])) as [Error | null, string | null][];

  let cancelled = 0;
  const writePipe = redis.pipeline();

  for (let i = 0; i < jobIds.length; i++) {
    const jid = jobIds[i];
    const raw = fetched[i]?.[1];

    if (!raw) { writePipe.srem(userJobsKey, jid); continue; }

    let j: QueueJob;
    try { j = JSON.parse(raw) as QueueJob; }
    catch { writePipe.srem(userJobsKey, jid); continue; }

    if (j.status === "pending") {
      writePipe.hset(QUEUE_JOBS_HASH, jid, JSON.stringify({ ...j, status: "cancelled" }));
      cancelled++;
    }
    if (j.status !== "pending" && j.status !== "processing") {
      writePipe.srem(userJobsKey, jid);
    }
  }
  writePipe.del(QUEUE_USER_PENDING_KEY(userId));
  await writePipe.exec().catch(() => {});
  return cancelled;
}

// ── Stats ─────────────────────────────────────

export interface QueueStats {
  highQueue:       number;
  normalQueue:     number;
  dlqSize:         number;
  totalActiveJobs: number;
}

export async function getQueueStats(): Promise<QueueStats> {
  const [high, normal, dlq, total] = await redis
    .pipeline()
    .llen(QUEUE_HIGH_KEY)
    .llen(QUEUE_NORMAL_KEY)
    .llen(QUEUE_DLQ_KEY)
    .hlen(QUEUE_JOBS_HASH)
    .exec() as any[];

  return {
    highQueue:       high?.[1]   ?? 0,
    normalQueue:     normal?.[1] ?? 0,
    dlqSize:         dlq?.[1]    ?? 0,
    totalActiveJobs: total?.[1]  ?? 0,
  };
}

export async function getQueuePosition(priority: "high" | "normal"): Promise<number> {
  const key = priority === "high" ? QUEUE_HIGH_KEY : QUEUE_NORMAL_KEY;
  // H1 FIX: الـ job مضافة للقائمة قبل استدعاء هذه الدالة → llen يشملها → بدون +1
  return await redis.llen(key);
}

export async function clearQueues(): Promise<void> {
  await redis.pipeline().del(QUEUE_HIGH_KEY).del(QUEUE_NORMAL_KEY).exec();
  // ملاحظة: pending counters ستنتهي صلاحيتها تلقائياً بعد QUEUE_JOB_TTL_SEC
  L.info("queue", "All queues cleared by admin");
}

export async function clearDLQ(): Promise<void> {
  await redis.del(QUEUE_DLQ_KEY);
}

// ── Crash Recovery ────────────────────────────
// يُستدعى عند بدء الـ Workers — يُعيد jobs العالقة في "processing" للقائمة
// (تحدث عند crash أو restart مفاجئ أثناء معالجة job)
export async function recoverStuckJobs(bot?: import("node-telegram-bot-api").default): Promise<void> {
  try {
    const allJobIds = await redis.hkeys(QUEUE_JOBS_HASH);
    if (allJobIds.length === 0) return;

    // C3 FIX: pipeline واحدة لجلب كل الـ jobs — بدل N+1 round-trips
    const fetchPipe = redis.pipeline();
    for (const id of allJobIds) fetchPipe.hget(QUEUE_JOBS_HASH, id);
    const fetched = (await fetchPipe.exec().catch(() => [])) as [Error | null, string | null][];
    // pipeline للكتابة (re-queue أو DLQ)
    const writePipe  = redis.pipeline();
    const toDecr: string[] = []; // pendingKeys تحتاج DECR منفصل (لا يدعم DECRBY مشروط في pipeline)
    let recovered = 0;
    // BUG FIX: jobs ذهبت للـ DLQ بسبب restart — يجب إشعار المستخدمين
    const dlqNotifications: { chatId: number; bookName: string }[] = [];

    for (let i = 0; i < allJobIds.length; i++) {
      const jobId = allJobIds[i];
      const raw   = fetched[i]?.[1];
      if (!raw) continue;

      let job: QueueJob;
      try { job = JSON.parse(raw) as QueueJob; } catch { continue; }
      if (job.status !== "processing") continue;

      if (job.retries >= QUEUE_MAX_RETRIES) {
        // وصل للحد الأقصى → DLQ مباشرة
        const userJobsKey = `q:user:${job.userId}:jobs`;
        writePipe
          .hset(QUEUE_JOBS_HASH, jobId, JSON.stringify({ ...job, status: "failed", failReason: "stuck_processing_on_restart" }))
          .lpush(QUEUE_DLQ_KEY, jobId)
          .ltrim(QUEUE_DLQ_KEY, 0, 199)
          // BUG-3 FIX: كانت recoverStuckJobs لا تُزيل jobId من userJobsKey عند إرسال Job للـ DLQ
          // → Set تتراكم entries فاسدة بحالة "failed" بعد كل crash+restart
          // → cancelUserJobs تستعلم عنها عبثاً ثم تُنظّفها — تحسين: ننظّف هنا مباشرة
          .srem(userJobsKey, jobId);
        toDecr.push(QUEUE_USER_PENDING_KEY(job.userId));
        // BUG FIX: أضف للقائمة المراد إشعارها
        dlqNotifications.push({ chatId: job.chatId, bookName: job.bookName });
      } else {
        const retried: QueueJob = { ...job, status: "pending", retries: job.retries + 1 };
        const qKey = job.priority === "high" ? QUEUE_HIGH_KEY : QUEUE_NORMAL_KEY;
        writePipe
          .hset(QUEUE_JOBS_HASH, jobId, JSON.stringify(retried))
          .rpush(qKey, jobId)
          .setex(`q:ttl:${jobId}`, QUEUE_JOB_TTL_SEC, "1");
        recovered++;
      }
      L.info("queue", `Recovery: job ${jobId} → ${job.retries >= QUEUE_MAX_RETRIES ? "DLQ" : "re-queued"} (retries=${job.retries})`);
    }

    if (recovered > 0 || toDecr.length > 0) {
      await writePipe.exec().catch(() => {});
      // DECR للـ pending counters (لا يمكن دمجها في pipeline مشروط)
      for (const pk of toDecr) {
        const v = await redis.decr(pk).catch(() => 0);
        if (v <= 0) await redis.del(pk).catch(() => {});
      }
    }

    // BUG FIX: أشعر المستخدمين الذين ذهبت طلباتهم للـ DLQ بسبب الـ restart
    if (bot && dlqNotifications.length > 0) {
      for (const { chatId, bookName } of dlqNotifications) {
        bot.sendMessage(
          chatId,
          `⚠️ *انقطع الاتصال مؤقتاً*\n\n📚 _${bookName.slice(0, 50)}_\n\nأعد كتابة اسم الكتاب وسأبحث مجدداً 🔄`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }

    if (recovered > 0) L.info("queue", `Crash recovery complete: ${recovered} job(s) re-queued`);
    if (dlqNotifications.length > 0) L.info("queue", `Recovery DLQ notifications sent: ${dlqNotifications.length}`);
  } catch (e) {
    L.warn("queue", `recoverStuckJobs error: ${String(e).slice(0, 100)}`);
  }
}

// FIX BUG-5: كان N+1 Redis round-trips (hget لكل job) → pipeline واحدة الآن
export async function getDLQJobs(limit = 20): Promise<QueueJob[]> {
  const ids = await redis.lrange(QUEUE_DLQ_KEY, 0, limit - 1);
  if (ids.length === 0) return [];

  const pipe = redis.pipeline();
  for (const id of ids) pipe.hget(QUEUE_JOBS_HASH, id);
  const results = (await pipe.exec()) as [Error | null, string | null][];

  const jobs: QueueJob[] = [];
  for (const [, raw] of results) {
    if (raw) { try { jobs.push(JSON.parse(raw)); } catch {} }
  }
  return jobs;
}
