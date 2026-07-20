// Pure helpers for admin agent tools — unit-testable

export function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|1|yes|on)$/i.test(v);
  return fallback;
}

export function sanitizePattern(pat: string): string {
  if (!pat || pat === "*" || pat === "**" || pat.startsWith("*")) {
    throw new Error("pattern too broad — must include a literal prefix (e.g. 'cache:welib:*')");
  }
  const FORBIDDEN_PREFIXES = ["flag:", "premium:", "ai:breaker:", "admin:agent:"];
  for (const p of FORBIDDEN_PREFIXES) {
    if (pat.startsWith(p)) throw new Error(`pattern protected (${p}*)`);
  }
  return pat;
}

/** Derived rates for daily stats hashes — keeps LLM math consistent. */
export function deriveRates(d: Record<string, number>) {
  const requests = d.requests ?? 0;
  const found = d.found ?? 0;
  const downloads = d.downloads ?? 0;
  const cacheHits = d.cache_hits ?? 0;
  const searches = d.searches ?? 0;
  const pct = (n: number, d2: number) =>
    d2 > 0 ? Math.round((n / d2) * 1000) / 10 : null;
  return {
    raw: d,
    derived: {
      success_rate_pct: pct(found, requests),
      delivery_rate_pct: pct(downloads + cacheHits, requests),
      cache_hit_rate_pct: pct(cacheHits, requests),
      search_to_request_pct: pct(requests, searches),
      totals: { searches, requests, found, downloads, cache_hits: cacheHits },
    },
  };
}
