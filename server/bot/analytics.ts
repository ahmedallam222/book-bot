import { redis } from "./redis.js";
import {
  ANALYTICS_PREFIX,
  ANALYTICS_TTL,
  SOURCE_AUTO_DISABLE_MAX_RATE,
  SOURCE_AUTO_DISABLE_MIN_ATTEMPTS,
} from "./config.js";
import { L } from "./logger.js";

// ══════════════════════════════════════════════
// ANALYTICS — Redis-based stats tracking
// ══════════════════════════════════════════════

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DailyStats {
  date:        string;
  searches:    number;
  downloads:   number;
  success:     number;
  fail:        number;
  cacheHits:   number;
  successRate: string;
  cacheRate:   string;
  avgMs:       string;
  activeUsers: number;
}

export interface TotalStats {
  totalSearches:  number;
  totalDownloads: number;
}

export interface TopBook {
  title: string;
  count: number;
}

export interface SourceStat {
  domain:       string;
  ok:           number;
  fail:         number;
  total:        number;
  successRate:  number;
  rate:         string;
  autoDisabled: boolean;
}

export interface FunnelEntry {
  searchFound:   boolean;
  verifyChecked: number;
  verifyValid:   number;
  sendMode:      "direct" | "local" | null;
  sendSuccess:   boolean;
}

// ── Track ─────────────────────────────────────

export async function trackSearch(userId: string): Promise<void> {
  const d = todayKey();
  const pipe = redis.pipeline();
  pipe.incr(`${ANALYTICS_PREFIX}:search:${d}`);
  pipe.expire(`${ANALYTICS_PREFIX}:search:${d}`, ANALYTICS_TTL);
  pipe.sadd(`${ANALYTICS_PREFIX}:users:${d}`, userId);
  pipe.expire(`${ANALYTICS_PREFIX}:users:${d}`, ANALYTICS_TTL);
  await pipe.exec().catch(() => {});
}

export async function trackDownload(
  userId: string, bookName: string, found: boolean,
  fromCache: boolean, domain?: string, ms = 0
): Promise<void> {
  const d = todayKey();
  const pipe = redis.pipeline();
  pipe.incr(`${ANALYTICS_PREFIX}:download:${d}`);
  pipe.expire(`${ANALYTICS_PREFIX}:download:${d}`, ANALYTICS_TTL);

  if (found) {
    pipe.incr(`${ANALYTICS_PREFIX}:success:${d}`);
    pipe.expire(`${ANALYTICS_PREFIX}:success:${d}`, ANALYTICS_TTL);
    // IMP-7 FIX: كان يُخزَّن كـ key منفصل (stats:top:{date}:{title}) → SCAN O(n) في getTopBooks
    // الآن: ZINCRBY على ZSET واحد → O(log n) لكل تحديث وO(log n + k) لاسترداد الأفضل k
    const zKey = `${ANALYTICS_PREFIX}:topz:${d}`;
    pipe.zincrby(zKey, 1, bookName.slice(0, 60));
    pipe.expire(zKey, ANALYTICS_TTL);
  } else {
    pipe.incr(`${ANALYTICS_PREFIX}:fail:${d}`);
    pipe.expire(`${ANALYTICS_PREFIX}:fail:${d}`, ANALYTICS_TTL);
  }
  if (fromCache) {
    pipe.incr(`${ANALYTICS_PREFIX}:cache:${d}`);
    pipe.expire(`${ANALYTICS_PREFIX}:cache:${d}`, ANALYTICS_TTL);
  }
  if (ms > 0) {
    pipe.incrby(`${ANALYTICS_PREFIX}:ms:${d}`, Math.round(ms));
    pipe.expire(`${ANALYTICS_PREFIX}:ms:${d}`, ANALYTICS_TTL);
  }
  pipe.sadd(`${ANALYTICS_PREFIX}:users:${d}`, userId);
  pipe.expire(`${ANALYTICS_PREFIX}:users:${d}`, ANALYTICS_TTL);

  if (domain) {
    const dc = domain.replace(/[^a-z0-9.-]/gi, "");
    const k = found
      ? `${ANALYTICS_PREFIX}:src:${dc}:ok`
      : `${ANALYTICS_PREFIX}:src:${dc}:fail`;
    pipe.incr(k);
    pipe.expire(k, ANALYTICS_TTL);
  }
  await pipe.exec().catch(() => {});
}

export async function trackSourceAttempt(domain: string, ok: boolean): Promise<void> {
  const dc = domain.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "");
  if (!dc) return;

  const k = ok
    ? `${ANALYTICS_PREFIX}:src:${dc}:ok`
    : `${ANALYTICS_PREFIX}:src:${dc}:fail`;

  await redis.pipeline()
    .incr(k)
    .expire(k, ANALYTICS_TTL)
    .exec()
    .catch(() => {});
}

