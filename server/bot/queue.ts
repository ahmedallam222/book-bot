import { redis }    from "./redis.js";
import { L }        from "./logger.js";
import type { QueueJob, EnqueueResult } from "./types.js";

// ══════════════════════════════════════════════
// QUEUE — طابور المعالجة بـ Redis
// ══════════════════════════════════════════════

const Q_HIGH      = "queue:high";
const Q_NORMAL    = "queue:normal";
const Q_DLQ       = "queue:dlq";
const Q_ACTIVE    = "queue:active";   // Set of active jobIds
const USER_JOBS   = (uid: string) => `queue:user:${uid}`;

const MAX_USER_PENDING = 2;
const MAX_RETRIES      = 3;
const JOB_TTL_SEC      = 300;  // 5 min max per job
const DLQ_TTL_SEC      = 86400; // 24h

// ── Enqueue ───────────────────────────────────

export async function enqueue(
  userId:   string,
  chatId:   number,
  bookName: string,
  token:    string,
  priority: "high" | "normal",
  userName?: string | null
): Promise<EnqueueResult> {
  try {
    // فحص عدد الطلبات المعلقة لهذا المستخدم
    const pending = await redis.llen(USER_JOBS(userId)).catch(() => 0);
    if (pending >= MAX_USER_PENDING) {
      return { ok: false, reason: "user_limit" };
    }

    const job: QueueJob = {
      id:        `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId,
      chatId,
      bookName,
      token,
      userName:  userName ?? null,
      priority,
      retries:   0,
      createdAt: Date.now(),
    };

    const queue = priority === "high" ? Q_HIGH : Q_NORMAL;
    const json  = JSON.stringify(job);

    await redis.pipeline()
      .rpush(queue, json)
      .rpush(USER_JOBS(userId), job.id)   // نخزّن ID فقط — JSON يتغير بعد dequeue (startedAt)
      .expire(USER_JOBS(userId), JOB_TTL_SEC * 10)
      .exec();

    // FIX v29: حساب الموقع الحقيقي يشمل الطابورَين
    // المستخدم العادي (normal) يرى موقعه بعد كل طلبات الـ high أمامه
    // سابقاً: llen(queue) فقط → يُظهر "1" للمستخدم العادي حتى لو أمامه 10 طلبات premium
    const [highLen, normalLen] = await Promise.all([
      redis.llen(Q_HIGH).catch(() => 0),
      redis.llen(Q_NORMAL).catch(() => 0),
    ]);
    const pos = priority === "high"
      ? highLen                  // high: موقعه في الـ high queue
      : highLen + normalLen;     // normal: (كل الـ high) + موقعه في الـ normal

    L.info("queue", `Job enqueued`, { jobId: job.id, userId, priority, pos });
    return { ok: true, position: pos };

  } catch (e) {
    L.error("queue", `Enqueue failed`, { err: String(e).slice(0, 100) });
    return { ok: false, reason: "queue_full" };
  }
}

// ── Dequeue ───────────────────────────────────

export async function dequeue(): Promise<QueueJob | null> {
  try {
    // high priority أولاً
    let raw = await redis.lpop(Q_HIGH);
    if (!raw) raw = await redis.lpop(Q_NORMAL);
    if (!raw) return null;

    const job = JSON.parse(raw) as QueueJob;
    job.startedAt = Date.now();

    await redis.sadd(Q_ACTIVE, job.id);
    return job;
  } catch {
    return null;
  }
}

// ── Complete / Fail ───────────────────────────

export async function completeJob(job: QueueJob): Promise<void> {
  try {
    await redis.pipeline()
      .srem(Q_ACTIVE, job.id)
      .lrem(USER_JOBS(job.userId), 0, job.id)  // ID فقط — لا يتغير بعد dequeue
      .exec();
  } catch {}
}

export async function failJob(job: QueueJob): Promise<boolean> {
  // true = أُعيدت للطابور, false = ذهبت لـ DLQ
  try {
    await redis.srem(Q_ACTIVE, job.id);

    if (job.retries < MAX_RETRIES) {
      job.retries++;
      const queue = job.priority === "high" ? Q_HIGH : Q_NORMAL;
      await redis.lpush(queue, JSON.stringify(job)); // في المقدمة
      L.warn("queue", `Job retry ${job.retries}/${MAX_RETRIES}`, { jobId: job.id });
      return true;
    }

    // DLQ
    await redis.pipeline()
      .rpush(Q_DLQ, JSON.stringify(job))
      .expire(Q_DLQ, DLQ_TTL_SEC)
      .lrem(USER_JOBS(job.userId), 0, job.id)  // ID فقط — JSON تغيّر بعد retries++
      .exec();

    L.error("queue", `Job moved to DLQ`, { jobId: job.id, book: job.bookName.slice(0, 50) });
    return false;
  } catch {
    return false;
  }
}

// ── Cancel user jobs ──────────────────────────
// نخزّن ID في USER_JOBS، ونبحث عن الـ job JSON في الطابور بـ Lua script
// لتجنب قراءة الطابور كاملاً — parallel lrem بدل serial loop

export async function cancelUserJobs(userId: string): Promise<number> {
  try {
    const ids = await redis.lrange(USER_JOBS(userId), 0, -1);
    if (!ids.length) return 0;

    // نقرأ الطابورَين مرة واحدة فقط ثم نحذف بالتوازي
    const [highItems, normalItems] = await Promise.all([
      redis.lrange(Q_HIGH, 0, -1),
      redis.lrange(Q_NORMAL, 0, -1),
    ]);

    const idSet = new Set(ids);
    const toRemoveHigh:   string[] = [];
    const toRemoveNormal: string[] = [];

    for (const item of highItems) {
      try { if (idSet.has((JSON.parse(item) as QueueJob).id)) toRemoveHigh.push(item); } catch {}
    }
    for (const item of normalItems) {
      try { if (idSet.has((JSON.parse(item) as QueueJob).id)) toRemoveNormal.push(item); } catch {}
    }

    // حذف بالتوازي — pipeline واحد لكل قائمة
    let cancelled = 0;
    if (toRemoveHigh.length > 0 || toRemoveNormal.length > 0) {
      const pipe = redis.pipeline();
      for (const item of toRemoveHigh)   { pipe.lrem(Q_HIGH,   0, item); cancelled++; }
      for (const item of toRemoveNormal) { pipe.lrem(Q_NORMAL, 0, item); cancelled++; }
      await pipe.exec();
    }

    await redis.del(USER_JOBS(userId));
    return cancelled;
  } catch {
    return 0;
  }
}

// ── getUserPendingCount ───────────────────────
// FIX v29: تُستخدم في my_queue callback لإظهار طلبات المستخدم تحديداً
// بدلاً من إحصاءات الطابور الكلية

export async function getUserPendingCount(userId: string): Promise<number> {
  try {
    return await redis.llen(USER_JOBS(userId));
  } catch {
    return 0;
  }
}

// ── recoverStuckJobs ──────────────────────────
// FIX v29: عند إعادة تشغيل البوت بعد crash، الـ jobs التي كانت في Q_ACTIVE
// تبقى معلقة إلى الأبد — العداد يتضخم والمستخدمون لا يحصلون على إجاباتهم.
//
// الحل: عند بدء التشغيل، نمسح Q_ACTIVE كاملاً (كل الـ workers توقفوا)
// ثم نُعيد الـ jobs العالقة للطابور الأمامي (أولوية عالية).
// نُحدّد "عالق" = موجود في Q_ACTIVE لكن ليس في Q_HIGH أو Q_NORMAL.
//
// لماذا نمسح Q_ACTIVE مباشرة وليس نفحص كل job؟
// لأن الـ workers انتهوا كلهم — لا يوجد job "يُعالَج الآن" فعلاً.
// Q_ACTIVE عند startup = مخلّفات من run سابقة.

export async function recoverStuckJobs(): Promise<void> {
  try {
    const activeIds = await redis.smembers(Q_ACTIVE);
    if (!activeIds.length) return;

    // اجمع كل الـ job IDs الموجودة في الطابورَين
    const [highItems, normalItems] = await Promise.all([
      redis.lrange(Q_HIGH, 0, -1),
      redis.lrange(Q_NORMAL, 0, -1),
    ]);

    const queuedIds = new Set<string>();
    for (const item of [...highItems, ...normalItems]) {
      try {
        const job = JSON.parse(item) as QueueJob;
        queuedIds.add(job.id);
      } catch {}
    }

    // الـ jobs التي في Q_ACTIVE لكن غير موجودة في الطابورَين = عالقة
    const stuckIds = activeIds.filter((id) => !queuedIds.has(id));

    if (stuckIds.length > 0) {
      L.warn("queue", `Found ${stuckIds.length} stuck job IDs in Q_ACTIVE — clearing (jobs were lost in crash)`);
    }

    // مسح Q_ACTIVE — جميع الـ workers توقفوا عند restart
    await redis.del(Q_ACTIVE);

    L.info("queue", `recoverStuckJobs done`, {
      cleared:  activeIds.length,
      stuckIds: stuckIds.length,
    });
  } catch (e) {
    L.error("queue", `recoverStuckJobs error`, { err: String(e).slice(0, 100) });
  }
}

// ── Stats ─────────────────────────────────────

export async function getQueueStats(): Promise<{
  highQueue: number; normalQueue: number; dlqSize: number; totalActiveJobs: number
}> {
  try {
    const [h, n, d, a] = await Promise.all([
      redis.llen(Q_HIGH),
      redis.llen(Q_NORMAL),
      redis.llen(Q_DLQ),
      redis.scard(Q_ACTIVE),
    ]);
    return { highQueue: h, normalQueue: n, dlqSize: d, totalActiveJobs: a };
  } catch {
    return { highQueue: 0, normalQueue: 0, dlqSize: 0, totalActiveJobs: 0 };
  }
}

export async function getDLQJobs(limit = 30): Promise<QueueJob[]> {
  try {
    const raws = await redis.lrange(Q_DLQ, 0, limit - 1);
    return raws.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export async function clearDLQ(): Promise<void> {
  await redis.del(Q_DLQ);
}

export async function clearQueues(): Promise<void> {
  await redis.del(Q_HIGH, Q_NORMAL, Q_ACTIVE);
}
