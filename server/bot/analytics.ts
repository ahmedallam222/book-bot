import { redis, scanKeys } from "./redis.js";
import { cairoDateString } from "./text.js";
import {
  SOURCE_AUTO_DISABLE_MAX_RATE,
  SOURCE_AUTO_DISABLE_MIN_ATTEMPTS,
  SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS,
  SOURCE_AUTO_DISABLE_HARD_MAX_RATE,
  SOURCE_AUTO_DISABLE_TRUST_MIN_ATTEMPTS,
  SOURCE_AUTO_DISABLE_TRUST_MAX_RATE,
  SOURCE_AUTO_DISABLE_MISTRAL_ONLY_MIN_REJECTS,
  SOURCE_AUTO_DISABLE_MISTRAL_ONLY_REJECT_RATIO,
} from "./config.js";

// ══════════════════════════════════════════════
// SOURCE manual-disable (admin override)
//
// `src:off:{domain}` يكتبه الـ dashboard / Telegram لإيقاف مصدر يدوياً.
// كان يُكتب بدون قارئ — إصلاحه هنا (engine يقرأ getManualDisabledSourceDomains).
// ══════════════════════════════════════════════
const MANUAL_DISABLE_KEY_PREFIX = "src:off:";
const manualDisableKey = (domain: string) =>
  `${MANUAL_DISABLE_KEY_PREFIX}${sanitizeDomainKey(domain)}`;

export async function isSourceManuallyDisabled(domain: string): Promise<boolean> {
  try { return (await redis.exists(manualDisableKey(domain))) === 1; }
  catch { return false; }
}

export async function setSourceManuallyDisabled(
  domain: string, off: boolean,
): Promise<void> {
  const key = manualDisableKey(domain);
  try {
    if (off) await redis.set(key, "1");
    else     await redis.del(key);
  } catch {}
  // Admin expects the toggle to take effect on the next search — invalidate
  // the in-memory cache so getAutoDisabledSourceDomains() recomputes.
  invalidateDisabledSourcesCache();
}

export async function getManualDisabledSourceDomains(): Promise<Set<string>> {
  try {
    // PERF: استبدال KEYS بـ SCAN — يتجنّب حجب Redis عند زيادة عدد المفاتيح.
    const keys = await scanKeys(`${MANUAL_DISABLE_KEY_PREFIX}*`);
    return new Set(
      keys.map((k) => sanitizeDomainKey(k.slice(MANUAL_DISABLE_KEY_PREFIX.length)))
        .filter(Boolean),
    );
  } catch { return new Set(); }
}

// ══════════════════════════════════════════════
// ANALYTICS — إحصاءات وتتبع
// ══════════════════════════════════════════════

function todayKey(): string {
  // Cairo TZ — يماشي downloadCount/buildResetTime/summaryUsage. لو
  // analytics keys اتكتبت بـ UTC، الـ "اليوم" بيظهر مختلف عن الـ daily
  // limits row في الـ DB (مما يصعّب الـ debugging والـ correlations).
  return cairoDateString(); // YYYY-MM-DD
}

// ── Daily-stats retention ─────────────────────
//
// `stats:daily:{day}` و `stats:funnel:{day}` كانا يُكتَبان بـ HINCRBY فقط بدون
// انتهاء صلاحية → تتراكم هاشات يومية للأبد في Redis (365 hash/سنة لمستخدم
// واحد). معظمها لا يُقرأ بعد آخر 7 أيام (getWeeklyStats). نضع TTL مرتاح يكفي
// تحاليل ربع-سنوية ويسمح بالـ idempotent extend عند الكتابة اليومية.
const DAILY_STATS_TTL_SEC = 90 * 24 * 3600; // 90 days

// EXPIRE هو NX-من-الجانب-المُقدَّم: إعادة استدعائه يومياً تُجدد TTL لـ 90 يوم —
// آمن لأن الـ EXPIRE تُعيد الـ TTL وليس extend cumulative.
function touchDailyTtl(pipe: ReturnType<typeof redis.pipeline>, key: string): void {
  pipe.expire(key, DAILY_STATS_TTL_SEC);
}