export async function trackFunnel(entry: FunnelEntry): Promise<void> {
  const d = todayKey();
  const base = `${ANALYTICS_PREFIX}:funnel:${d}`;
  const pipe = redis.pipeline();
  if (entry.searchFound)   pipe.hincrby(base, "searchFound",    1);
  if (!entry.searchFound)  pipe.hincrby(base, "searchMiss",     1);
  if (entry.sendSuccess)   pipe.hincrby(base, "sendSuccess",    1);
  if (entry.verifyChecked) pipe.hincrby(base, "verifyChecked",  entry.verifyChecked);
  if (entry.verifyValid)   pipe.hincrby(base, "verifyValid",    entry.verifyValid);
  if (entry.sendMode === "direct") pipe.hincrby(base, "sendDirect", 1);
  if (entry.sendMode === "local")  pipe.hincrby(base, "sendLocal",  1);
  pipe.expire(base, ANALYTICS_TTL);
  await pipe.exec().catch(() => {});
}

// ── Read ──────────────────────────────────────

let _dailyCache: { data: DailyStats; ts: number } | null = null;
const DAILY_CACHE_MS = 30_000;

export async function getDailyStats(date?: string): Promise<DailyStats> {
  const d = date || todayKey();
  const now = Date.now();
  if (!date && _dailyCache && now - _dailyCache.ts < DAILY_CACHE_MS) {
    return _dailyCache.data;
  }
  try {
    const r = (await redis.pipeline()
      .get(`${ANALYTICS_PREFIX}:search:${d}`)
      .get(`${ANALYTICS_PREFIX}:download:${d}`)
      .get(`${ANALYTICS_PREFIX}:success:${d}`)
      .get(`${ANALYTICS_PREFIX}:fail:${d}`)
      .get(`${ANALYTICS_PREFIX}:cache:${d}`)
      .get(`${ANALYTICS_PREFIX}:ms:${d}`)
      .scard(`${ANALYTICS_PREFIX}:users:${d}`)
      .exec().catch(() => [])) as [Error | null, string | number | null][];

    const n  = (i: number) => parseInt(String(r[i]?.[1] ?? "0"), 10) || 0;
    const s  = n(0), dl = n(1), ok = n(2), f = n(3), c = n(4), ms = n(5);
    const users = (typeof r[6]?.[1] === "number" ? r[6][1] as number : n(6));
    const sRate = dl > 0 ? `${Math.round((ok / dl) * 100)}%` : "0%";
    const cRate = dl > 0 ? `${Math.round((c  / dl) * 100)}%` : "0%";
    const avg   = ok > 0 ? `${Math.round(ms / ok)}`          : "0";
    const result: DailyStats = {
      date: d, searches: s, downloads: dl, success: ok, fail: f,
      cacheHits: c, successRate: sRate, cacheRate: cRate, avgMs: avg, activeUsers: users,
    };
    if (!date) _dailyCache = { data: result, ts: now };
    return result;
  } catch (e) {
    L.warn("analytics", `getDailyStats error: ${String(e).slice(0, 80)}`);
    return { date: d, searches: 0, downloads: 0, success: 0, fail: 0,
             cacheHits: 0, successRate: "0%", cacheRate: "0%", avgMs: "0", activeUsers: 0 };
  }
}

export function invalidateTodayStatsCache(): void {
  _dailyCache = null;
}

export async function getTotalStats(): Promise<TotalStats> {
  try {
    const dates = Array.from({ length: 32 }, (_, i) =>
      new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
    );
    const pipe = redis.pipeline();
    for (const d of dates) {
      pipe.get(`${ANALYTICS_PREFIX}:search:${d}`);
      pipe.get(`${ANALYTICS_PREFIX}:download:${d}`);
    }
    const res = (await pipe.exec().catch(() => [])) as [Error | null, string | null][];
    let totalSearches = 0, totalDownloads = 0;
    for (let i = 0; i < res.length; i += 2) {
      totalSearches  += parseInt(String(res[i]?.[1]   ?? "0"), 10) || 0;
      totalDownloads += parseInt(String(res[i+1]?.[1] ?? "0"), 10) || 0;
    }
    return { totalSearches, totalDownloads };
  } catch { return { totalSearches: 0, totalDownloads: 0 }; }
}

export async function getTopBooks(limit = 10, date?: string): Promise<TopBook[]> {
  const d = date || todayKey();
  try {
    // IMP-7 FIX: كان SCAN + N reads فردية → O(n) حيث n = عدد الكتب الفريدة في اليوم
    // الآن: ZREVRANGE مع WITHSCORES → O(log n + k) فقط مهما كبرت البيانات
    const zKey = `${ANALYTICS_PREFIX}:topz:${d}`;
    const raw = await redis.zrevrange(zKey, 0, limit - 1, "WITHSCORES");
    if (!raw || raw.length === 0) return [];

    const books: TopBook[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      books.push({ title: raw[i], count: parseInt(raw[i + 1] ?? "0", 10) || 0 });
    }
    return books;
  } catch { return []; }
}

