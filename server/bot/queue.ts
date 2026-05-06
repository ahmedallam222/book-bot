import { redis, scanKeys } from "./redis.js";
import { L }               from "./logger.js";
import type { QueueJob, EnqueueResult } from "./types.js";

// ══════════════════════════════════════════════
// QUEUE — طابور المعالجة بـ Redis
// ══════════════════════════════════════════════

const Q_HIGH        = "queue:high";
const Q_NORMAL      = "queue:normal";
const Q_DLQ         = "queue:dlq";       // sorted set, score = expireAt ms (Bug #16)
const Q_ACTIVE      = "queue:active";    // Set of active jobIds
const Q_ACTIVE_JSON = "queue:active:json"; // Hash jobId → JSON (Bug #12 — for requeue on crash)
const USER_JOBS     = (uid: string) => `queue:user:${uid}`;

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
  userName?: string | null,
  userMessageId?: number,
  wantsSummary?: boolean,
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
      userMessageId,
      wantsSummary: wantsSummary === true ? true : undefined,
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
  let raw: string | null = null;
  try {
    // high priority أولاً
    raw = await redis.lpop(Q_HIGH);
    if (!raw) raw = await redis.lpop(Q_NORMAL);
    if (!raw) return null;

    const job = JSON.parse(raw) as QueueJob;
    job.startedAt = Date.now();

    // Bug #12 — also store the full JSON keyed by id so recoverStuckJobs
    // can requeue mid-flight jobs after a crash (the Set alone only kept
    // the id, which was insufficient for requeue).
    const jsonWithStartedAt = JSON.stringify(job);
    await redis.pipeline()
      .sadd(Q_ACTIVE, job.id)
      .hset(Q_ACTIVE_JSON, job.id, jsonWithStartedAt)
      .exec();
    return job;
  } catch (e) {
    // كان `catch {}` صامت — الآن نسجل عشان لو فيه entry فاسد في Redis
    // ما نضيع الإشارة ولا نقع في حلقة failure مخفية.
    L.error("queue", `Dequeue failed`, {
      err:    String(e).slice(0, 100),
      sample: raw ? raw.slice(0, 80) : null,
    });
    return null;
  }
}

// ── Complete / Fail ───────────────────────────

export async function completeJob(job: QueueJob): Promise<void> {
  try {
    await redis.pipeline()
      .srem(Q_ACTIVE, job.id)
      .hdel(Q_ACTIVE_JSON, job.id)             // Bug #12 — release JSON copy
      .lrem(USER_JOBS(job.userId), 0, job.id)  // ID فقط — لا يتغير بعد dequeue
      .exec();
  } catch {}
}

