// ══════════════════════════════════════════════════════════
// Admin Agent — LLM provider telemetry + circuit breaker
// ══════════════════════════════════════════════════════════
// Records per-provider success/failure counts and latency so the
// admin can answer "is Cloudflare flaky today?" via the
// `llm_provider_stats` tool. Also tracks a short-window failure
// streak so the dispatcher can demote a provider that just hit its
// daily quota / went down, without taking it out of the chain
// permanently.
//
// Keys (all in Redis, no DB):
//   tel:llm:{id}:ok           — INCR on success
//   tel:llm:{id}:err          — INCR on terminal failure (after retry)
//   tel:llm:{id}:err_429      — INCR on 429 specifically
//   tel:llm:{id}:err_5xx      — INCR on 5xx specifically
//   tel:llm:{id}:err_timeout  — INCR on AbortError / network error
//   tel:llm:{id}:lat_ms       — RPUSH sliding window of latencies (last 200)
//   tel:llm:{id}:last_err     — SET last error message (60 min TTL)
//   tel:llm:{id}:streak       — INCR on err, DEL on ok (consecutive fails)
//   tel:llm:{id}:demote_until — SET unix-ms when demoted; demoteUntil() ignored if past
//
// All writes are fire-and-forget — telemetry never blocks dispatch.

import { redis } from "../redis.js";

const LAT_WINDOW   = 200;       // keep last N latencies per provider
const ERR_TTL_SECS = 60 * 60;   // 1h TTL on last_err so stale messages clear

// ── Breaker thresholds (tunable; conservative for admin agent) ──
const STREAK_THRESHOLD   = 3;                // consecutive fails to demote
const STREAK_WINDOW_MS   = 5 * 60 * 1000;    // streak must accumulate within 5 min
const DEMOTE_DURATION_MS = 10 * 60 * 1000;   // demote for 10 min, then retry

function tkey(id: string, suffix: string): string {
  return `tel:llm:${id}:${suffix}`;
}

// ── Recording ────────────────────────────────────────────────────

export async function recordSuccess(id: string, latencyMs: number): Promise<void> {
  try {
    const pipe = redis.pipeline();
    pipe.incr(tkey(id, "ok"));
    pipe.rpush(tkey(id, "lat_ms"), String(latencyMs));
    pipe.ltrim(tkey(id, "lat_ms"), -LAT_WINDOW, -1);
    pipe.del(tkey(id, "streak"));
    pipe.del(tkey(id, "streak_first"));
    pipe.del(tkey(id, "demote_until"));
    await pipe.exec();
  } catch { /* fire-and-forget */ }
}

export type FailureKind = "429" | "5xx" | "timeout" | "other";

export async function recordFailure(
  id: string,
  kind: FailureKind,
  errMsg: string,
  latencyMs: number,
): Promise<void> {
  try {
    const now = Date.now();
    // Reset streak window if the first failure is stale (>5 min ago).
    const firstAtRaw = await redis.get(tkey(id, "streak_first"));
    const firstAt    = firstAtRaw ? Number(firstAtRaw) : 0;
    if (!firstAt || now - firstAt > STREAK_WINDOW_MS) {
      await redis.set(tkey(id, "streak_first"), String(now));
      await redis.set(tkey(id, "streak"), "1");
    } else {
      await redis.incr(tkey(id, "streak"));
    }

    const pipe = redis.pipeline();
    pipe.incr(tkey(id, "err"));
    if      (kind === "429")     pipe.incr(tkey(id, "err_429"));
    else if (kind === "5xx")     pipe.incr(tkey(id, "err_5xx"));
    else if (kind === "timeout") pipe.incr(tkey(id, "err_timeout"));
    pipe.rpush(tkey(id, "lat_ms"), String(latencyMs));
    pipe.ltrim(tkey(id, "lat_ms"), -LAT_WINDOW, -1);
    pipe.set(tkey(id, "last_err"), errMsg.slice(0, 240), "EX", ERR_TTL_SECS);
    await pipe.exec();

    // Trip breaker?
    const streak = Number((await redis.get(tkey(id, "streak"))) || "0");
    if (streak >= STREAK_THRESHOLD) {
      const demoteUntil = now + DEMOTE_DURATION_MS;
      await redis.set(tkey(id, "demote_until"), String(demoteUntil));
    }
  } catch { /* fire-and-forget */ }
}

