import { redis, scanKeys } from "./redis.js";
import {
  cairoDateString, canonicalBookKey, isoWeekKey, isComplaintQuery,
} from "./text.js";
// personal week tracked from trackDownload when found
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

// Bug #11 — rolling-window source stats. The legacy keys
// `stats:source:{domain}` had NO TTL: a domain that failed 100 times
// last month + recovered to 100% ok this month was still tagged as a
// bad source forever (success rate = 50% all-time → still auto-
// disabled). The fix shards source stats into daily buckets and reads
// only the trailing window. After WINDOW_DAYS of healthy traffic, a
// previously-disabled source naturally re-qualifies.
const SOURCE_STATS_WINDOW_DAYS = 7;
const SOURCE_STATS_TTL_SEC     = (SOURCE_STATS_WINDOW_DAYS + 7) * 24 * 3600; // 14 days
const SOURCE_DOMAINS_INDEX     = "stats:source:domains";
const sourceDayKey = (domain: string, day: string) =>
  `stats:source:day:${domain}:${day}`;

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().split("T")[0]);
  }
  return out;
}

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
//
// Also folds known multi-host CDN families to one canonical bucket
// (see `canonicalizeDomain`) so e.g. dn790003.ca.archive.org and
// dn721904.ca.archive.org both record under `archive.org` instead of
// each looking like its own broken source in the admin /sources panel.
export function sanitizeDomainKey(domain: string): string {
  const normalized = (domain || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.-]/g, "");
  return canonicalizeDomain(normalized);
}

// Multi-host CDN families that should be tracked as a single source.
// Order matters — check most-specific first.
const CDN_FAMILIES: Array<{ match: RegExp; canonical: string }> = [
  // archive.org's CDN: dn720006.ca.archive.org, ia801501.us.archive.org,
  // dn790003.ca.archive.org, etc. All of them are just edge nodes for
  // the same Internet Archive backend.
  { match: /(^|\.)archive\.org$/, canonical: "archive.org" },
  // welib mirrors (welib.st, ar.welib.st, en.welib.st) → one bucket.
  // Note: signed-URL host welib-public.org is on a separate domain
  // family on purpose (different operational concerns) — we do NOT
  // fold those here.
  { match: /(^|\.)welib\.st$/,    canonical: "welib.st" },
];