export async function failJob(job: QueueJob): Promise<boolean> {
  // true = أُعيدت للطابور, false = ذهبت لـ DLQ
  try {
    await redis.pipeline()
      .srem(Q_ACTIVE, job.id)
      .hdel(Q_ACTIVE_JSON, job.id)
      .exec();

    if (job.retries < MAX_RETRIES) {
      job.retries++;
      const queue = job.priority === "high" ? Q_HIGH : Q_NORMAL;
      await redis.lpush(queue, JSON.stringify(job)); // في المقدمة
      L.warn("queue", `Job retry ${job.retries}/${MAX_RETRIES}`, { jobId: job.id });
      return true;
    }

    // Bug #16 — DLQ is now a sorted set keyed by per-entry expire-at
    // (score = ms epoch). Pre-fix: `expire(Q_DLQ, DLQ_TTL_SEC)` reset
    // the *list*-level TTL on every push, so old DLQ entries lived
    // indefinitely as long as new failures kept arriving. Sorted set
    // entries each carry their own expiration: stale ones get GC'd by
    // ZREMRANGEBYSCORE on read/push.
    const expireAt = Date.now() + DLQ_TTL_SEC * 1000;
    await redis.pipeline()
      .zadd(Q_DLQ, expireAt, JSON.stringify(job))
      .zremrangebyscore(Q_DLQ, 0, Date.now())  // GC expired entries
      .lrem(USER_JOBS(job.userId), 0, job.id)
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
    // Bug #13 — count actual deletions from pipe.exec() instead of
    // pre-incrementing. Pre-fix `cancelled++` ran inside the loop before
    // the LREM had a chance to fail (e.g. the entry got dequeued by a
    // worker between lrange and exec). Users saw "تم إلغاء 5 طلبات" while
    // only 3 were actually removed. Now we sum the LREM return values
    // (each LREM returns the number of items removed; >0 = success).
    let cancelled = 0;
    if (toRemoveHigh.length > 0 || toRemoveNormal.length > 0) {
      const pipe = redis.pipeline();
      for (const item of toRemoveHigh)   pipe.lrem(Q_HIGH,   0, item);
      for (const item of toRemoveNormal) pipe.lrem(Q_NORMAL, 0, item);
      const res = await pipe.exec();
      if (res) {
        for (const [err, removed] of res) {
          if (!err && typeof removed === "number" && removed > 0) cancelled += removed;
        }
      }
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
// Bug #12 — when the bot restarts mid-flight, jobs in Q_ACTIVE were
// cleared but never requeued. The user submitted a request, the bot
// accepted it, then crashed/restarted and the user just waited
// forever with no answer and no error. Pre-fix:
//   1. Read Q_ACTIVE to find IDs being processed.
//   2. "Stuck" = in Q_ACTIVE but not in Q_HIGH/Q_NORMAL.
//   3. Clear Q_ACTIVE entirely. ← jobs gone.
//
// Post-fix:
//   1. dequeue() also stores the full JSON in Q_ACTIVE_JSON hash.
//   2. recoverStuckJobs reads the JSON for each stuck id.
//   3. Requeues stuck jobs to the FRONT of Q_HIGH (priority lpush)
//      with retries++ (so a poison-pill job that crashes the worker
//      every time still hits MAX_RETRIES → DLQ rather than infinite
//      loop).
//   4. Skips requeue for jobs that exceed MAX_RETRIES → DLQ.
//   5. Then clears Q_ACTIVE + Q_ACTIVE_JSON.

export async function recoverStuckJobs(): Promise<void> {
  try {
    const activeIds = await redis.smembers(Q_ACTIVE);

    // اجمع كل الـ job IDs الموجودة في الطابورَين
    const [highItems, normalItems, activeJsons] = await Promise.all([
      redis.lrange(Q_HIGH, 0, -1),
      redis.lrange(Q_NORMAL, 0, -1),
      redis.hgetall(Q_ACTIVE_JSON).catch(() => ({} as Record<string, string>)),
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

    let requeued    = 0;
    let dlqOnRecover = 0;
    if (stuckIds.length > 0) {
      const requeuePipe = redis.pipeline();
      for (const id of stuckIds) {
        const raw = activeJsons[id];
        if (!raw) continue;  // missing JSON — best we can do is drop
        let job: QueueJob;
        try { job = JSON.parse(raw) as QueueJob; } catch { continue; }

        // Treat the crash-restart as a failure attempt to avoid an
        // infinite-recovery loop on a poison-pill job.
        job.retries = (job.retries ?? 0) + 1;
        delete job.startedAt;

        if (job.retries > MAX_RETRIES) {
          const expireAt = Date.now() + DLQ_TTL_SEC * 1000;
          requeuePipe.zadd(Q_DLQ, expireAt, JSON.stringify(job));
          dlqOnRecover++;
        } else {
          const queue = job.priority === "high" ? Q_HIGH : Q_NORMAL;
          requeuePipe.lpush(queue, JSON.stringify(job));
          requeued++;
          // Audit 2026-05-04 (Bug C): keep `queuedIds` in sync with the
          // requeue. Without this, the USER_JOBS orphan-cleanup pass
          // below would treat just-requeued IDs as orphans (because
          // `queuedIds` was snapshotted BEFORE the lpush) and `del` the
          // user's pointer to their own running job. Net effect:
          // `getUserPendingCount` reports 0 while the job still runs,
          // and the per-user pending guard under-counts.
          queuedIds.add(id);
        }
      }
      // Always GC expired DLQ entries while we're here.
      requeuePipe.zremrangebyscore(Q_DLQ, 0, Date.now());
      await requeuePipe.exec().catch(() => null);
      L.warn("queue", `recoverStuckJobs requeued ${requeued} (+${dlqOnRecover} to DLQ) of ${stuckIds.length} stuck jobs`);
    }

    // FIX-AUDIT: تنظيف USER_JOBS lists الـ orphan.
    // قبل هذا الإصلاح: لما البوت يرجع بعد crash، Q_ACTIVE بيتمسح لكن USER_JOBS
    // كانت بتفضل عاملة reference لـ jobs مفقودة — `getUserPendingCount` كان
    // يرجع >0 غلط ويقفل اليوزر على MAX_USER_PENDING للأبد.
    // الحل: نقرا كل USER_JOBS list، نشيل أي ID مش موجود في الطابورَين.
    let orphanIds  = 0;
    let cleanedKeys = 0;
    let removedKeys = 0;
    try {
      const userJobKeys = await scanKeys("queue:user:*");
      if (userJobKeys.length > 0) {
        const lrangePipe = redis.pipeline();
        for (const key of userJobKeys) lrangePipe.lrange(key, 0, -1);
        const lrangeRes = await lrangePipe.exec();

        const cleanupPipe = redis.pipeline();
        for (let i = 0; i < userJobKeys.length; i++) {
          const key = userJobKeys[i];
          const ids = (lrangeRes?.[i]?.[1] as string[] | null) || [];
          if (ids.length === 0) continue;

          const orphans = ids.filter((id) => !queuedIds.has(id));
          if (orphans.length === 0) continue;

          orphanIds += orphans.length;

          if (orphans.length === ids.length) {
            // كل الـ list orphan — احذف المفتاح كله
            cleanupPipe.del(key);
            removedKeys++;
          } else {
            // بعض الـ IDs orphan — شيلهم بـ lrem
            for (const orphan of orphans) cleanupPipe.lrem(key, 0, orphan);
            cleanedKeys++;
          }
        }
        if (cleanedKeys + removedKeys > 0) await cleanupPipe.exec();
      }
    } catch (e) {
      L.warn("queue", `USER_JOBS cleanup partial fail`, { err: String(e).slice(0, 100) });
    }

    // مسح Q_ACTIVE — جميع الـ workers توقفوا عند restart
    // Bug #12 — also clear the JSON hash; the requeued copies above
    // are the new authoritative source of truth.
    await redis.del(Q_ACTIVE, Q_ACTIVE_JSON);

    L.info("queue", `recoverStuckJobs done`, {
      cleared:           activeIds.length,
      stuckIds:          stuckIds.length,
      requeuedToQueue:   requeued,
      requeuedToDLQ:     dlqOnRecover,
      orphanUserJobIds:  orphanIds,
      cleanedUserKeys:   cleanedKeys,
      removedUserKeys:   removedKeys,
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
    // Bug #16 — DLQ is now a sorted set; ZCOUNT for non-expired entries.
    const [h, n, d, a] = await Promise.all([
      redis.llen(Q_HIGH),
      redis.llen(Q_NORMAL),
      redis.zcount(Q_DLQ, Date.now(), "+inf").catch(() => 0),
      redis.scard(Q_ACTIVE),
    ]);
    return { highQueue: h, normalQueue: n, dlqSize: d, totalActiveJobs: a };
  } catch {
    return { highQueue: 0, normalQueue: 0, dlqSize: 0, totalActiveJobs: 0 };
  }
}

export async function getDLQJobs(limit = 30): Promise<QueueJob[]> {
  try {
    // Bug #16 — opportunistically GC then return non-expired entries
    // ordered by most recent expireAt first (latest failures shown
    // first in the admin dashboard).
    await redis.zremrangebyscore(Q_DLQ, 0, Date.now()).catch(() => 0);
    const raws = await redis.zrevrangebyscore(
      Q_DLQ, "+inf", Date.now(), "LIMIT", 0, limit,
    );
    return raws
      .map((r) => { try { return JSON.parse(r) as QueueJob; } catch { return null; } })
      .filter((j): j is QueueJob => j !== null);
  } catch { return []; }
}

export async function clearDLQ(): Promise<void> {
  await redis.del(Q_DLQ);
}

export async function clearQueues(): Promise<void> {
  await redis.del(Q_HIGH, Q_NORMAL, Q_ACTIVE, Q_ACTIVE_JSON);
}