// Normalize a hostname into a Redis-key-safe domain identifier.
// Single source of truth — historically `trackDownload` wrote raw
// hostnames (so `bookleaks.com` and `www.bookleaks.com` ended up in
// separate `stats:source:*` keys) while `trackSourceAttempt` /
// `trackSourceMistralReject` already normalized. The split made
// `getSourceStats` over-report distinct sources and skewed the
// auto-disable signal. All write paths now go through this helper.
export function sanitizeDomainKey(domain: string): string {
  return (domain || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]/g, "");
}

// ── Search tracking ───────────────────────────
export async function trackSearch(userId: string): Promise<void> {
  const day = todayKey();
  const dailyKey = `stats:daily:${day}`;
  const pipe = redis.pipeline()
    .hincrby(dailyKey, "searches", 1)
    .hincrby("stats:total", "searches", 1);
  touchDailyTtl(pipe, dailyKey);
  await pipe.exec().catch(() => {});
}

// ── Download tracking ─────────────────────────
export async function trackDownload(
  userId: string, bookName: string, found: boolean, fromCache: boolean,
  domain?: string, ms?: number
): Promise<void> {
  const day = todayKey();
  const dailyKey = `stats:daily:${day}`;
  const pipe = redis.pipeline()
    .hincrby(dailyKey, "requests", 1);
  if (found)     pipe.hincrby(dailyKey, "found", 1);
  if (fromCache) pipe.hincrby(dailyKey, "cache_hits", 1);
  if (found && !fromCache) {
    pipe.hincrby(dailyKey, "downloads", 1);
    pipe.hincrby("stats:total", "downloads", 1);
    // أكثر الكتب تحميلاً
    pipe.zincrby("stats:top_books", 1, bookName.slice(0, 100));
    // أداء المصادر
    const dc = sanitizeDomainKey(domain || "");
    if (dc) pipe.hincrby(`stats:source:${dc}`, "ok", 1);
  } else if (!found && domain) {
    const dc = sanitizeDomainKey(domain);
    if (dc) pipe.hincrby(`stats:source:${dc}`, "fail", 1);
  }
  touchDailyTtl(pipe, dailyKey);
  await pipe.exec().catch(() => {});
}

export async function trackSourceAttempt(domain: string, ok: boolean): Promise<void> {
  const dc = sanitizeDomainKey(domain);
  if (!dc) return;
  await redis.hincrby(`stats:source:${dc}`, ok ? "ok" : "fail", 1).catch(() => {});
}

// Mistral rejected the PDF as content-mismatch (wrong book). The source
// successfully delivered a real PDF — the search just picked a bad URL on
// this domain. Track separately so the auto-disable logic doesn't punish
// a working source for the search ranker's choices.
export async function trackSourceMistralReject(domain: string): Promise<void> {
  const dc = sanitizeDomainKey(domain);
  if (!dc) return;
  await redis.hincrby(`stats:source:${dc}`, "mistral_rejected", 1).catch(() => {});
}

// ── Funnel tracking ───────────────────────────
export interface FunnelEvent {
  searchFound:   boolean;
  verifyChecked: number;
  verifyValid:   number;
  sendMode:      "direct" | "local" | null;
  sendSuccess:   boolean;
}

export async function trackFunnel(event: FunnelEvent): Promise<void> {
  const day  = todayKey();
  const key  = `stats:funnel:${day}`;
  const pipe = redis.pipeline()
    .hincrby(key, "total", 1);
  if (event.searchFound)  pipe.hincrby(key, "search_found", 1);
  if (event.sendSuccess)  pipe.hincrby(key, "send_success", 1);
  if (event.sendMode === "direct") pipe.hincrby(key, "send_direct", 1);
  if (event.sendMode === "local")  pipe.hincrby(key, "send_local", 1);
  pipe.hincrby(key, "verify_checked", event.verifyChecked);
  pipe.hincrby(key, "verify_valid",   event.verifyValid);
  touchDailyTtl(pipe, key);
  await pipe.exec().catch(() => {});
}

// ── Stats readers ─────────────────────────────
export async function getDailyStats(date?: string): Promise<Record<string, number>> {
  const day = date || todayKey();
  try {
    const raw = await redis.hgetall(`stats:daily:${day}`);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw || {})) out[k] = parseInt(v, 10) || 0;
    return out;
  } catch { return {}; }
}

