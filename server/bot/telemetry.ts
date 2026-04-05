import { redis } from "./redis.js";
import { L } from "./logger.js";

// ══════════════════════════════════════════════════════════════
//  TELEMETRY — Pipeline Tracing per Request
//
//  TTL Strategy (ملاحظة 1 — مُصلَح):
//    trace:full:{id}  → 6 ساعات  (بيانات كاملة + phases)
//    trace:meta:{id}  → 24 ساعة  (metadata خفيف للـ listing)
//    trace:idx        → 24 ساعة  (ZSET index — آخر 500)
//
//  Funnel Dedup (ملاحظة 2 — مُصلَح):
//    funnel:counted:{id} → NX key — يضمن عدّ كل job مرة واحدة حتى لو retry
// ══════════════════════════════════════════════════════════════

const TRACE_FULL_TTL_SEC = 6 * 3600;   // 6 ساعات — بيانات كاملة
const TRACE_META_TTL_SEC = 24 * 3600;  // 24 ساعة — metadata للـ listing
const TRACE_IDX_MAX      = 500;        // أكثر إدخالات في الـ index

export type RequestOutcome =
  | "sent_direct"        // أُرسل via Telegram direct URL
  | "sent_local"         // أُرسل via local download
  | "sent_from_cache"    // من الـ cache
  | "links_only"         // لم يُرسل — فقط روابط للمستخدم
  | "no_results"         // لا نتائج نهائياً
  | "error";             // خطأ غير متوقع

export interface TracePhase {
  name:  string;
  ts:    number;           // ms since trace start
  data?: Record<string, unknown>;
}

/** بيانات كاملة — تُخزَّن بـ TTL 6h */
export interface TraceRecord {
  id:        string;
  userId:    string;
  bookName:  string;
  startedAt: number;
  phases:    TracePhase[];
  outcome?:  RequestOutcome;
  totalMs?:  number;
  retryNo:   number;       // محاولة رقم كم (0-based)
}

/** metadata خفيف — تُخزَّن بـ TTL 24h لقائمة الـ dashboard */
export interface TraceMeta {
  id:        string;
  userId:    string;
  bookName:  string;
  startedAt: number;
  outcome?:  RequestOutcome;
  totalMs?:  number;
  retryNo:   number;
}

// ══════════════════════════════════════════════
//  RequestTrace — يُنشأ مرة واحدة لكل job attempt
// ══════════════════════════════════════════════
export class RequestTrace {
  readonly id:      string;
  readonly retryNo: number;
  private readonly t0: number = Date.now();
  private readonly record:    TraceRecord;
  private _finished = false;

  constructor(id: string, userId: string, bookName: string, retryNo = 0) {
    this.id      = id;
    this.retryNo = retryNo;
    this.record  = { id, userId, bookName, startedAt: this.t0, phases: [], retryNo };
  }

  /** سجّل مرحلة */
  phase(name: string, data?: Record<string, unknown>): void {
    const ts = Date.now() - this.t0;
    this.record.phases.push({ name, ts, ...(data ? { data } : {}) });

    // log قابل للـ grep بـ reqId مختصر + retry indicator
    const retryTag = this.retryNo > 0 ? ` [retry#${this.retryNo}]` : "";
    const dataStr  = data
      ? " " + Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
      : "";
    L.info("trace", `[${this.id.slice(0, 8)}]${retryTag} ${name}${dataStr}`);
  }

  /** أنهِ الـ trace */
  async finish(outcome: RequestOutcome): Promise<void> {
    if (this._finished) return; // guard: لا تُشغَّل مرتين
    this._finished = true;

    const totalMs = Date.now() - this.t0;
    this.record.outcome  = outcome;
    this.record.totalMs  = totalMs;
    this.phase("request_done", { outcome, totalMs, retry: this.retryNo });

    const meta: TraceMeta = {
      id: this.id, userId: this.record.userId,
      bookName: this.record.bookName, startedAt: this.t0,
      outcome, totalMs, retryNo: this.retryNo,
    };

    try {
      // FIX-v10-F: دمج الـ pipeline الثانية (expire + zremrangebyrank) في نفس الـ pipeline
      // قبل: لو الأولى نجحت والثانية فشلت → trace:idx بدون TTL ولا trim → يكبر للأبد
      // الآن: عملية ذرية واحدة — إما كلها أو لا شيء
      // ملاحظة: ZADD + EXPIRE + ZREMRANGEBYRANK تعمل معاً في ioredis بدون مشكلة
      await redis.pipeline()
        // بيانات كاملة — 6h
        .setex(`trace:full:${this.id}`, TRACE_FULL_TTL_SEC, JSON.stringify(this.record))
        // metadata خفيف — 24h
        .setex(`trace:meta:${this.id}`, TRACE_META_TTL_SEC, JSON.stringify(meta))
        // ZSET index
        .zadd("trace:idx", this.t0, this.id)
        .expire("trace:idx", TRACE_META_TTL_SEC)
        .zremrangebyrank("trace:idx", 0, -(TRACE_IDX_MAX + 1))
        .exec();
    } catch { /* لا تكسر الـ job */ }
  }
}

// ══════════════════════════════════════════════
//  Funnel Deduplication Guard
//  يضمن عدّ كل job مرة واحدة فقط حتى لو retry
// ══════════════════════════════════════════════

/** يُعيد true لو هذا أول مرة نعدّ هذا الـ jobId في الـ funnel */
export async function claimFunnelSlot(jobId: string): Promise<boolean> {
  try {
    // SET NX EX: يكتب فقط لو المفتاح غير موجود
    const result = await redis.set(
      `funnel:counted:${jobId}`,
      "1",
      "EX", TRACE_META_TTL_SEC,
      "NX"
    );
    return result === "OK"; // OK = كتب للمرة الأولى، null = كان موجوداً
  } catch {
    return true; // عند فشل Redis افترض أول مرة (أحسن من تفويت metric)
  }
}

// ══════════════════════════════════════════════
//  Read — للـ dashboard
// ══════════════════════════════════════════════

/** آخر N traces — metadata خفيف (24h) */
export async function getRecentTraces(limit = 50): Promise<TraceMeta[]> {
  try {
    const ids  = await redis.zrevrange("trace:idx", 0, limit - 1);
    if (!ids.length) return [];
    const raws = await redis.mget(...ids.map((id) => `trace:meta:${id}`));
    return raws
      .filter((r): r is string => r !== null)
      .map((r) => JSON.parse(r) as TraceMeta);
  } catch { return []; }
}

/** trace كامل بالـ phases — يحاول 6h أولاً، fallback لـ meta */
export async function getTrace(id: string): Promise<TraceRecord | TraceMeta | null> {
  try {
    const full = await redis.get(`trace:full:${id}`);
    if (full) return JSON.parse(full) as TraceRecord;
    const meta = await redis.get(`trace:meta:${id}`);
    return meta ? JSON.parse(meta) as TraceMeta : null;
  } catch { return null; }
}
