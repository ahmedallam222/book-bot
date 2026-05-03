import { redis } from "./redis.js";
import { L }      from "./logger.js";

// ══════════════════════════════════════════════
// TELEMETRY — تتبع الطلبات
// ══════════════════════════════════════════════

export type RequestOutcome =
  | "sent_direct"
  | "sent_local"
  | "sent_from_cache"
  | "no_results"
  | "links_only"
  | "error";

interface TracePhase {
  phase: string;
  ts:    number;
  meta?: Record<string, unknown>;
}

interface TraceRecord {
  id:       string;
  userId:   string;
  book:     string;
  retries:  number;
  phases:   TracePhase[];
  outcome?: RequestOutcome;
  startTs:  number;
  endTs?:   number;
  durationMs?: number;
}

const TRACE_TTL_SEC = 3600;             // 1h لكل trace
const TRACES_LIST   = "telemetry:traces";
const TRACES_MAX    = 500;
// مدة بقاء الـ list نفسها لو ما فيش writes جديدة. = 2 * TRACE_TTL_SEC
// عشان تكون أطول من أطول trace ممكن، فلو السكون طويل الـ list تختفي تلقائياً.
const TRACES_LIST_TTL_SEC = TRACE_TTL_SEC * 2;

export class RequestTrace {
  private record: TraceRecord;

  constructor(id: string, userId: string, book: string, retries: number) {
    this.record = {
      id, userId,
      book:    book.slice(0, 80),
      retries,
      phases:  [],
      startTs: Date.now(),
    };
  }

  phase(name: string, meta?: Record<string, unknown>): void {
    this.record.phases.push({ phase: name, ts: Date.now(), meta });
  }

  async finish(outcome: RequestOutcome): Promise<void> {
    this.record.outcome    = outcome;
    this.record.endTs      = Date.now();
    this.record.durationMs = this.record.endTs - this.record.startTs;

    try {
      const json = JSON.stringify(this.record);
      // expire على الـ list نفسها يضمن انها تختفي بعد فترة سكون طويلة
      // (بدل ما تفضل full of stale IDs بعد ما الـ trace keys نفسها انتهت TTL).
      await redis.pipeline()
        .set(`telemetry:trace:${this.record.id}`, json, "EX", TRACE_TTL_SEC)
        .lpush(TRACES_LIST, this.record.id)
        .ltrim(TRACES_LIST, 0, TRACES_MAX - 1)
        .expire(TRACES_LIST, TRACES_LIST_TTL_SEC)
        .exec();
    } catch (e) {
      L.debug("telemetry", `Failed to save trace: ${String(e).slice(0, 60)}`);
    }
  }
}

/** يمنع تكرار funnel count لنفس الـ job عند retry */
export async function claimFunnelSlot(jobId: string): Promise<boolean> {
  try {
    const key    = `funnel:claimed:${jobId}`;
    const result = await redis.set(key, "1", "EX", 3600, "NX");
    return result === "OK";
  } catch {
    return true;
  }
}

export async function getRecentTraces(limit = 50): Promise<TraceRecord[]> {
  try {
    const ids  = await redis.lrange(TRACES_LIST, 0, limit - 1);
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => `telemetry:trace:${id}`));

    // Self-trim: اجمع الـ IDs الميتة (per-trace key انتهى TTL بتاعه)
    // عشان ما نتراكمش في الـ list. fire-and-forget — ما نأخّرش الـ caller.
    const staleIds: string[] = [];
    const result: TraceRecord[] = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (raw === null || raw === undefined) {
        staleIds.push(ids[i]);
        continue;
      }
      try { result.push(JSON.parse(raw) as TraceRecord); }
      catch { staleIds.push(ids[i]); }
    }

    if (staleIds.length > 0) {
      pruneStaleTraceIds(staleIds, ids.length).catch(() => {});
    }

    return result;
  } catch { return []; }
}

/**
 * يشيل IDs الميتة من telemetry:traces.
 * - لو كل الـ IDs اللي قريناها ميتة → DEL على الـ list مرة واحدة (أرخص).
 * - وإلا → LREM لكل ID. كل LREM = O(N) بس الـ list ≤ 500 فمقبول.
 *
 * fire-and-forget — لا يرفع exception، ولا يأخّر الـ caller.
 */
async function pruneStaleTraceIds(staleIds: string[], fetchedCount: number): Promise<void> {
  try {
    if (staleIds.length === fetchedCount) {
      // كل الـ window اللي طلبنا ميت — على الأرجح الـ list كلها stale. del أرخص.
      await redis.del(TRACES_LIST);
      L.info("telemetry", `Pruned all ${staleIds.length} stale trace IDs (deleted list)`);
      return;
    }
    const pipe = redis.pipeline();
    for (const id of staleIds) {
      pipe.lrem(TRACES_LIST, 0, id);
    }
    await pipe.exec();
    L.info("telemetry", `Pruned ${staleIds.length} stale trace IDs`);
  } catch (e) {
    L.debug("telemetry", `pruneStaleTraceIds failed: ${String(e).slice(0, 60)}`);
  }
}

export async function getTrace(id: string): Promise<TraceRecord | null> {
  try {
    const raw = await redis.get(`telemetry:trace:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as TraceRecord;
  } catch { return null; }
}