export async function getSourceStats(): Promise<SourceStat[]> {
  try {
    let cursor = "0";
    const keys = new Set<string>();
    do {
      const [next, found] = await redis.scan(cursor, "MATCH", `${ANALYTICS_PREFIX}:src:*:ok`, "COUNT", 100);
      cursor = next;
      found.forEach((k) => keys.add(k));
    } while (cursor !== "0");

    cursor = "0";
    do {
      const [next, found] = await redis.scan(cursor, "MATCH", `${ANALYTICS_PREFIX}:src:*:fail`, "COUNT", 100);
      cursor = next;
      found.forEach((k) => keys.add(k));
    } while (cursor !== "0");
    if (keys.size === 0) return [];

    const domains = new Set<string>();
    for (const k of keys) {
      domains.add(k.replace(`${ANALYTICS_PREFIX}:src:`, "").replace(/:(ok|fail)$/, ""));
    }

    const pipe = redis.pipeline();
    for (const domain of domains) {
      pipe.get(`${ANALYTICS_PREFIX}:src:${domain}:ok`);
      pipe.get(`${ANALYTICS_PREFIX}:src:${domain}:fail`);
    }
    const vals = (await pipe.exec().catch(() => [])) as [Error | null, string | null][];

    return Array.from(domains).map((domain, i) => {
      const ok   = parseInt(String(vals[i * 2]?.[1]     ?? "0"), 10) || 0;
      const fail = parseInt(String(vals[i * 2 + 1]?.[1] ?? "0"), 10) || 0;
      const total = ok + fail;
      const successRate = total > 0 ? ok / total : 0;
      return {
        domain,
        ok,
        fail,
        total,
        successRate,
        rate: total > 0 ? `${Math.round(successRate * 100)}%` : "0%",
        autoDisabled: total >= SOURCE_AUTO_DISABLE_MIN_ATTEMPTS &&
          successRate <= SOURCE_AUTO_DISABLE_MAX_RATE,
      };
    }).sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail));
  } catch { return []; }
}

export async function getAutoDisabledSourceDomains(): Promise<Set<string>> {
  const stats = await getSourceStats();
  return new Set(stats.filter((s) => s.autoDisabled).map((s) => s.domain));
}

export async function getWeeklyStats(): Promise<DailyStats[]> {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10)
  );
  return Promise.all(days.map((d) => getDailyStats(d)));
}

// ── Funnel — مرحلة التشخيص ────────────────────────────────────

export interface FunnelStats {
  searchFound:   number;
  searchMiss:    number;
  sendSuccess:   number;
  verifyChecked: number;
  verifyValid:   number;
  sendDirect:    number;
  sendLocal:     number;
  /** نسبة البحث الناجح */
  searchRate: string;
  /** نسبة الإرسال الناجح بين من وجدوا نتائج */
  sendRate:   string;
  /** نسبة اجتياز التحقق */
  verifyRate: string;
}

/**
 * getFunnelStats — بيانات pipeline كاملة من البحث للإرسال.
 * تُساعد في تحديد سبب انخفاض نسبة النجاح:
 *   - searchMiss مرتفع → Firecrawl لا يجد نتائج كافية
 *   - verifyValid/verifyChecked منخفض → كثير من URLs غير صالحة
 *   - sendSuccess/searchFound منخفض → مشكلة تحميل بعد العثور
 */
export async function getFunnelStats(date?: string): Promise<FunnelStats | null> {
  const d = date || new Date().toISOString().slice(0, 10);
  const base = `${ANALYTICS_PREFIX}:funnel:${d}`;
  try {
    const raw = await redis.hgetall(base);
    if (!raw || Object.keys(raw).length === 0) return null;

    const n = (k: string) => parseInt(raw[k] ?? "0", 10) || 0;
    const found    = n("searchFound");
    const miss     = n("searchMiss");
    const success  = n("sendSuccess");
    const vChecked = n("verifyChecked");
    const vValid   = n("verifyValid");
    const total    = found + miss;

    return {
      searchFound:   found,
      searchMiss:    miss,
      sendSuccess:   success,
      verifyChecked: vChecked,
      verifyValid:   vValid,
      sendDirect:    n("sendDirect"),
      sendLocal:     n("sendLocal"),
      searchRate: total > 0    ? `${Math.round((found   / total)    * 100)}%` : "0%",
      sendRate:   found > 0    ? `${Math.round((success / found)    * 100)}%` : "0%",
      verifyRate: vChecked > 0 ? `${Math.round((vValid  / vChecked) * 100)}%` : "0%",
    };
  } catch { return null; }
}