export async function getTotalStats(): Promise<Record<string, number>> {
  try {
    const raw = await redis.hgetall("stats:total");
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw || {})) out[k] = parseInt(v, 10) || 0;
    return out;
  } catch { return {}; }
}

export async function getTopBooks(limit = 15, _date?: string): Promise<{ book: string; count: number }[]> {
  try {
    const raw = await redis.zrevrange("stats:top_books", 0, limit - 1, "WITHSCORES");
    const out: { book: string; count: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      out.push({ book: raw[i], count: parseInt(raw[i + 1], 10) || 0 });
    }
    return out;
  } catch { return []; }
}

// PERF FIX: كان يصدر 7 round-trips متسلسلة (await في loop) → ~50ms latency
// إضافية على كل استدعاء (admin panel + dashboard). الآن: pipeline واحد بسبع
// HGETALL → round-trip واحد. الترتيب محفوظ لأن exec() تعيد النتائج بنفس
// ترتيب الأوامر المُضافة.
export async function getWeeklyStats(): Promise<Record<string, Record<string, number>>> {
  const days: Record<string, Record<string, number>> = {};
  const now  = new Date();
  const keys: string[] = [];
  const pipe = redis.pipeline();
  for (let i = 6; i >= 0; i--) {
    // Cairo TZ — نسحب آخر 7 أيام بتاريخ القاهرة عشان يطابق الكتابات.
    // 86400 يوم تقريبية: نفع لأن أنحنا بنحوّل لـ Cairo date string بعدها.
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = cairoDateString(d);
    keys.push(key);
    pipe.hgetall(`stats:daily:${key}`);
  }
  try {
    const res = await pipe.exec();
    if (!res) return Object.fromEntries(keys.map((k) => [k, {}]));
    for (let i = 0; i < keys.length; i++) {
      const raw = (res[i]?.[1] as Record<string, string> | null) || {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) out[k] = parseInt(v, 10) || 0;
      days[keys[i]] = out;
    }
  } catch {
    for (const k of keys) days[k] = {};
  }
  return days;
}

export interface SourceStat {
  domain: string;
  ok: number;
  fail: number;
  mistralRejected: number;
  total: number; // ok + fail (بدون mistral_rejected)
  // إجمالي التفاعلات بما فيها مراجعات Mistral — يمثّل التكلفة الحقيقية
  // لاستخدام المصدر (ولو Mistral رفضها فهي فشل تجربة مستخدم).
  totalWithRejects: number;
  successRate: number;
  // معدّل الثقة (trust): ok / (ok + fail + mistralRejected) — يعكس
  // احتمال إيصال الكتاب الصحيح للمستخدم من هذا المصدر.
  // إنتاج Hindawi: 13/(13+34+29) = 17% (vs successRate 27%).
  trustRate: number;
  rate: string;
  autoDisabled: boolean;
  // Hard-fail tier: مصدر بحد أدنى محاولات صغير ونسبة نجاح صفرية تقريباً —
  // catastrophic. يحجب أسرع من الـ tier العادي.
  hardAutoDisabled: boolean;
  // Trust tier: مصدر بيرجّع PDFs لكن Mistral بيرفضها بكثافة (أي:
  // في search-ranker بعرف يحطّ الروابط الغلط من هذا الدومين).
  // Hindawi: 17% trust rate → يتحجب تلقائياً بـ trust tier.
  trustAutoDisabled: boolean;
  // Mistral-only catastrophic tier: مصدر بـ ok/fail قليلين لكن Mistral
  // بيرفض بكثافة. الـ TRUST tier محتاج 10 totalWithRejects، فالمصادر
  // الـ Mistral-only ذات الـ 5-9 rejects تعدّي بدون حجب.
  // مثال: dn790009.ca.archive.org → 0/0/7 → بيتحجب هنا.
  mistralOnlyAutoDisabled: boolean;
  manuallyDisabled: boolean;
}

