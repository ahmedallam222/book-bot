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

const TRACE_TTL_SEC = 3600; // 1h
const TRACES_LIST   = "telemetry:traces";
const TRACES_MAX    = 500;

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
      await redis.pipeline()
        .set(`telemetry:trace:${this.record.id}`, json, "EX", TRACE_TTL_SEC)
        .lpush(TRACES_LIST, this.record.id)
        .ltrim(TRACES_LIST, 0, TRACES_MAX - 1)
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
    return raws
      .filter(Boolean)
      .map((r) => { try { return JSON.parse(r!); } catch { return null; } })
      .filter(Boolean) as TraceRecord[];
  } catch { return []; }
}

export async function getTrace(id: string): Promise<TraceRecord | null> {
  try {
    const raw = await redis.get(`telemetry:trace:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as TraceRecord;
  } catch { return null; }
}
