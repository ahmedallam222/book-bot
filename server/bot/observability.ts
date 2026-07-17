// ══════════════════════════════════════════════
// OBSERVABILITY — latency + errors + optional Sentry
//
// Redis keys (TTL 14d):
//   obs:lat:{bucket}  list of ms samples (capped)
//   obs:err:{day}     hash of error counts by ns
//   obs:count:{name}  counters
// ══════════════════════════════════════════════

import { redis } from "./redis.js";
import { cairoDateString } from "./text.js";
import { L } from "./logger.js";
import { getDeliveryStats } from "./deliveryMetrics.js";
import { getQueueStats } from "./queue.js";

const LAT_KEY = (bucket: string) => `obs:lat:${bucket}`;
const ERR_KEY = (day: string) => `obs:err:${day}`;
const TTL = 14 * 86400;
const MAX_SAMPLES = 500;

export type ObsBucket =
  | "agent_turn"
  | "agent_tool"
  | "book_request"
  | "http_api"
  | "llm_call";

export async function recordLatency(bucket: ObsBucket, ms: number): Promise<void> {
  try {
    const key = LAT_KEY(bucket);
    const pipe = redis.pipeline();
    pipe.lpush(key, String(Math.max(0, Math.round(ms))));
    pipe.ltrim(key, 0, MAX_SAMPLES - 1);
    pipe.expire(key, TTL);
    await pipe.exec();
  } catch { /* fail-open */ }
}

export async function recordError(ns: string, message: string): Promise<void> {
  try {
    const day = cairoDateString();
    const field = `${ns}:${String(message).slice(0, 80)}`;
    await redis.hincrby(ERR_KEY(day), field, 1);
    await redis.expire(ERR_KEY(day), TTL);
  } catch { /* */ }
  // Optional Sentry (no hard dependency)
  void sendToSentry(ns, message);
}

export async function incrObs(name: string, by = 1): Promise<void> {
  try {
    await redis.incrby(`obs:count:${name}`, by);
    await redis.expire(`obs:count:${name}`, TTL);
  } catch { /* */ }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

async function latencySnapshot(bucket: string): Promise<{
  samples: number;
  p50: number;
  p95: number;
  avg: number;
}> {
  try {
    const raw = await redis.lrange(LAT_KEY(bucket), 0, MAX_SAMPLES - 1);
    const samples = raw.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
    samples.sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    return {
      samples: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      avg: samples.length ? Math.round(sum / samples.length) : 0,
    };
  } catch {
    return { samples: 0, p50: 0, p95: 0, avg: 0 };
  }
}

/** Full ops snapshot for /api/ops/metrics and admin agent. */
export async function buildOpsMetrics(): Promise<Record<string, unknown>> {
  const day = cairoDateString();
  const buckets: ObsBucket[] = [
    "agent_turn",
    "agent_tool",
    "book_request",
    "http_api",
    "llm_call",
  ];
  const latency: Record<string, unknown> = {};
  for (const b of buckets) latency[b] = await latencySnapshot(b);

  const [delivery, queue, errs, agentTurns, toolCalls] = await Promise.all([
    getDeliveryStats(day).catch(() => null),
    getQueueStats().catch(() => null),
    redis.hgetall(ERR_KEY(day)).catch(() => ({})),
    redis.get("obs:count:agent_turns").catch(() => "0"),
    redis.get("obs:count:agent_tools").catch(() => "0"),
  ]);

  const topErrors = Object.entries(errs || {})
    .map(([k, v]) => ({ key: k, count: parseInt(String(v), 10) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    day,
    ts: Date.now(),
    latency,
    delivery,
    queue,
    counters: {
      agent_turns: parseInt(agentTurns || "0", 10) || 0,
      agent_tools: parseInt(toolCalls || "0", 10) || 0,
    },
    top_errors: topErrors,
    sentry_configured: !!(process.env.SENTRY_DSN || "").trim(),
  };
}

/** Minimal HTML latency dashboard (admin-auth on route). */
export function renderOpsDashboardHtml(data: Record<string, unknown>): string {
  const lat = (data.latency || {}) as Record<string, { p50: number; p95: number; avg: number; samples: number }>;
  const rows = Object.entries(lat)
    .map(
      ([k, v]) =>
        `<tr><td>${k}</td><td>${v.samples}</td><td>${v.p50}</td><td>${v.p95}</td><td>${v.avg}</td></tr>`,
    )
    .join("");
  const del = data.delivery as { successRate?: number; p50Ms?: number; p95Ms?: number } | null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>Rafiqa Ops</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1419;color:#e7ecf1;margin:2rem}
table{border-collapse:collapse;width:100%;max-width:720px}
td,th{border:1px solid #334;padding:.5rem;text-align:left}
th{background:#1a2332}
h1{font-size:1.25rem}
.muted{color:#8b9bb4;font-size:.9rem}
</style></head><body>
<h1>رفيق · Ops / Latency</h1>
<p class="muted">day=${data.day} · ts=${new Date(Number(data.ts)).toISOString()}</p>
<h2>Latency buckets (ms)</h2>
<table><tr><th>bucket</th><th>n</th><th>p50</th><th>p95</th><th>avg</th></tr>${rows}</table>
<h2>Delivery today</h2>
<pre>${JSON.stringify(del, null, 2)}</pre>
<h2>Queue</h2>
<pre>${JSON.stringify(data.queue, null, 2)}</pre>
<h2>Top errors</h2>
<pre>${JSON.stringify(data.top_errors, null, 2)}</pre>
</body></html>`;
}

async function sendToSentry(ns: string, message: string): Promise<void> {
  const dsn = (process.env.SENTRY_DSN || "").trim();
  if (!dsn) return;
  try {
    // Support classic DSN: https://<key>@oXXXX.ingest.sentry.io/<project>
    const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)/);
    if (!m) return;
    const [, key, host, project] = m;
    const url = `https://${host}/api/${project}/store/`;
    const payload = {
      event_id: cryptoRandom(),
      timestamp: new Date().toISOString(),
      platform: "node",
      level: "error",
      logger: ns,
      message: String(message).slice(0, 500),
      tags: { service: "rafiq-book-bot" },
      environment: process.env.NODE_ENV || "production",
    };
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${key}`,
      },
      body: JSON.stringify(payload),
    }).catch(() => null);
  } catch (e) {
    L.debug("obs", `sentry skip: ${String(e).slice(0, 60)}`);
  }
}

function cryptoRandom(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

/** Time an async fn and record latency. */
export async function withLatency<T>(
  bucket: ObsBucket,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    await recordLatency(bucket, Date.now() - t0);
  }
}