export async function getSourceStats(): Promise<SourceStat[]> {
  try {
    // PERF: استبدال KEYS بـ SCAN — `getSourceStats` تُستدعى من
    // `getAutoDisabledSourceDomains` وهذي تُستدعى من `engine.searchAllSources`
    // قبل cache check، أي على كل طلب بحث. على Redis بآلاف المفاتيح كان
    // الـ KEYS بيضيف ~5–50ms latency لكل بحث ويمنع أوامر أخرى أثناء التنفيذ.
    const keys = await scanKeys("stats:source:*");
    // Aggregate by sanitized domain so legacy `www.*` keys merge
    // with their canonical counterparts. Going forward all writes go
    // through `sanitizeDomainKey()`; this read-side merge cleans up
    // historical splits without requiring a migration.
    const agg = new Map<string, { ok: number; fail: number; mistralRejected: number }>();
    if (keys.length > 0) {
      const pipe = redis.pipeline();
      for (const key of keys) pipe.hgetall(key);
      const res = await pipe.exec();
      for (let i = 0; i < keys.length; i++) {
        const rawDomain = keys[i].replace("stats:source:", "");
        const domain = sanitizeDomainKey(rawDomain) || rawDomain;
        const raw = (res?.[i]?.[1] as Record<string, string> | null) || {};
        const ok = parseInt(raw.ok || "0", 10);
        const fail = parseInt(raw.fail || "0", 10);
        const mistralRejected = parseInt(raw.mistral_rejected || "0", 10);
        const cur = agg.get(domain) ?? { ok: 0, fail: 0, mistralRejected: 0 };
        cur.ok += ok;
        cur.fail += fail;
        cur.mistralRejected += mistralRejected;
        agg.set(domain, cur);
      }
    }
    const manualOff = await getManualDisabledSourceDomains();
    const results: SourceStat[] = [];
    for (const [domain, c] of agg) {
      const total = c.ok + c.fail;
      const totalWithRejects = c.ok + c.fail + c.mistralRejected;
      const successRate = total > 0 ? c.ok / total : 0;
      const trustRate = totalWithRejects > 0 ? c.ok / totalWithRejects : 0;
      const autoDisabled = total >= SOURCE_AUTO_DISABLE_MIN_ATTEMPTS &&
        successRate <= SOURCE_AUTO_DISABLE_MAX_RATE;
      const hardAutoDisabled = total >= SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS &&
        successRate <= SOURCE_AUTO_DISABLE_HARD_MAX_RATE;
      // Trust tier: لو المصدر تجاوز الحد الأدنى للمحاولات ووجد mistralRejected
      // حقيقي (عشان ما نحجبش مصدر سليم بصفر رفض) والثقة تحت العتبة، فاحجب.
      const trustAutoDisabled = totalWithRejects >= SOURCE_AUTO_DISABLE_TRUST_MIN_ATTEMPTS &&
        c.mistralRejected > 0 &&
        trustRate <= SOURCE_AUTO_DISABLE_TRUST_MAX_RATE;
      // Mistral-only catastrophic tier: rejects كتير، نجاح قليل أو معدوم.
      // مستقل عن totalWithRejects threshold عشان يقدر يمسك الـ subdomains
      // الـ archive.org الفاشلة قبل ما توصل لـ 10 attempts.
      const mistralOnlyAutoDisabled =
        c.mistralRejected >= SOURCE_AUTO_DISABLE_MISTRAL_ONLY_MIN_REJECTS &&
        c.mistralRejected >= c.ok * SOURCE_AUTO_DISABLE_MISTRAL_ONLY_REJECT_RATIO;
      results.push({
        domain,
        ok: c.ok,
        fail: c.fail,
        mistralRejected: c.mistralRejected,
        total,
        totalWithRejects,
        successRate,
        trustRate,
        rate: total > 0 ? `${Math.round(successRate * 100)}%` : "0%",
        autoDisabled: autoDisabled || hardAutoDisabled || trustAutoDisabled || mistralOnlyAutoDisabled,
        hardAutoDisabled,
        trustAutoDisabled,
        mistralOnlyAutoDisabled,
        manuallyDisabled: manualOff.has(domain),
      });
    }
    // Include manually-disabled domains that have no stats yet (admin
    // pre-emptively disabled them) — so they remain visible/togglable.
    for (const domain of manualOff) {
      if (!agg.has(domain)) {
        results.push({
          domain, ok: 0, fail: 0, mistralRejected: 0,
          total: 0, totalWithRejects: 0,
          successRate: 0, trustRate: 0, rate: "0%",
          autoDisabled: false, hardAutoDisabled: false, trustAutoDisabled: false,
          mistralOnlyAutoDisabled: false,
          manuallyDisabled: true,
        });
      }
    }
    return results.sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail));
  } catch { return []; }
}

