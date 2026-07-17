// ══════════════════════════════════════════════
// DELIVERY METRICS — p50/p95 latency + outcomes
// ══════════════════════════════════════════════
import { redis } from "./redis.js";
import { cairoDateString } from "./text.js";
import { L } from "./logger.js";

const LAT_KEY = (day: string) => `metrics:delivery_ms:${day}`;
const OUT_KEY = (day: string) => `metrics:delivery_out:${day}`;
const TTL = 14 * 86400;

export type DeliveryOutcome =
  | "ok_cache"
  | "ok_send"
  | "fail_no_results"
  | "fail_found_no_send"
  | "fail_too_large"
  | "fail_paid"
  | "fail_error";

export async function recordDelivery(
  ms: number,
  outcome: DeliveryOutcome,
): Promise<void> {
  try {
    const day = cairoDateString();
    const pipe = redis.pipeline();
    // Keep last 2000 samples for percentile math
    pipe.lpush(LAT_KEY(day), String(Math.max(0, Math.round(ms))));
    pipe.ltrim(LAT_KEY(day), 0, 1999);
    pipe.expire(LAT_KEY(day), TTL);
    pipe.hincrby(OUT_KEY(day), outcome, 1);
    pipe.expire(OUT_KEY(day), TTL);
    await pipe.exec();
  } catch (e) {
    L.debug("metrics", "recordDelivery failed", { err: String(e).slice(0, 80) });
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface DeliveryStatsSnapshot {
  day: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
  outcomes: Record<string, number>;
  successRate: number; // ok_* / (ok + fail) * 100
}

export async function getDeliveryStats(day?: string): Promise<DeliveryStatsSnapshot> {
  const d = day || cairoDateString();
  const empty: DeliveryStatsSnapshot = {
    day: d, samples: 0, p50Ms: 0, p95Ms: 0, avgMs: 0, outcomes: {}, successRate: 0,
  };
  try {
    const [raw, outcomes] = await Promise.all([
      redis.lrange(LAT_KEY(d), 0, 1999),
      redis.hgetall(OUT_KEY(d)),
    ]);
    const samples = raw.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n >= 0);
    samples.sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    const outs: Record<string, number> = {};
    let ok = 0, fail = 0;
    for (const [k, v] of Object.entries(outcomes || {})) {
      const n = parseInt(String(v), 10) || 0;
      outs[k] = n;
      if (k.startsWith("ok_")) ok += n;
      else if (k.startsWith("fail_")) fail += n;
    }
    const total = ok + fail;
    return {
      day: d,
      samples: samples.length,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      avgMs: samples.length ? Math.round(sum / samples.length) : 0,
      outcomes: outs,
      successRate: total > 0 ? Math.round((ok / total) * 1000) / 10 : 0,
    };
  } catch {
    return empty;
  }
}

export function formatDeliveryStatsArabic(s: DeliveryStatsSnapshot): string {
  const sec = (ms: number) => (ms / 1000).toFixed(1);
  return (
    `📊 *أداء التسليم — ${s.day}*\n\n` +
    `✅ نسبة النجاح: *${s.successRate}%*\n` +
    `⏱ p50: *${sec(s.p50Ms)}ث* · p95: *${sec(s.p95Ms)}ث* · متوسط: *${sec(s.avgMs)}ث*\n` +
    `📈 عينات زمن: ${s.samples}\n` +
    `· نجاح كاش: ${s.outcomes.ok_cache || 0}\n` +
    `· نجاح إرسال: ${s.outcomes.ok_send || 0}\n` +
    `· فشل (لا نتائج): ${s.outcomes.fail_no_results || 0}\n` +
    `· وُجد ولم يُرسل: ${s.outcomes.fail_found_no_send || 0}\n` +
    `· كبير جداً: ${s.outcomes.fail_too_large || 0}`
  );
}
