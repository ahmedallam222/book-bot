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
    const now = Date.now();
    // احسب الفرق من آخر phase (أو من البداية لو هي الأولى) — يلتقط
    // فترة الـ phase السابقة، فيمكن نتاليه للـ latency histogram.
    const prevTs = this.record.phases.length > 0
      ? (this.record.phases[this.record.phases.length - 1] as TracePhase).ts
      : this.record.startTs;
    const elapsedMs = now - prevTs;
    this.record.phases.push({ phase: name, ts: now, meta });
    // fire-and-forget — ما نأخّرش الـ caller. الـ phase اللي بنسمّيه هنا
    // هو نهاية المرحلة السابقة، يعني نشحن لاتنسي اسم الـ phase الجديد
    // لأنه يمثّل الـ checkpoint اللي وصلنا له. اسم الـ bucket: phase اللي
    // وصلنا له = اللي خلصنا منه (انظر README runbook).
    recordLatency(name, elapsedMs).catch(() => {});
  }

  async finish(outcome: RequestOutcome): Promise<void> {
    this.record.outcome    = outcome;
    this.record.endTs      = Date.now();
    this.record.durationMs = this.record.endTs - this.record.startTs;
    // طول الـ trace كله (end-to-end)
    recordLatency("__total__", this.record.durationMs).catch(() => {});

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

// ══════════════════════════════════════════════
//  LATENCY HISTOGRAMS
// ══════════════════════════════════════════════
//
// لكل phase بنحفظ histogram (buckets) وعدد العينات + المجموع. الـ
// buckets ثوابت بالمللي ثانية: 50, 100, 250, 500, 1000, 2000, 5000,
// 10000, 30000, 60000, +Inf. اختير عشان التغطي مدى الطلبات الواقعية
// (cache-hit ~50ms حتى download timeout 60s).
//
// التخزين في Redis:
//   - tel:lat:{phase}:hist  → Hash من bucket → count
//   - tel:lat:{phase}:count → عدد العينات الكلي
//   - tel:lat:{phase}:sum   → مجموع المللي ثانية (لحساب المتوسط)
//
// TTL: 7 أيام لكل المفاتيح. لو الـ phase مش بيتسجّل لها بيانات الـ keys
// بتختفي تلقائياً.
//
// الـ p50/p95/p99 محسوب من الـ histogram (linear interpolation داخل bucket).
// مش p99 دقيق رقمياً لأنها buckets، لكنه كافي للـ debugging.

const LAT_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000];
const LAT_TTL_SEC    = 7 * 86_400;
const LAT_PHASES_KEY = "tel:lat:phases"; // Set من أسماء كل الـ phases

function bucketLabel(ms: number): string {
  for (const b of LAT_BUCKETS_MS) {
    if (ms <= b) return `≤${b}`;
  }
  return ">60000";
}

async function recordLatency(phase: string, elapsedMs: number): Promise<void> {
  if (elapsedMs < 0 || !Number.isFinite(elapsedMs)) return;
  // نلتقط max length للأسماء عشان ما يحصلش explosion في keys لو في bug
  // بيمرر phase names ديناميكية (مش متوقع لكن defense-in-depth).
  const safePhase = phase.slice(0, 64).replace(/[^a-zA-Z0-9_]/g, "_");
  const key = `tel:lat:${safePhase}`;
  try {
    await redis.pipeline()
      .sadd(LAT_PHASES_KEY, safePhase)
      .expire(LAT_PHASES_KEY, LAT_TTL_SEC)
      .hincrby(`${key}:hist`, bucketLabel(elapsedMs), 1)
      .expire(`${key}:hist`, LAT_TTL_SEC)
      .incr(`${key}:count`)
      .expire(`${key}:count`, LAT_TTL_SEC)
      .incrby(`${key}:sum`, Math.floor(elapsedMs))
      .expire(`${key}:sum`, LAT_TTL_SEC)
      .exec();
  } catch {
    // silent: latency histogram ثانوي ما نريدش يعطل الـ caller
  }
}

interface PhaseHistogram {
  phase:   string;
  count:   number;
  avgMs:   number;
  p50Ms:   number;
  p95Ms:   number;
  p99Ms:   number;
  buckets: Record<string, number>;
}

/**
 * يقرأ histograms لكل الـ phases. يطلع p50/p95/p99 تقريبية محسوبة من
 * الـ buckets (linear interpolation داخل الـ bucket).
 */
export async function getLatencyHistograms(): Promise<PhaseHistogram[]> {
  try {
    const phases = await redis.smembers(LAT_PHASES_KEY);
    if (!phases.length) return [];

    const out: PhaseHistogram[] = [];
    for (const phase of phases) {
      const key = `tel:lat:${phase}`;
      const [hist, countRaw, sumRaw] = await Promise.all([
        redis.hgetall(`${key}:hist`),
        redis.get(`${key}:count`),
        redis.get(`${key}:sum`),
      ]);
      const count = parseInt(countRaw ?? "0", 10) || 0;
      const sum   = parseInt(sumRaw   ?? "0", 10) || 0;
      if (count === 0) continue;

      out.push({
        phase,
        count,
        avgMs:   Math.round(sum / count),
        p50Ms:   estimatePercentile(hist, count, 0.50),
        p95Ms:   estimatePercentile(hist, count, 0.95),
        p99Ms:   estimatePercentile(hist, count, 0.99),
        buckets: parseHistBuckets(hist),
      });
    }
    // ترتيب: __total__ أولاً، ثم باقي الـ phases بعدد العينات نزولاً
    out.sort((a, b) => {
      if (a.phase === "__total__") return -1;
      if (b.phase === "__total__") return 1;
      return b.count - a.count;
    });
    return out;
  } catch (e) {
    L.debug("telemetry", `getLatencyHistograms failed: ${String(e).slice(0, 60)}`);
    return [];
  }
}

function parseHistBuckets(hist: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(hist)) {
    out[k] = parseInt(v, 10) || 0;
  }
  return out;
}

/**
 * يحسب percentile تقريبية من الـ histogram. الـ buckets تراكمية بترتيب،
 * لما تتعدّى الـ count المطلوب نرجع upper bound للـ bucket (تقدير بسيط).
 */
function estimatePercentile(
  hist:    Record<string, string>,
  total:   number,
  pct:     number,
): number {
  const target = Math.max(1, Math.ceil(total * pct));
  let cumulative = 0;
  for (const b of LAT_BUCKETS_MS) {
    const label = `≤${b}`;
    cumulative += parseInt(hist[label] ?? "0", 10) || 0;
    if (cumulative >= target) return b;
  }
  // فاضت للـ overflow bucket
  cumulative += parseInt(hist[">60000"] ?? "0", 10) || 0;
  return cumulative >= target ? 60_000 : 0;
}
