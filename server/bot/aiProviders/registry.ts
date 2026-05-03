// ══════════════════════════════════════════════════════════
// Provider Registry — failover orchestration
// ══════════════════════════════════════════════════════════
// Walks the registered providers in priority order and returns the
// first SummaryResponse. Skips providers that are:
//   - unconfigured (missing env vars)
//   - over their declared daily quota (Redis counter)
//   - in circuit-breaker open state (recent consecutive failures)
//   - unable to handle the request shape (no PDF support when PDF
//     was requested AND we want PDF first)
//
// The orchestrator (summary.ts) calls runFailover twice when a PDF
// is available: once with `requirePDF=true` to try Gemini, then
// again with `requirePDF=false` for the text-only fallback tier.

import { L } from "../logger.js";
import { redis } from "../redis.js";
import type { AIProvider, SummaryRequest, SummaryResponse } from "./types.js";

import { geminiProviders }      from "./gemini.js";
import { groqProvider }         from "./groq.js";
import { cerebrasProvider }     from "./cerebras.js";
import { sambanovaProvider }    from "./sambanova.js";
import { openrouterProvider }   from "./openrouter.js";
import { githubModelsProvider } from "./githubModels.js";
import { mistralProvider }      from "./mistralProvider.js";
import { cloudflareProvider }   from "./cloudflare.js";
import { youcomProvider }       from "./youcom.js";

// Order matters within ties — geminis are listed first (priority 1-3)
// for PDF capability, then text-only providers in rough quality/speed
// order.
const ALL_PROVIDERS: AIProvider[] = [
  youcomProvider,             // priority 0 — premium-only
  ...geminiProviders,         // 1-3 — PDF native
  groqProvider,               // 10
  cerebrasProvider,           // 11
  sambanovaProvider,          // 12
  openrouterProvider,         // 13
  githubModelsProvider,       // 14
  mistralProvider,            // 15
  cloudflareProvider,         // 16
];

// Redis keys — namespaced under `ai:` so they're easy to inspect /
// flush as a group.
const todayKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
const usageKey   = (name: string): string => `ai:usage:${name}:${todayKey()}`;
const breakerKey = (name: string): string => `ai:breaker:${name}`;
const failsKey   = (name: string): string => `ai:fails:${name}`;

// Circuit breaker thresholds. Conservative — we'd rather fail over
// quickly to the next provider than retry a sick one.
const BREAKER_FAIL_THRESHOLD = 3;     // 3 consecutive errors → open
const BREAKER_OPEN_SECONDS   = 5 * 60; // 5 min cool-down
const FAILS_KEY_TTL          = 10 * 60; // forget streak after 10 min

async function isBreakerOpen(name: string): Promise<boolean> {
  return Boolean(await redis.get(breakerKey(name)).catch(() => null));
}

async function recordSuccess(name: string): Promise<void> {
  await Promise.all([
    redis.incr(usageKey(name)).catch(() => {}),
    redis.expire(usageKey(name), 25 * 3600).catch(() => {}),
    redis.del(failsKey(name)).catch(() => {}),
  ]);
}

async function recordFailure(name: string): Promise<number> {
  let n = 0;
  try {
    n = await redis.incr(failsKey(name));
    await redis.expire(failsKey(name), FAILS_KEY_TTL).catch(() => {});
  } catch { /* redis hiccup → don't escalate the underlying error */ }
  if (n >= BREAKER_FAIL_THRESHOLD) {
    await redis.set(breakerKey(name), "1", "EX", BREAKER_OPEN_SECONDS).catch(() => {});
    L.warn("ai", `circuit breaker OPEN`, { provider: name, fails: n });
  }
  return n;
}

async function isOverQuota(p: AIProvider): Promise<boolean> {
  try {
    const raw = await redis.get(usageKey(p.name));
    return parseInt(raw || "0", 10) >= p.dailyQuota;
  } catch {
    return false;
  }
}

export interface FailoverOptions {
  // When true, only PDF-capable providers are considered. The
  // orchestrator uses this to try Gemini first, then loop again
  // with requirePDF=false for the text-only tier.
  requirePDF?: boolean;
  // Hard cap on how many providers to attempt. Defaults to all.
  maxAttempts?: number;
}

export async function runFailover(
  req: SummaryRequest,
  opts: FailoverOptions = {},
): Promise<SummaryResponse> {
  const candidates = ALL_PROVIDERS
    .filter(p => p.isConfigured())
    .filter(p => !p.premiumOnly || req.premium)
    .filter(p => !opts.requirePDF || p.supportsPDF)
    .sort((a, b) => a.priority - b.priority);

  if (candidates.length === 0) {
    throw new Error(`No providers configured for ${opts.requirePDF ? "PDF" : "text"} request`);
  }

  const max  = opts.maxAttempts ?? candidates.length;
  const errors: string[] = [];

  for (let i = 0; i < Math.min(max, candidates.length); i++) {
    const p = candidates[i];
    if (await isBreakerOpen(p.name)) {
      errors.push(`${p.name}: breaker open`);
      continue;
    }
    if (await isOverQuota(p)) {
      errors.push(`${p.name}: quota exhausted`);
      continue;
    }
    try {
      const out = await p.call(req);
      await recordSuccess(p.name);
      return out;
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 200);
      errors.push(`${p.name}: ${msg}`);
      await recordFailure(p.name);
      // Carry on to the next provider.
    }
  }

  throw new Error(
    `All providers failed (PDF=${!!opts.requirePDF}). Tried ${errors.length}: ${errors.join(" | ").slice(0, 800)}`,
  );
}

// Snapshot of provider state for an admin dashboard tab. Cheap —
// reads a handful of Redis keys, no upstream calls.
export async function getProvidersStatus(): Promise<Array<{
  name:        string;
  configured:  boolean;
  premiumOnly: boolean;
  supportsPDF: boolean;
  priority:    number;
  dailyQuota:  number;
  usedToday:   number;
  breakerOpen: boolean;
  failStreak:  number;
}>> {
  const out = await Promise.all(ALL_PROVIDERS.map(async (p) => {
    const [usedRaw, breaker, failsRaw] = await Promise.all([
      redis.get(usageKey(p.name)).catch(() => null),
      redis.get(breakerKey(p.name)).catch(() => null),
      redis.get(failsKey(p.name)).catch(() => null),
    ]);
    return {
      name:        p.name,
      configured:  p.isConfigured(),
      premiumOnly: !!p.premiumOnly,
      supportsPDF: p.supportsPDF,
      priority:    p.priority,
      dailyQuota:  p.dailyQuota,
      usedToday:   parseInt(usedRaw  || "0", 10),
      breakerOpen: !!breaker,
      failStreak:  parseInt(failsRaw || "0", 10),
    };
  }));
  return out.sort((a, b) => a.priority - b.priority);
}