export function canonicalizeDomain(domain: string): string {
  if (!domain) return "";
  for (const f of CDN_FAMILIES) {
    if (f.match.test(domain)) return f.canonical;
  }
  return domain;
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

// Bug #11 — helper: bump a single source counter into today's bucket
// and ensure the domain is in the index. Pipelined to keep the cost
// at one round-trip per attempt.
function recordSourceCounter(
  domain: string,
  field: "ok" | "fail" | "mistral_rejected",
): Promise<unknown> | undefined {
  const dc = sanitizeDomainKey(domain);
  if (!dc) return undefined;
  const day = todayKey();
  const dayKey = sourceDayKey(dc, day);
  return redis.pipeline()
    .sadd(SOURCE_DOMAINS_INDEX, dc)
    .hincrby(dayKey, field, 1)
    .expire(dayKey, SOURCE_STATS_TTL_SEC)
    .exec()
    .catch(() => null);
}

// ── Top-Books leaderboard keys ────────────────
//
// All-time global leaderboard: `stats:top_books` (sorted set, member=canonical key)
// Weekly bucket:               `stats:top_books:week:{ISO-week}` (TTL 21d)
// Display name (best pretty form per canonical key): `stats:top_books_display` (hash)
//
// لماذا فصلنا الـ display عن الـ key:
//   - الـ canonical key ضروري لدمج الصيغ (هكذا تتعافي/هكذا تتعافى → 1 entry)
//     لكنه نص lowercase معرّب يفتقد للقصة الجمالية.
//   - الـ display hash يحفظ "أحدث صياغة كنسية شفناها" (من cached.bookName
//     لو موجود، وإلا الـ user query) فالعرض يبقى مقروء.
//
// لماذا 21 يوم TTL على الأسبوعي:
//   - يكفي للأسبوع الحالي + هامش لو فيه DST/timezone edge — لو فيه
//     مستخدم في توقيت مختلف يكتب الأحد متأخر بنحفظ الـ bucket.
const WEEKLY_TOP_BOOKS_TTL_SEC = 21 * 24 * 3600;
const TOP_BOOKS_DISPLAY_HASH = "stats:top_books_display";
function weeklyTopBooksKey(week?: string): string {
  return `stats:top_books:week:${week ?? isoWeekKey()}`;
}
export const TOP_BOOKS_KEY = "stats:top_books";
export const TOP_BOOKS_DISPLAY_KEY = TOP_BOOKS_DISPLAY_HASH;
export { weeklyTopBooksKey };

// ── Download tracking ─────────────────────────
export async function trackDownload(
  userId: string, bookName: string, found: boolean, fromCache: boolean,
  domain?: string, ms?: number, canonicalTitle?: string,
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
  }
  // ── أكثر الكتب تحميلاً ─────────────────────
  //
  // FIX (PR #103): الـ leaderboard لازم يحسب كل التحميلات الناجحة،
  // سواء جت من الكاش أو من بحث جديد. الإصدار السابق كان داخل
  // gate `if (found && !fromCache)` فالـ cache hits ما كانتش
  // بتُحسب — يعني بمجرد ما الكتاب يتكاش، scoreه يتجمد.
  //
  // Source preference: العنوان الكنسي اللي البوت سلّمه (cached.bookName)
  // لو موجود — لأنه ثابت بغض النظر عن صياغة المستخدم. وإلا نرجع للـ
  // user query كـ fallback.
  //
  // الـ key نخزّنه canonicalBookKey() عشان يدمج صيغ مختلفة
  // (ى/ي، ة/ه، أ/إ/آ، ترقيم لاصق). الـ display name (الصيغة
  // الجمالية للعرض) نخزّنه في hash منفصل.
  if (found) {
    const sourceTitle = (canonicalTitle && canonicalTitle.trim())
      ? canonicalTitle.trim()
      : bookName.trim();
    const key = canonicalBookKey(sourceTitle);
    // skip لو الـ query شكوى أو الـ canonical key اتفرّغ
    if (key && !isComplaintQuery(bookName) && !isComplaintQuery(sourceTitle)) {
      const display = sourceTitle.slice(0, 200);
      const weeklyKey = weeklyTopBooksKey();
      pipe.zincrby(TOP_BOOKS_KEY, 1, key);
      pipe.zincrby(weeklyKey, 1, key);
      pipe.expire(weeklyKey, WEEKLY_TOP_BOOKS_TTL_SEC);
      // الـ display: نكتب آخر صياغة شفناها (نفضّل canonicalTitle لو موجود)
      pipe.hset(TOP_BOOKS_DISPLAY_HASH, key, display);
    }
  }
  touchDailyTtl(pipe, dailyKey);
  await pipe.exec().catch(() => {});
  // تقرير أسبوعي شخصي (fail-open)
  if (found) {
    try {
      const { recordPersonalWeekDownload } = await import("./personalWeek.js");
      const title = (canonicalTitle && canonicalTitle.trim()) ? canonicalTitle.trim() : bookName;
      await recordPersonalWeekDownload(userId, title);
    } catch { /* */ }
  }
  // Bug #11 — source counters now live in per-day buckets so the
  // rolling 7-day window can be aggregated on read.
  if (found && !fromCache && domain) await recordSourceCounter(domain, "ok");
  else if (!found && domain)         await recordSourceCounter(domain, "fail");
}

export async function trackSourceAttempt(domain: string, ok: boolean): Promise<void> {
  await recordSourceCounter(domain, ok ? "ok" : "fail");
}