// ── Breaker queries ──────────────────────────────────────────────

/** Returns true if the provider is currently demoted (within breaker window). */
export async function isDemoted(id: string): Promise<boolean> {
  try {
    const raw = await redis.get(tkey(id, "demote_until"));
    if (!raw) return false;
    const until = Number(raw);
    if (Date.now() >= until) {
      // Demotion expired; clean up the marker opportunistically.
      await redis.del(tkey(id, "demote_until"));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Stats read (for the llm_provider_stats tool) ────────────────

export interface ProviderStats {
  id:                string;
  ok:                number;
  err:               number;
  err_429:           number;
  err_5xx:           number;
  err_timeout:       number;
  successRate:       number | null;   // 0..1, null if no calls
  latencyMs_p50:     number | null;
  latencyMs_p95:     number | null;
  latencyMs_recent:  number[];        // last 10 sample
  streak:            number;
  demotedUntilMs:    number | null;
  demotedRemainingS: number | null;
  lastErr:           string | null;
}

export async function getProviderStats(id: string): Promise<ProviderStats> {
  const [ok, err, e429, e5xx, eto, streak, demote, lastErr, lats] = await Promise.all([
    redis.get(tkey(id, "ok")).then(Number),
    redis.get(tkey(id, "err")).then(Number),
    redis.get(tkey(id, "err_429")).then(Number),
    redis.get(tkey(id, "err_5xx")).then(Number),
    redis.get(tkey(id, "err_timeout")).then(Number),
    redis.get(tkey(id, "streak")).then(Number),
    redis.get(tkey(id, "demote_until")),
    redis.get(tkey(id, "last_err")),
    redis.lrange(tkey(id, "lat_ms"), 0, -1),
  ]);

  const okN  = ok  || 0;
  const errN = err || 0;
  const total = okN + errN;

  const latNums = (lats || [])
    .map(Number)
    .filter(n => Number.isFinite(n));
  const sorted = [...latNums].sort((a, b) => a - b);
  const pct = (p: number): number | null => {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[idx]);
  };

  const demoteUntilMs = demote ? Number(demote) : null;
  const demotedRemaining = demoteUntilMs && demoteUntilMs > Date.now()
    ? Math.round((demoteUntilMs - Date.now()) / 1000)
    : null;

  return {
    id,
    ok:                okN,
    err:               errN,
    err_429:           e429 || 0,
    err_5xx:           e5xx || 0,
    err_timeout:       eto  || 0,
    successRate:       total === 0 ? null : Math.round((okN / total) * 1000) / 1000,
    latencyMs_p50:     pct(50),
    latencyMs_p95:     pct(95),
    latencyMs_recent:  latNums.slice(-10),
    streak:            streak || 0,
    demotedUntilMs:    demoteUntilMs,
    demotedRemainingS: demotedRemaining,
    lastErr:           lastErr || null,
  };
}

/** Reset all telemetry for a provider — used by the admin to clear a
 * breaker manually after fixing an upstream issue. */
export async function resetProviderTelemetry(id: string): Promise<void> {
  const suffixes = [
    "ok", "err", "err_429", "err_5xx", "err_timeout",
    "lat_ms", "last_err", "streak", "streak_first", "demote_until",
  ];
  await redis.del(...suffixes.map(s => tkey(id, s)));
}

// ── Failure-kind classifier ─────────────────────────────────────

/** Inspect an error/HTTP status and return a kind for telemetry +
 * retry decision. */
export function classifyFailure(err: unknown, httpStatus?: number): FailureKind {
  if (httpStatus === 429)                        return "429";
  if (httpStatus && httpStatus >= 500)           return "5xx";
  const msg = String(err instanceof Error ? err.message : err);
  if (/abort|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg)) return "timeout";
  return "other";
}

/** Transient = worth retrying once. 429, 5xx, and network/timeout. */
export function isTransient(kind: FailureKind): boolean {
  return kind === "429" || kind === "5xx" || kind === "timeout";
}
