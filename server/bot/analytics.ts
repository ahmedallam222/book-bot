import { redis, scanKeys } from "./redis.js";
import {
  SOURCE_AUTO_DISABLE_MAX_RATE,
  SOURCE_AUTO_DISABLE_MIN_ATTEMPTS,
  SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS,
  SOURCE_AUTO_DISABLE_HARD_MAX_RATE,
  SOURCE_AUTO_DISABLE_TRUST_MIN_ATTEMPTS,
  SOURCE_AUTO_DISABLE_TRUST_MAX_RATE,
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
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
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
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split("T")[0];
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
        autoDisabled: autoDisabled || hardAutoDisabled || trustAutoDisabled,
        hardAutoDisabled,
        trustAutoDisabled,
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
          manuallyDisabled: true,
        });
      }
    }
    return results.sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail));
  } catch { return []; }
}

// Combines auto-disable (both tiers) + manual override. This is the
// single source of truth for `searchAllSources` filtering.
export async function getAutoDisabledSourceDomains(): Promise<Set<string>> {
  const [stats, manualOff] = await Promise.all([
    getSourceStats(),
    getManualDisabledSourceDomains(),
  ]);
  const out = new Set<string>(manualOff);
  for (const s of stats) if (s.autoDisabled) out.add(s.domain);
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