// Mistral rejected the PDF as content-mismatch (wrong book). The source
// successfully delivered a real PDF — the search just picked a bad URL on
// this domain. Track separately so the auto-disable logic doesn't punish
// a working source for the search ranker's choices.
export async function trackSourceMistralReject(domain: string): Promise<void> {
  await recordSourceCounter(domain, "mistral_rejected");
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

// Reads the all-time top books leaderboard. Maps canonical keys back
// to their best display name via `stats:top_books_display`.
//
// Backward compat: legacy entries written before the canonical-key
// migration are still raw user queries — so لو الـ display hash مفيهاش
// مفتاح، نرجع الـ key نفسه كـ fallback.
export async function getTopBooks(limit = 15, _date?: string): Promise<{ book: string; count: number }[]> {
  try {
    const raw = await redis.zrevrange(TOP_BOOKS_KEY, 0, limit - 1, "WITHSCORES");
    return await mapZsetWithDisplay(raw);
  } catch { return []; }
}

export async function getWeeklyTopBooks(limit = 10): Promise<{ book: string; count: number }[]> {
  try {
    const raw = await redis.zrevrange(weeklyTopBooksKey(), 0, limit - 1, "WITHSCORES");
    return await mapZsetWithDisplay(raw);
  } catch { return []; }
}

async function mapZsetWithDisplay(
  raw: string[],
): Promise<{ book: string; count: number }[]> {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const keys: string[] = [];
  const counts: number[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    keys.push(raw[i]);
    counts.push(parseInt(raw[i + 1], 10) || 0);
  }
  let displays: (string | null)[] = [];
  try {
    if (keys.length > 0) {
      displays = await redis.hmget(TOP_BOOKS_DISPLAY_HASH, ...keys);
    }
  } catch { displays = []; }
  return keys.map((k, i) => ({
    book:  (displays[i] && displays[i]!.trim()) ? displays[i]! : k,
    count: counts[i],
  }));
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
    // Bug #11 — aggregate the trailing `SOURCE_STATS_WINDOW_DAYS` of
    // per-day buckets instead of the legacy all-time keys. Domains are
    // discovered from `SOURCE_DOMAINS_INDEX` (a Set) which avoids the
    // KEYS/SCAN cost on the Redis main thread. After 7+ days a
    // previously-disabled domain naturally rolls back to a clean state
    // — no manual re-enable needed.
    const domains = await redis.smembers(SOURCE_DOMAINS_INDEX);
    const days    = lastNDays(SOURCE_STATS_WINDOW_DAYS);
    const agg = new Map<string, { ok: number; fail: number; mistralRejected: number }>();
    if (domains.length > 0) {
      const pipe = redis.pipeline();
      const indexed: { domain: string; day: string }[] = [];
      for (const dom of domains) {
        for (const day of days) {
          pipe.hgetall(sourceDayKey(dom, day));
          indexed.push({ domain: dom, day });
        }
      }
      const res = await pipe.exec();
      const seen = new Set<string>();
      for (let i = 0; i < indexed.length; i++) {
        const { domain } = indexed[i];
        const raw = (res?.[i]?.[1] as Record<string, string> | null) || {};
        const ok              = parseInt(raw.ok               || "0", 10);
        const fail            = parseInt(raw.fail             || "0", 10);
        const mistralRejected = parseInt(raw.mistral_rejected || "0", 10);
        if (ok || fail || mistralRejected) seen.add(domain);
        const cur = agg.get(domain) ?? { ok: 0, fail: 0, mistralRejected: 0 };
        cur.ok              += ok;
        cur.fail            += fail;
        cur.mistralRejected += mistralRejected;
        agg.set(domain, cur);
      }
      // GC the index: drop domains with no activity in the window so
      // the read cost stays bounded as old sources retire.
      const stale = domains.filter((d) => !seen.has(d));
      if (stale.length > 0) {
        redis.srem(SOURCE_DOMAINS_INDEX, ...stale).catch(() => {});
        for (const dom of stale) agg.delete(dom);
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

// Re-orders the provided sources by recent trustRate (ok / total_with_rejects)
// over the rolling stats window. Sources whose rolling sample size is below
// `minSamples` keep their static priority — protects new or quiet sources
// from being promoted/demoted by a 1-2-attempt sample. The returned array is
// a new Array<T>; the input is not mutated.
//
// Tie-breaking: equal trustRate (or both unranked) → static `priority` order.
//
// Generic over T extends { domain: string; priority: number } so callers can
// pass `SourceConfig` directly without re-mapping.
export function rankSourcesByTrust<T extends { domain: string; priority: number }>(
  sources:    readonly T[],
  stats:      readonly SourceStat[],
  minSamples: number,
): T[] {
  // domain → { trust, samples }. Domains absent from stats stay unranked.
  const trustMap = new Map<string, { trust: number; samples: number }>();
  for (const s of stats) {
    trustMap.set(s.domain, { trust: s.trustRate, samples: s.totalWithRejects });
  }
  const ranked = (s: T): number | null => {
    const entry = trustMap.get(s.domain);
    if (!entry) return null;
    if (minSamples > 0 && entry.samples < minSamples) return null;
    return entry.trust;
  };
  return [...sources].sort((a, b) => {
    const ra = ranked(a);
    const rb = ranked(b);
    if (ra !== null && rb !== null) {
      if (ra !== rb) return rb - ra;       // higher trustRate first
      return a.priority - b.priority;       // tiebreak: static priority
    }
    if (ra !== null) return -1;             // ranked sources before unranked
    if (rb !== null) return 1;
    return a.priority - b.priority;         // both unranked: static priority
  });
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