// PERF: in-memory TTL cache — `getAutoDisabledSourceDomains` تُستدعى من
// `engine.searchAllSources` على كل طلب بحث (قبل cache check)، و `getSourceStats`
// تُستدعى من `bookRequest.ts` على كل full-search متعدد المصادر للترتيب.
// كلاهما كان ينفّذ SCAN + N×HGETALL لكل request — ~5+ round-trips على Redis.
//
// التصميم: نخزّن النتائج في الذاكرة لـ 30 ثانية فقط:
//   * auto-disable يتراكم تدريجياً (failures count up)، فـ 30s staleness
//     مقبولة — على الأكثر بضعة failed attempts إضافية من مصدر جديد قبل
//     الحجب الفعلي.
//   * trust-rate ranking في bookRequest.ts بيستخدم نسب تراكمية، فـ 30s
//     staleness على القيم المتراكمة لا تؤثر فعلياً على الترتيب.
//   * manual toggle يُلغي الـ cache فوراً عبر invalidateDisabledSourcesCache
//     في `setSourceManuallyDisabled` ليرى الـ admin النتيجة فوراً (الـ
//     manuallyDisabled flag ضمن SourceStat[]).
//
// النسخة الـ uncached (`getSourceStats`) لسه متاحة للـ admin dashboards
// والـ Telegram /sources panel حيث الـ freshness أهم من الـ latency.
//
// Process-local فقط (لا يعمل multi-instance) — لا مشكلة لأن الـ deploy
// الحالي عبر Docker Compose مع instance واحد للـ bot.
const DISABLED_CACHE_TTL_MS = 30_000;
const SOURCE_STATS_CACHE_TTL_MS = 30_000;
let _disabledCache: { value: Set<string>; expiry: number } | null = null;
let _sourceStatsCache: { value: SourceStat[]; expiry: number } | null = null;

export function invalidateDisabledSourcesCache(): void {
  _disabledCache = null;
  // الـ source-stats cache بيشيل الـ manuallyDisabled flag — ندبس admin toggle
  // يلتقط فوراً في الـ admin views اللي تستخدم النسخة المعتمد عليها.
  _sourceStatsCache = null;
}

/**
 * Same as `getSourceStats()` but with a process-local 30s TTL cache.
 * Use this in hot paths (e.g. `bookRequest.ts` URL ranking) where 30s
 * staleness on success-rate counters is fully acceptable. The uncached
 * `getSourceStats()` is preferred for admin dashboards / Telegram
 * /sources panel where the latest counts matter.
 */
export async function getSourceStatsCached(): Promise<SourceStat[]> {
  if (_sourceStatsCache && Date.now() < _sourceStatsCache.expiry) {
    return _sourceStatsCache.value;
  }
  const stats = await getSourceStats();
  _sourceStatsCache = { value: stats, expiry: Date.now() + SOURCE_STATS_CACHE_TTL_MS };
  return stats;
}

// Combines auto-disable (both tiers) + manual override. This is the
// single source of truth for `searchAllSources` filtering.
export async function getAutoDisabledSourceDomains(): Promise<Set<string>> {
  if (_disabledCache && Date.now() < _disabledCache.expiry) {
    return _disabledCache.value;
  }
  // نستخدم النسخة الـ cached من getSourceStats — لو الـ cache دافي،
  // الـ getAutoDisabledSourceDomains cache miss يخلص بدون أي Redis ops.
  const [stats, manualOff] = await Promise.all([
    getSourceStatsCached(),
    getManualDisabledSourceDomains(),
  ]);
  const out = new Set<string>(manualOff);
  for (const s of stats) if (s.autoDisabled) out.add(s.domain);
  _disabledCache = { value: out, expiry: Date.now() + DISABLED_CACHE_TTL_MS };
  return out;
}

export async function getFunnelStats(date?: string): Promise<Record<string, number>> {
  const day = date || todayKey();
  try {
    const raw = await redis.hgetall(`stats:funnel:${day}`);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw || {})) out[k] = parseInt(v, 10) || 0;
    return out;
  } catch { return {}; }
}
