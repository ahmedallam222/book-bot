// ══════════════════════════════════════════════════════════
// Admin Agent — tool registry
// ══════════════════════════════════════════════════════════
// Defines every read/write tool the LLM can call. Each tool has:
//   - `name`           — stable identifier the LLM emits
//   - `description`    — one-line summary the LLM sees
//   - `parameters`     — JSON-schema for OpenAI tool-calling
//   - `isWrite`        — destructive ops require confirm flow
//   - `run(args)`      — actual handler; returns serialisable result
//
// To add a tool: append an entry to TOOLS. The LLM picks it up
// automatically via TOOL_DEFINITIONS — no other plumbing needed.

import { redis, scanKeys } from "../redis.js";
import { getRecentLogs, getLogBufferStats } from "../logBuffer.js";
import {
  getDailyStats, getTotalStats, getTopBooks, getWeeklyStats,
  getSourceStats, getFunnelStats,
  setSourceManuallyDisabled, isSourceManuallyDisabled,
} from "../analytics.js";
import { getQueueStats, getDLQJobs, clearDLQ, cancelUserJobs } from "../queue.js";
import { blacklistStats } from "../blacklist.js";
import { getPdfValidationStats } from "../pdfValidator.js";
import { getRecentTraces } from "../telemetry.js";
import {
  isPremium, setPremium, getPremiumExpiry, listPremiumUsers, premiumCount,
} from "../userSettings.js";
import { storage } from "../../storage.js";
import { MAINTENANCE_KEY } from "../config.js";
import {
  loadAllProvidersRaw, setProvider, removeProvider, getProvider,
  publicView, type LLMProvider,
} from "./llmProviders.js";
import { getProviderStats, resetProviderTelemetry } from "./llmTelemetry.js";
import {
  saveKnowledge, recallKnowledge, deleteKnowledge, knowledgeCount,
} from "./memory.js";
import { triggerHealthCheck, getProactiveLog } from "./proactive.js";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(execCb);

// ──────────────────────────────────────────────────────────
export interface ToolRunCtx {
  userId: string;
}

export interface Tool {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>; // JSON schema
  isWrite:     boolean;                 // requires confirm flow
  run(args: Record<string, unknown>, ctx: ToolRunCtx): Promise<unknown>;
}

// ── helpers ───────────────────────────────────────────────
function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string")  return /^(true|1|yes|on)$/i.test(v);
  return fallback;
}

function sanitizePattern(pat: string): string {
  // Reject dangerous patterns. We never let the LLM nuke everything.
  if (!pat || pat === "*" || pat === "**" || pat.startsWith("*")) {
    throw new Error("pattern too broad — must include a literal prefix (e.g. 'cache:welib:*')");
  }
  // Forbid clearing core system keys.
  const FORBIDDEN_PREFIXES = ["flag:", "premium:", "ai:breaker:", "admin:agent:"];
  for (const p of FORBIDDEN_PREFIXES) {
    if (pat.startsWith(p)) throw new Error(`pattern protected (${p}*)`);
  }
  return pat;
}

// ══════════════════════════════════════════════════════════
// READ TOOLS (15)
// ══════════════════════════════════════════════════════════

const TOOL_GET_COUNTERS: Tool = {
  name:        "get_counters",
  description: "اقرأ counters من Redis بـ pattern (مثلاً tel:*، tel:tg:*، tel:pdf:*). يرجع key→value (max 50).",
  parameters:  {
    type:       "object",
    properties: {
      pattern: { type: "string", description: "نمط البحث (e.g. 'tel:tg:*'). يجب أن يبدأ بـ 'tel:'." },
      limit:   { type: "integer", description: "أقصى عدد مفاتيح (default 30)" },
    },
    required: ["pattern"],
  },
  isWrite: false,
  async run(args) {
    const pattern = asStr(args.pattern);
    const limit   = Math.min(asNum(args.limit, 30), 50);
    if (!pattern.startsWith("tel:")) throw new Error("pattern must start with 'tel:'");
    const keys = (await scanKeys(pattern)).slice(0, limit);
    if (keys.length === 0) return { keys: [], note: "لا توجد مفاتيح مطابقة" };
    const values = await redis.mget(...keys);
    const out: Record<string, string | null> = {};
    keys.forEach((k, i) => { out[k] = values[i]; });
    return out;
  },
};

const TOOL_GET_QUEUE_STATUS: Tool = {
  name:        "get_queue_status",
  description: "اقرأ حالة طابور الطلبات (pending، active، DLQ).",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const stats = await getQueueStats();
    return stats;
  },
};

const TOOL_GET_DLQ_JOBS: Tool = {
  name:        "get_dlq_jobs",
  description: "آخر jobs فشلت وراحت لـ DLQ (Dead Letter Queue).",
  parameters:  {
    type:       "object",
    properties: { limit: { type: "integer", description: "max 30" } },
  },
  isWrite: false,
  async run(args) {
    const limit = Math.min(asNum(args.limit, 10), 30);
    const jobs  = await getDLQJobs(limit);
    return jobs.map(j => ({
      jobId:     j.id,
      userId:    j.userId,
      book:      j.bookName,
      retries:   j.retries,
      createdAt: j.createdAt,
    }));
  },
};

// Compute derived rates given a daily stats hash. Returns NaN-safe
// percentages (rounded to 1 decimal) plus the raw fields. Used by
// today/weekly/quick_overview tools — keeps the LLM from having to
// do the math (and from saying "غير متاح" when the answer is right
// there but expressed as a ratio).
function deriveRates(d: Record<string, number>) {
  const requests   = d.requests   ?? 0;
  const found      = d.found      ?? 0;
  const downloads  = d.downloads  ?? 0;
  const cacheHits  = d.cache_hits ?? 0;
  const searches   = d.searches   ?? 0;
  const pct = (n: number, d2: number) => d2 > 0 ? Math.round((n / d2) * 1000) / 10 : null;
  return {
    raw: d,
    derived: {
      success_rate_pct:    pct(found, requests),         // found / requests
      delivery_rate_pct:   pct(downloads + cacheHits, requests),
      cache_hit_rate_pct:  pct(cacheHits, requests),
      search_to_request_pct: pct(requests, searches),    // how many searches turn into downloads attempts
      totals: { searches, requests, found, downloads, cache_hits: cacheHits },
    },
  };
}

const TOOL_GET_TODAY_STATS: Tool = {
  name:        "get_today_stats",
  description: "إحصاءات اليوم (Cairo TZ): raw counts + derived rates (success/delivery/cache_hit %).",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const d = await getDailyStats();
    return deriveRates(d);
  },
};

const TOOL_GET_WEEKLY_STATS: Tool = {
  name:        "get_weekly_stats",
  description: "إحصاءات آخر 7 أيام: لكل يوم + إجمالي الأسبوع + متوسط نسبة النجاح.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const w = await getWeeklyStats();
    const days = Object.entries(w).map(([day, d]) => ({ day, ...deriveRates(d).derived }));
    // Weekly totals + average success rate (weighted across days).
    const totals = { searches: 0, requests: 0, found: 0, downloads: 0, cache_hits: 0 };
    for (const d of Object.values(w)) {
      totals.searches   += d.searches   ?? 0;
      totals.requests   += d.requests   ?? 0;
      totals.found      += d.found      ?? 0;
      totals.downloads  += d.downloads  ?? 0;
      totals.cache_hits += d.cache_hits ?? 0;
    }
    const pct = (n: number, d2: number) => d2 > 0 ? Math.round((n / d2) * 1000) / 10 : null;
    return {
      days,
      weekly_totals: totals,
      weekly_avg_success_pct:  pct(totals.found, totals.requests),
      weekly_avg_delivery_pct: pct(totals.downloads + totals.cache_hits, totals.requests),
    };
  },
};

const TOOL_GET_TOTAL_STATS: Tool = {
  name:        "get_total_stats",
  description:
    "الإحصاءات الإجمالية للبوت من بدايته (Redis counters). " +
    "ملاحظة: حقل `users` هنا = المستخدمون الذين قاموا بالبحث (= distinctSearchers)، " +
    "وليس كل من ضغط /start. للعدد الكامل للمستخدمين في قاعدة البيانات استخدم `get_user_count`.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    return await getTotalStats();
  },
};

const TOOL_GET_USER_COUNT: Tool = {
  name:        "get_user_count",
  description:
    "عدد مستخدمي البوت الفعلي. يرجع: " +
    "`total_users_db` (كل من له صف في جدول users، يشمل من ضغط /start ولم يبحث) + " +
    "`distinct_searchers` (من بحث فعلاً، من Redis stats:total) + " +
    "`premium_users` (المستخدمون الفعّالون كـ premium). " +
    "استخدم هذا للسؤال 'كم مستخدم في البوت؟' بدل get_total_stats.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const [dbRes, totalStats, premiumN] = await Promise.all([
      // limit=1, offset=0 → returns total without loading rows
      storage.getAllUsersWithDetails(1, 0).catch(() => ({ users: [], total: 0 })),
      getTotalStats().catch(() => ({} as Record<string, number>)),
      premiumCount().catch(() => 0),
    ]);
    const totalDb = dbRes.total ?? 0;
    const distinct =
      (totalStats.distinctSearchers as number | undefined) ??
      (totalStats.users as number | undefined) ??
      0;
    return {
      total_users_db:     totalDb,
      distinct_searchers: distinct,
      premium_users:      premiumN,
      // Human-readable summary so the LLM doesn't have to compute it.
      summary_ar:
        `إجمالي المستخدمين في قاعدة البيانات: ${totalDb}، ` +
        `منهم ${distinct} مستخدم قام بالبحث فعلاً، و${premiumN} مستخدم premium نشط. ` +
        `الفرق بين total_users_db و distinct_searchers يمثّل المستخدمين الذين ضغطوا /start ولم يبحثوا.`,
    };
  },
};

const TOOL_GET_FUNNEL_STATS: Tool = {
  name:        "get_funnel_stats",
  description: "Funnel raw counts + conversion rates: search → enrich → download → validate → sent.",
  parameters:  {
    type:       "object",
    properties: { date: { type: "string", description: "YYYY-MM-DD (اختياري)" } },
  },
  isWrite: false,
  async run(args) {
    const date = asStr(args.date) || undefined;
    const raw = await getFunnelStats(date);
    const pct = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : null;
    const search   = raw.search   ?? 0;
    const enrich   = raw.enrich   ?? 0;
    const download = raw.download ?? 0;
    const validate = raw.validate ?? 0;
    const sent     = raw.sent     ?? 0;
    return {
      raw,
      conversion_pct: {
        search_to_enrich:    pct(enrich, search),
        enrich_to_download:  pct(download, enrich),
        download_to_validate: pct(validate, download),
        validate_to_sent:    pct(sent, validate),
        end_to_end:          pct(sent, search), // overall search→deliver
      },
    };
  },
};

const TOOL_GET_TOP_BOOKS: Tool = {
  name:        "get_top_books",
  description: "أكثر الكتب طلباً (اليوم).",
  parameters:  {
    type:       "object",
    properties: { limit: { type: "integer", description: "max 30 (default 10)" } },
  },
  isWrite: false,
  async run(args) {
    const limit = Math.min(asNum(args.limit, 10), 30);
    return await getTopBooks(limit);
  },
};

const TOOL_GET_SOURCE_HEALTH: Tool = {
  name:        "get_source_health",
  description: "صحة كل مصدر بحث (Firecrawl، welib، AA، Telegram، ...) بـ success/failure ratio آخر 7 أيام.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const stats = await getSourceStats();
    // Trim to top 15 for token economy.
    return stats.slice(0, 15);
  },
};

const TOOL_GET_RECENT_TRACES: Tool = {
  name:        "get_recent_traces",
  description: "آخر request traces (book search lifecycle).",
  parameters:  {
    type:       "object",
    properties: { limit: { type: "integer", description: "max 20 (default 5)" } },
  },
  isWrite: false,
  async run(args) {
    const limit  = Math.min(asNum(args.limit, 5), 20);
    const traces = await getRecentTraces(limit);
    return traces.map(t => ({
      id:         t.id,
      userId:     t.userId,
      book:       t.book,
      outcome:    t.outcome,
      durationMs: t.durationMs,
      phases:     (t.phases || []).map(p => p.phase),
    }));
  },
};

const TOOL_GET_USER: Tool = {
  name:        "get_user",
  description: "بيانات user محدد (premium، quota، آخر طلبات).",
  parameters:  {
    type:       "object",
    properties: { user_id: { type: "string", description: "Telegram numeric ID" } },
    required:   ["user_id"],
  },
  isWrite: false,
  async run(args) {
    const id = asStr(args.user_id);
    if (!/^\d+$/.test(id)) throw new Error("user_id must be numeric");
    const [prem, expiry, pending, history] = await Promise.all([
      isPremium(id),
      getPremiumExpiry(id),
      redis.llen(`q:user:${id}`).catch(() => 0),
      storage.getUserSearchHistory(id, 5).catch(() => []),
    ]);
    return {
      userId:        id,
      premium:       prem,
      premiumExpiry: expiry ? expiry.toISOString() : null,
      pendingJobs:   pending,
      recentSearches: history.map(h => h.query),
    };
  },
};

const TOOL_GET_PREMIUM_INFO: Tool = {
  name:        "get_premium_info",
  description: "عدد الـ premium users والقائمة (max 50).",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const [count, list] = await Promise.all([premiumCount(), listPremiumUsers()]);
    return { count, ids: list.slice(0, 50) };
  },
};

const TOOL_GET_PDF_VALIDATION_STATS: Tool = {
  name:        "get_pdf_validation_stats",
  description: "إحصاءات pdfValidator (Llama prefilter + Mistral verdicts).",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    return await getPdfValidationStats();
  },
};

const TOOL_GET_BLACKLIST_STATS: Tool = {
  name:        "get_blacklist_stats",
  description: "عدد الـ URLs الـ blacklisted (failed too many times).",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    return await blacklistStats();
  },
};

const TOOL_GET_RECENT_LOGS: Tool = {
  name:        "get_recent_logs",
  description: "تيل آخر سطور من logs البوت من الـ buffer المحفوظ.",
  parameters:  {
    type:       "object",
    properties: {
      limit: { type: "integer", description: "max 100 (default 30)" },
      level: { type: "string", description: "DEBUG|INFO|WARN|ERROR (اختياري)" },
    },
  },
  isWrite: false,
  async run(args) {
    const limit = Math.min(asNum(args.limit, 30), 100);
    const level = asStr(args.level) || undefined;
    const lines = getRecentLogs(limit, level);
    return {
      bufferStats: getLogBufferStats(),
      lines: lines.map(l => ({
        ts:    new Date(l.ts).toISOString(),
        level: l.level,
        ns:    l.ns,
        msg:   l.msg,
      })),
    };
  },
};

const TOOL_GET_MAINTENANCE_STATUS: Tool = {
  name:        "get_maintenance_status",
  description: "هل الـ maintenance mode مفعّل؟ ومتى ينتهي؟",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const raw = await redis.get(MAINTENANCE_KEY);
    return { enabled: !!raw, value: raw };
  },
};

// ══════════════════════════════════════════════════════════
// WRITE TOOLS (10) — gated by confirm flow in index.ts
// ══════════════════════════════════════════════════════════

const TOOL_SET_PREMIUM: Tool = {
  name:        "set_premium",
  description: "اضبط user كـ premium لفترة محددة (بالأيام). days=0 يلغي الـ premium.",
  parameters:  {
    type:       "object",
    properties: {
      user_id: { type: "string", description: "Telegram numeric ID" },
      days:    { type: "integer", description: "عدد الأيام (0=إلغاء)" },
    },
    required: ["user_id", "days"],
  },
  isWrite: true,
  async run(args, ctx) {
    const id = asStr(args.user_id);
    const days = asNum(args.days, 0);
    if (!/^\d+$/.test(id)) throw new Error("user_id must be numeric");
    if (days === 0) {
      await setPremium(id, false, 0, { by: ctx.userId, source: "dashboard", reason: "admin-agent" });
      return { ok: true, action: "revoked", user_id: id };
    }
    await setPremium(id, true, days, { by: ctx.userId, source: "dashboard", reason: "admin-agent" });
    return { ok: true, action: "granted", user_id: id, days };
  },
};

const TOOL_PAUSE_SOURCE: Tool = {
  name:        "pause_source",
  description: "أوقِف مصدر بحث يدوياً (welib، firecrawl، anna-archive، ...). يُعاد تفعيله بـ unpause_source.",
  parameters:  {
    type:       "object",
    properties: { domain: { type: "string", description: "اسم/domain المصدر" } },
    required:   ["domain"],
  },
  isWrite: true,
  async run(args) {
    const domain = asStr(args.domain).toLowerCase().trim();
    if (!domain) throw new Error("domain required");
    await setSourceManuallyDisabled(domain, true);
    return { ok: true, domain, disabled: true };
  },
};

const TOOL_UNPAUSE_SOURCE: Tool = {
  name:        "unpause_source",
  description: "أعِد تفعيل مصدر بحث متوقّف.",
  parameters:  {
    type:       "object",
    properties: { domain: { type: "string" } },
    required:   ["domain"],
  },
  isWrite: true,
  async run(args) {
    const domain = asStr(args.domain).toLowerCase().trim();
    await setSourceManuallyDisabled(domain, false);
    return { ok: true, domain, disabled: false };
  },
};

const TOOL_CLEAR_DLQ: Tool = {
  name:        "clear_dlq",
  description: "امسح كل الـ jobs الفاشلة من Dead Letter Queue.",
  parameters:  { type: "object", properties: {} },
  isWrite:     true,
  async run() {
    await clearDLQ();
    return { ok: true, action: "dlq_cleared" };
  },
};

const TOOL_CANCEL_USER_JOBS: Tool = {
  name:        "cancel_user_jobs",
  description: "ألغِ كل الـ jobs المنتظرة لـ user محدد (يفيد لو user عمل spam).",
  parameters:  {
    type:       "object",
    properties: { user_id: { type: "string" } },
    required:   ["user_id"],
  },
  isWrite: true,
  async run(args) {
    const id = asStr(args.user_id);
    if (!/^\d+$/.test(id)) throw new Error("user_id must be numeric");
    const cancelled = await cancelUserJobs(id);
    return { ok: true, user_id: id, cancelled };
  },
};

const TOOL_CLEAR_CACHE: Tool = {
  name:        "clear_cache",
  description: "احذف مفاتيح Redis مطابقة لـ pattern. مثلاً 'cache:welib:*' أو 'tg:search:*'. ممنوع clearing flag:*, premium:*, ai:breaker:*.",
  parameters:  {
    type:       "object",
    properties: { pattern: { type: "string" } },
    required:   ["pattern"],
  },
  isWrite: true,
  async run(args) {
    const pattern = sanitizePattern(asStr(args.pattern));
    const keys = await scanKeys(pattern);
    if (keys.length === 0) return { ok: true, pattern, deleted: 0 };
    // Batch delete to avoid huge UNLINK calls
    const BATCH = 200;
    let deleted = 0;
    for (let i = 0; i < keys.length; i += BATCH) {
      const slice = keys.slice(i, i + BATCH);
      deleted += await redis.unlink(...slice).catch(() => 0);
    }
    return { ok: true, pattern, deleted };
  },
};

const TOOL_TOGGLE_MAINTENANCE: Tool = {
  name:        "toggle_maintenance",
  description: "فعِّل/عطِّل maintenance mode. لو on، البوت يرفض طلبات الـ users برسالة معدّة.",
  parameters:  {
    type:       "object",
    properties: {
      enabled: { type: "boolean" },
      reason:  { type: "string", description: "نص يُعرض للـ user (اختياري)" },
    },
    required: ["enabled"],
  },
  isWrite: true,
  async run(args) {
    const enabled = asBool(args.enabled);
    const reason  = asStr(args.reason) || "صيانة مجدولة، نعود قريباً";
    if (enabled) await redis.set(MAINTENANCE_KEY, reason);
    else         await redis.del(MAINTENANCE_KEY);
    if (!enabled) {
      // Notify the main bot so it can announce restoration to groups.
      (process as NodeJS.EventEmitter).emit("bot:maintenance_ended");
    }
    return { ok: true, enabled, reason };
  },
};

const TOOL_BROADCAST: Tool = {
  name:        "broadcast",
  description: "ابعت رسالة لكل (أو شريحة من) الـ users.",
  parameters:  {
    type:       "object",
    properties: {
      message:    { type: "string" },
      parse_mode: { type: "string", description: "Markdown (default) | HTML" },
      target:     { type: "string", description: "all (default) | premium" },
    },
    required: ["message"],
  },
  isWrite: true,
  async run(args) {
    const message    = asStr(args.message);
    const parse_mode = asStr(args.parse_mode) || "Markdown";
    const target     = asStr(args.target) || "all";
    if (message.length < 5) throw new Error("message too short");
    if (message.length > 3500) throw new Error("message too long (max 3500 chars)");
    (process as NodeJS.EventEmitter).emit("dashboard:broadcast", { message, parse_mode, target });
    return { ok: true, queued: true, target, length: message.length };
  },
};

const TOOL_REVOKE_PREMIUM: Tool = {
  // Convenience wrapper — same as set_premium(days=0) but with clearer
  // intent so the LLM picks it confidently.
  name:        "revoke_premium",
  description: "اسحب الـ premium من user.",
  parameters:  {
    type:       "object",
    properties: { user_id: { type: "string" } },
    required:   ["user_id"],
  },
  isWrite: true,
  async run(args, ctx) {
    const id = asStr(args.user_id);
    if (!/^\d+$/.test(id)) throw new Error("user_id must be numeric");
    await setPremium(id, false, 0, { by: ctx.userId, source: "dashboard", reason: "admin-agent" });
    return { ok: true, action: "revoked", user_id: id };
  },
};

const TOOL_GRANT_PREMIUM_30D: Tool = {
  // Convenience for the most common case.
  name:        "grant_premium_30d",
  description: "امنح user اشتراك premium لمدة 30 يوم.",
  parameters:  {
    type:       "object",
    properties: { user_id: { type: "string" } },
    required:   ["user_id"],
  },
  isWrite: true,
  async run(args, ctx) {
    const id = asStr(args.user_id);
    if (!/^\d+$/.test(id)) throw new Error("user_id must be numeric");
    await setPremium(id, true, 30, { by: ctx.userId, source: "dashboard", reason: "admin-agent-30d" });
    return { ok: true, action: "granted", user_id: id, days: 30 };
  },
};

// ══════════════════════════════════════════════════════════
// MEGA-OVERVIEW TOOLS (added in PR-A2)
// ══════════════════════════════════════════════════════════
// quick_overview bundles ~6 read tools into a single call so the LLM
// can answer "ايه حال البوت؟" in one round-trip with derived rates
// already computed. Without it the LLM kept stopping after a single
// get_today_stats call and replying "غير متاح".

const TOOL_QUICK_OVERVIEW: Tool = {
  name:        "quick_overview",
  description: "ملخّص شامل وسريع للبوت: stats اليوم + الأسبوع + funnel + queue + أعلى 5 مصادر + أعلى 5 كتب + الـ Telegram leg + الـ AI validation. استخدم هذا أولاً للأسئلة العامة.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const [today, weekly, funnel, queue, sources, topBooks, pdfVal] = await Promise.all([
      getDailyStats(),
      getWeeklyStats(),
      getFunnelStats(),
      getQueueStats(),
      getSourceStats(),
      getTopBooks(5),
      getPdfValidationStats().catch(() => null),
    ]);

    // Weekly aggregate
    const wAgg = { searches: 0, requests: 0, found: 0, downloads: 0, cache_hits: 0 };
    for (const d of Object.values(weekly)) {
      wAgg.searches   += d.searches   ?? 0;
      wAgg.requests   += d.requests   ?? 0;
      wAgg.found      += d.found      ?? 0;
      wAgg.downloads  += d.downloads  ?? 0;
      wAgg.cache_hits += d.cache_hits ?? 0;
    }
    const pct = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : null;

    // Read tel:tg:* counters in one shot (key telegram-fallback metrics)
    const tgKeys = ["tel:tg:searched", "tel:tg:found", "tel:tg:downloaded",
                    "tel:tg:no_results", "tel:tg:connect_failed"];
    const tgRaw = await redis.mget(...tgKeys).catch(() => tgKeys.map(() => null));
    const tg: Record<string, number> = {};
    tgKeys.forEach((k, i) => { tg[k.replace("tel:tg:", "")] = parseInt(tgRaw[i] || "0", 10) || 0; });

    return {
      today: {
        ...today,
        success_rate_pct:  pct(today.found ?? 0, today.requests ?? 0),
        delivery_rate_pct: pct((today.downloads ?? 0) + (today.cache_hits ?? 0), today.requests ?? 0),
        cache_hit_rate_pct: pct(today.cache_hits ?? 0, today.requests ?? 0),
      },
      weekly: {
        totals: wAgg,
        avg_success_pct:  pct(wAgg.found, wAgg.requests),
        avg_delivery_pct: pct(wAgg.downloads + wAgg.cache_hits, wAgg.requests),
      },
      funnel,
      queue,
      top_sources: sources.slice(0, 5).map(s => ({
        domain:        s.domain,
        ok:            s.ok,
        fail:          s.fail,
        mistralReject: s.mistralRejected,
        success_pct:   Math.round(s.successRate * 100) / 100,
        trust_pct:     Math.round(s.trustRate   * 100) / 100,
        autoDisabled:  s.autoDisabled,
        manualPaused:  s.manuallyDisabled,
      })),
      top_books: topBooks,
      telegram_fallback: {
        ...tg,
        find_rate_pct:     pct(tg.found,      tg.searched),
        deliver_rate_pct:  pct(tg.downloaded, tg.found),
      },
      pdf_validation: pdfVal,
    };
  },
};

const TOOL_GET_TEL_COUNTERS_SUMMARY: Tool = {
  name:        "get_tel_counters_summary",
  description: "ملخص مهيكل لكل counters الـ tel:* بـ groups: telegram leg، downloads، cache، pdf validation، llama AI.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const groups: Record<string, string[]> = {
      telegram_leg:   ["tel:tg:searched", "tel:tg:found", "tel:tg:downloaded",
                       "tel:tg:no_results", "tel:tg:connect_failed",
                       "tel:tg:flood_wait",  "tel:tg:download_failed"],
      downloads:      ["tel:dl:ok", "tel:dl:fail", "tel:dl:html_as_pdf",
                       "tel:dl:size_too_small", "tel:dl:bad_magic"],
      cache:          ["tel:cache:hit", "tel:cache:miss",
                       "tel:cache:stale_ttl_dropped", "tel:cache:write"],
      pdf_validation: ["tel:pdf:llama_yes", "tel:pdf:llama_no", "tel:pdf:llama_uncertain",
                       "tel:pdf:llama_used", "tel:pdf:mistral_yes", "tel:pdf:mistral_no",
                       "tel:pdf:mistral_used", "tel:pdf:extract_failed:no_text",
                       "tel:pdf:extract_failed:html_as_pdf"],
      llama_suggest:  ["tel:sugg:llama_used", "tel:sugg:llama_ok", "tel:sugg:llama_empty",
                       "tel:sugg:llama_cache_hit"],
      llama_translit: ["tel:tlit:llama_used", "tel:tlit:llama_cache_hit"],
    };

    const out: Record<string, Record<string, number>> = {};
    for (const [groupName, keys] of Object.entries(groups)) {
      const values = await redis.mget(...keys).catch(() => keys.map(() => null));
      const groupOut: Record<string, number> = {};
      keys.forEach((k, i) => {
        const v = parseInt(values[i] || "0", 10);
        if (v > 0) groupOut[k.replace(/^tel:/, "")] = v; // strip prefix for readability
      });
      out[groupName] = groupOut;
    }
    return out;
  },
};

// ══════════════════════════════════════════════════════════
// LLM PROVIDER MANAGEMENT TOOLS (added in PR-A2)
// ══════════════════════════════════════════════════════════
// Lets the admin rotate API keys / add new providers (OpenAI,
// Anthropic, OpenRouter, …) directly from Telegram chat without
// SSHing or redeploying. Useful when Cerebras/Groq hit rate limits.

const TOOL_LIST_LLM_PROVIDERS: Tool = {
  name:        "list_llm_providers",
  description: "اعرض كل LLM providers الـ configured (active/disabled) مع mask للـ keys.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const all = await loadAllProvidersRaw();
    return {
      count:     all.length,
      providers: all.map(publicView),
    };
  },
};

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_\-.]{1,63}$/i;

const TOOL_ADD_LLM_PROVIDER: Tool = {
  name:        "add_llm_provider",
  description: "أضف LLM provider جديد (OpenAI-compatible API). يتطلب: id, name, base_url, model, api_key, priority.",
  parameters:  {
    type:       "object",
    properties: {
      id:       { type: "string", description: "Stable ID (e.g. 'openai-gpt-4o-mini')" },
      name:     { type: "string", description: "Display name" },
      base_url: { type: "string", description: "Base URL without /chat/completions (e.g. 'https://api.openai.com/v1')" },
      model:    { type: "string", description: "Model name (e.g. 'gpt-4o-mini')" },
      api_key:  { type: "string", description: "API key (will be stored encrypted-at-rest in Redis)" },
      priority: { type: "integer", description: "1=first, larger=fallback. Default 5." },
    },
    required: ["id", "name", "base_url", "model", "api_key"],
  },
  isWrite: true,
  async run(args) {
    const id       = asStr(args.id);
    const name     = asStr(args.name);
    const baseUrl  = asStr(args.base_url);
    const model    = asStr(args.model);
    const apiKey   = asStr(args.api_key);
    const priority = asNum(args.priority, 5);

    if (!PROVIDER_ID_RE.test(id)) throw new Error("invalid id (alphanum, -, _, . only)");
    if (!name)                    throw new Error("name required");
    if (!/^https?:\/\//.test(baseUrl)) throw new Error("base_url must be http(s)://...");
    if (!model)                   throw new Error("model required");
    if (!apiKey || apiKey.length < 10) throw new Error("api_key required (10+ chars)");

    const existing = await getProvider(id);
    const p: LLMProvider = { id, name, baseUrl, model, apiKey, priority, enabled: true };
    await setProvider(p);
    return {
      ok:        true,
      action:    existing ? "updated" : "added",
      provider:  publicView(p),
    };
  },
};

const TOOL_UPDATE_LLM_PROVIDER: Tool = {
  name:        "update_llm_provider",
  description: "حدّث LLM provider موجود (api_key أو model أو priority أو enabled). Partial update.",
  parameters:  {
    type:       "object",
    properties: {
      id:       { type: "string", description: "Provider ID" },
      api_key:  { type: "string", description: "(optional) new API key" },
      model:    { type: "string", description: "(optional) new model name" },
      base_url: { type: "string", description: "(optional) new base URL" },
      name:     { type: "string", description: "(optional) new display name" },
      priority: { type: "integer", description: "(optional) new priority" },
      enabled:  { type: "boolean", description: "(optional) toggle enable/disable" },
    },
    required: ["id"],
  },
  isWrite: true,
  async run(args) {
    const id = asStr(args.id);
    if (!PROVIDER_ID_RE.test(id)) throw new Error("invalid id");
    const p = await getProvider(id);
    if (!p) throw new Error(`provider not found: ${id}`);

    if (typeof args.api_key  === "string" && args.api_key.length  >= 10) p.apiKey   = args.api_key;
    if (typeof args.model    === "string" && args.model.length    >  0)  p.model    = args.model;
    if (typeof args.base_url === "string" && /^https?:\/\//.test(args.base_url)) p.baseUrl = args.base_url;
    if (typeof args.name     === "string" && args.name.length     >  0)  p.name     = args.name;
    if (typeof args.priority === "number" && Number.isFinite(args.priority)) p.priority = args.priority;
    if (typeof args.enabled  === "boolean") p.enabled = args.enabled;

    await setProvider(p);
    return { ok: true, action: "updated", provider: publicView(p) };
  },
};

const TOOL_REMOVE_LLM_PROVIDER: Tool = {
  name:        "remove_llm_provider",
  description: "احذف LLM provider من الـ fallback chain.",
  parameters:  {
    type:       "object",
    properties: { id: { type: "string" } },
    required:   ["id"],
  },
  isWrite: true,
  async run(args) {
    const id = asStr(args.id);
    if (!PROVIDER_ID_RE.test(id)) throw new Error("invalid id");
    const ok = await removeProvider(id);
    if (!ok) throw new Error(`provider not found: ${id}`);
    return { ok: true, action: "removed", id };
  },
};

const TOOL_LLM_PROVIDER_STATS: Tool = {
  name:        "llm_provider_stats",
  description: "إحصائيات أداء LLM providers (نجاح/فشل/زمن استجابة p50/p95/last_err) من الـ telemetry. يساعد على معرفة هل Cloudflare بطيء/يفشل اليوم. مع id واحد يرجع تفاصيل، بدون id يرجع كل الـ providers.",
  parameters:  {
    type:       "object",
    properties: {
      id: { type: "string", description: "(optional) Provider ID لتفصيل واحد. أو سيب فاضي لكل الـ providers." },
    },
  },
  isWrite: false,
  async run(args) {
    const id = asStr(args.id);
    if (id) {
      if (!PROVIDER_ID_RE.test(id)) throw new Error("invalid id");
      return await getProviderStats(id);
    }
    const all = await loadAllProvidersRaw();
    const stats = await Promise.all(all.map(p => getProviderStats(p.id)));
    return {
      count: stats.length,
      providers: stats.sort((a, b) => {
        // Stable order: by err count desc so flaky providers float to top.
        const ea = a.err, eb = b.err;
        if (ea !== eb) return eb - ea;
        return a.id.localeCompare(b.id);
      }),
    };
  },
};

const TOOL_RESET_LLM_STATS: Tool = {
  name:        "reset_llm_provider_stats",
  description: "صفّر الـ telemetry counters لـ provider معين (يمسح breaker لو كان متوقف). استخدمها بعد ما تصلح المشكلة عند الـ provider.",
  parameters:  {
    type:       "object",
    properties: { id: { type: "string", description: "Provider ID" } },
    required:   ["id"],
  },
  isWrite: true,
  async run(args) {
    const id = asStr(args.id);
    if (!PROVIDER_ID_RE.test(id)) throw new Error("invalid id");
    const p = await getProvider(id);
    if (!p) throw new Error(`provider not found: ${id}`);
    await resetProviderTelemetry(id);
    return { ok: true, action: "telemetry_reset", id };
  },
};

const TOOL_SET_LLM_PRIORITY: Tool = {
  name:        "set_llm_priority",
  description: "غيّر priority لـ provider معيّن (1=الأول، أعلى=fallback).",
  parameters:  {
    type:       "object",
    properties: {
      id:       { type: "string" },
      priority: { type: "integer", description: "1+ (lower = earlier in chain)" },
    },
    required: ["id", "priority"],
  },
  isWrite: true,
  async run(args) {
    const id = asStr(args.id);
    const priority = asNum(args.priority, NaN);
    if (!PROVIDER_ID_RE.test(id)) throw new Error("invalid id");
    if (!Number.isFinite(priority) || priority < 1) throw new Error("priority must be >= 1");
    const p = await getProvider(id);
    if (!p) throw new Error(`provider not found: ${id}`);
    p.priority = priority;
    await setProvider(p);
    return { ok: true, provider: publicView(p) };
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 1: REASONING — think tool (ReAct pattern)
// ══════════════════════════════════════════════════════════

const TOOL_THINK: Tool = {
  name:        "think",
  description: "فكّر بصوت عالي — خطط، حلل، تأمّل. استخدم هذا قبل أي tool call عشان تنظم أفكارك.",
  parameters:  {
    type:       "object",
    properties: {
      thought: { type: "string", description: "التفكير أو التحليل أو الخطة" },
    },
    required: ["thought"],
  },
  isWrite: false,
  async run(args) {
    return { thought: asStr(args.thought), note: "تابع للخطوة التالية في خطتك." };
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 2: MEMORY — knowledge base tools
// ══════════════════════════════════════════════════════════

const TOOL_SAVE_KNOWLEDGE: Tool = {
  name:        "save_knowledge",
  description: "احفظ معلومة مهمة في الذاكرة الدائمة. تبقى حتى بعد /reset. استخدمها لحفظ incidents, قرارات, patterns.",
  parameters:  {
    type:       "object",
    properties: {
      key:   { type: "string", description: "مفتاح قصير (مثلاً 'welib_outage_may2026')" },
      value: { type: "string", description: "المعلومة (max 1000 char)" },
    },
    required: ["key", "value"],
  },
  isWrite: false,  // knowledge saves are non-destructive — no confirm needed
  async run(args) {
    const key   = asStr(args.key);
    const value = asStr(args.value);
    if (!key || key.length < 2)    throw new Error("key too short (min 2 chars)");
    if (!value || value.length < 3) throw new Error("value too short");
    await saveKnowledge(key, value);
    const count = await knowledgeCount();
    return { ok: true, key, stored_entries: count };
  },
};

const TOOL_RECALL_KNOWLEDGE: Tool = {
  name:        "recall_knowledge",
  description: "استرجع معلومات من الذاكرة الدائمة. بدون query يرجع كل المحفوظات.",
  parameters:  {
    type:       "object",
    properties: {
      query: { type: "string", description: "كلمات بحث (اختياري — بدونها يرجع الكل)" },
    },
  },
  isWrite: false,
  async run(args) {
    const query   = asStr(args.query) || undefined;
    const entries = await recallKnowledge(query);
    if (entries.length === 0) return { entries: [], note: "الذاكرة فاضية. استخدم save_knowledge لحفظ معلومات." };
    return {
      count:   entries.length,
      entries: entries.map(e => ({
        key:       e.key,
        value:     e.value,
        updatedAt: new Date(e.updatedAt).toISOString(),
      })),
    };
  },
};

const TOOL_DELETE_KNOWLEDGE: Tool = {
  name:        "delete_knowledge",
  description: "امسح معلومة من الذاكرة الدائمة.",
  parameters:  {
    type:       "object",
    properties: {
      key: { type: "string", description: "المفتاح المراد حذفه" },
    },
    required: ["key"],
  },
  isWrite: true,  // deletion requires confirm
  async run(args) {
    const key = asStr(args.key);
    const ok  = await deleteKnowledge(key);
    return ok
      ? { ok: true, deleted: key }
      : { ok: false, error: `key '${key}' not found` };
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 3: PROACTIVE MONITORING tools
// ══════════════════════════════════════════════════════════

const TOOL_TRIGGER_HEALTH_CHECK: Tool = {
  name:        "trigger_health_check",
  description: "شغّل فحص صحة يدوي فوراً. يفحص: success rate، queue، DLQ، sources. ويبعت alerts لو فيه مشاكل.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    const result = await triggerHealthCheck();
    return {
      alerts_found:     result.alerts.length,
      alerts_dispatched: result.dispatched,
      alerts: result.alerts.map(a => ({
        type:     a.type,
        severity: a.severity,
        message:  a.message,
      })),
      note: result.alerts.length === 0
        ? "كل حاجة تمام — مفيش anomalies."
        : `تم اكتشاف ${result.alerts.length} مشكلة.`,
    };
  },
};

const TOOL_GET_PROACTIVE_LOG: Tool = {
  name:        "get_proactive_log",
  description: "آخر نتائج الفحوصات الصحية التلقائية (آخر 10).",
  parameters:  {
    type:       "object",
    properties: {
      limit: { type: "integer", description: "max 20 (default 10)" },
    },
  },
  isWrite:     false,
  async run(args) {
    const limit = Math.min(asNum(args.limit, 10), 20);
    const log = await getProactiveLog(limit);
    return { entries: log, count: log.length };
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 4: DIAGNOSTIC — structured problem diagnosis
// ══════════════════════════════════════════════════════════

const TOOL_DIAGNOSE: Tool = {
  name:        "diagnose",
  description: "تشخيص شامل لمشكلة محددة. يجمع stats + sources + traces + logs في مكان واحد ويرجع ملخص.",
  parameters:  {
    type:       "object",
    properties: {
      area: {
        type: "string",
        description: "المنطقة المراد تشخيصها: 'search' | 'download' | 'source' | 'queue' | 'general'",
      },
      source_domain: {
        type: "string",
        description: "(اختياري) domain المصدر لتشخيصه تحديداً (مثلاً 'welib.st')",
      },
    },
    required: ["area"],
  },
  isWrite: false,
  async run(args) {
    const area   = asStr(args.area, "general");
    const domain = asStr(args.source_domain);

    const [stats, sources, queue, traces, logs] = await Promise.all([
      getDailyStats().catch(() => ({} as Record<string, number>)),
      getSourceStats().catch(() => []),
      getQueueStats().catch(() => ({ highQueue: 0, normalQueue: 0, dlqSize: 0, totalActiveJobs: 0 })),
      getRecentTraces(10).catch(() => []),
      getRecentLogs(30, "WARN"),
    ]);

    const pct = (n: number, d: number) => d > 0 ? Math.round((n / d) * 1000) / 10 : null;
    const requests = stats.requests ?? 0;
    const found    = stats.found ?? 0;

    const diagnosis: Record<string, unknown> = {
      area,
      timestamp: new Date().toISOString(),
      overview: {
        requests,
        found,
        success_rate_pct: pct(found, requests),
        downloads:  stats.downloads ?? 0,
        cache_hits: stats.cache_hits ?? 0,
        queue_pending: queue.highQueue + queue.normalQueue,
        dlq: queue.dlqSize,
        active_jobs: queue.totalActiveJobs,
      },
    };

    // Source-specific diagnosis
    if (area === "source" && domain) {
      const src = sources.find((s: { domain: string }) => s.domain === domain);
      if (src) {
        diagnosis.source = {
          domain:          src.domain,
          ok:              src.ok,
          fail:            src.fail,
          mistralRejected: src.mistralRejected,
          successRate:     src.successRate,
          trustRate:       src.trustRate,
          autoDisabled:    src.autoDisabled,
          manuallyDisabled: src.manuallyDisabled,
        };
        // Traces involving this source
        diagnosis.related_traces = traces
          .filter((t: { phases?: Array<{ phase: string }> }) =>
            (t.phases || []).some((p: { phase: string }) =>
              p.phase.toLowerCase().includes(domain.toLowerCase()),
            ),
          )
          .slice(0, 5);
      } else {
        diagnosis.source = { error: `source '${domain}' not found in stats` };
      }
    }

    // Problem sources (failing)
    diagnosis.problem_sources = sources
      .filter((s: { ok: number; fail: number; autoDisabled: boolean; manuallyDisabled: boolean }) =>
        s.ok + s.fail >= 3 && s.fail / (s.ok + s.fail) > 0.5 && !s.autoDisabled && !s.manuallyDisabled,
      )
      .slice(0, 5)
      .map((s: { domain: string; ok: number; fail: number; successRate: number }) => ({
        domain: s.domain, ok: s.ok, fail: s.fail, rate: s.successRate,
      }));

    // Recent errors
    diagnosis.recent_errors = logs
      .filter((l: { level: string }) => l.level === "ERROR" || l.level === "WARN")
      .slice(0, 10)
      .map((l: { ts: number; ns: string; msg: string }) => ({
        ts: new Date(l.ts).toISOString(), ns: l.ns, msg: l.msg,
      }));

    // Recent failed traces
    diagnosis.failed_traces = traces
      .filter((t: { outcome?: string }) => t.outcome && t.outcome !== "delivered" && t.outcome !== "cache_hit")
      .slice(0, 5)
      .map((t: { book: string; outcome?: string; durationMs?: number }) => ({
        book: t.book, outcome: t.outcome ?? "unknown", durationMs: t.durationMs ?? 0,
      }));

    return diagnosis;
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 4: CODE EXECUTION — shell command tool
// ══════════════════════════════════════════════════════════

// Whitelist of allowed command prefixes. Everything else is rejected.
const ALLOWED_COMMANDS: ReadonlyArray<{ prefix: string; description: string }> = [
  { prefix: "docker compose logs",    description: "view container logs" },
  { prefix: "docker compose ps",      description: "list containers" },
  { prefix: "docker stats --no-stream", description: "container resource usage" },
  { prefix: "df -h",                  description: "disk space" },
  { prefix: "free -m",                description: "memory usage" },
  { prefix: "uptime",                 description: "system uptime" },
  { prefix: "cat /proc/loadavg",      description: "load average" },
  { prefix: "redis-cli info",         description: "Redis server info" },
  { prefix: "redis-cli dbsize",       description: "Redis DB size" },
  { prefix: "redis-cli slowlog",      description: "Redis slow queries" },
  { prefix: "wc -l",                  description: "line count" },
  { prefix: "du -sh",                 description: "directory size" },
  { prefix: "ls -la",                 description: "list files" },
  { prefix: "tail ",                  description: "view end of file" },
  { prefix: "head ",                  description: "view start of file" },
  { prefix: "grep ",                  description: "search in files" },
  { prefix: "curl -s",                description: "HTTP request" },
  { prefix: "curl --silent",          description: "HTTP request" },
  { prefix: "ps aux",                 description: "running processes" },
  { prefix: "netstat -tlnp",          description: "listening ports" },
  { prefix: "ss -tlnp",              description: "listening ports" },
];

const EXEC_TIMEOUT_MS = 15_000;
const EXEC_MAX_OUTPUT = 3000; // chars

const TOOL_EXEC_COMMAND: Tool = {
  name:        "exec_command",
  description: "نفّذ أمر shell على السيرفر (whitelisted فقط). مفيد لـ: logs, disk, memory, processes, Redis info.",
  parameters:  {
    type:       "object",
    properties: {
      command: {
        type: "string",
        description: "الأمر المراد تنفيذه (مثلاً 'df -h', 'docker compose logs bot --tail 50', 'free -m')",
      },
    },
    required: ["command"],
  },
  isWrite: true, // requires confirmation for safety
  async run(args) {
    const cmd = asStr(args.command).trim();
    if (!cmd) throw new Error("command is empty");

    // Security: check against whitelist
    const allowed = ALLOWED_COMMANDS.find(a => cmd.startsWith(a.prefix));
    if (!allowed) {
      return {
        error: "الأمر مش مسموح",
        allowed_prefixes: ALLOWED_COMMANDS.map(a => `${a.prefix}  (${a.description})`),
        tip: "استخدم أحد الأوامر المسموح بيها فقط.",
      };
    }

    // Block dangerous patterns even in allowed commands
    if (/[;&|`$]/.test(cmd) || cmd.includes("$(") || cmd.includes(">>")) {
      throw new Error("الأمر يحتوي على أحرف غير مسموح بيها (;, &, |, `, $, >>)");
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB
        cwd: "/home/ubuntu/book-bot",
      });
      const output = (stdout || "").slice(0, EXEC_MAX_OUTPUT);
      const errors = (stderr || "").slice(0, 500);
      return {
        command: cmd,
        output: output || "(no output)",
        ...(errors ? { stderr: errors } : {}),
        truncated: (stdout || "").length > EXEC_MAX_OUTPUT,
      };
    } catch (e) {
      const err = e as { killed?: boolean; code?: number; stderr?: string; message?: string };
      if (err.killed) {
        return { command: cmd, error: `timeout after ${EXEC_TIMEOUT_MS / 1000}s` };
      }
      return {
        command: cmd,
        exit_code: err.code,
        error: (err.stderr || err.message || "unknown error").slice(0, 500),
      };
    }
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 4: REPORT GENERATION — formatted analytics report
// ══════════════════════════════════════════════════════════

const TOOL_GENERATE_REPORT: Tool = {
  name:        "generate_report",
  description: "اعمل تقرير شامل عن أداء البوت (يومي/أسبوعي/مخصص). بيجمع كل الـ stats في تقرير منسق.",
  parameters:  {
    type:       "object",
    properties: {
      period: {
        type: "string",
        enum: ["today", "weekly", "full"],
        description: "الفترة: today (اليوم), weekly (الأسبوع), full (كل الإحصاءات)",
      },
      include_sources: { type: "boolean", description: "ضمّن تفاصيل المصادر (default: true)" },
      include_traces:  { type: "boolean", description: "ضمّن آخر الـ traces (default: false)" },
    },
    required: ["period"],
  },
  isWrite: false,
  async run(args) {
    const period    = asStr(args.period, "today");
    const incSrc    = asBool(args.include_sources, true);
    const incTraces = asBool(args.include_traces, false);

    // Gather all data in parallel
    const [daily, weekly, total, sources, queue, traces, funnel, topBooks] = await Promise.all([
      getDailyStats().catch(() => null),
      getWeeklyStats().catch(() => null),
      getTotalStats().catch(() => null),
      getSourceStats().catch(() => []),
      getQueueStats().catch(() => null),
      incTraces ? getRecentTraces(10).catch(() => []) : Promise.resolve([]),
      getFunnelStats().catch(() => null),
      getTopBooks(5).catch(() => []),
    ]);

    const pct = (n: number, d: number) => d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : "N/A";

    const report: Record<string, unknown> = {
      generated_at: new Date().toISOString(),
      period,
    };

    // Period-specific stats
    if (period === "today" || period === "full") {
      const d = daily as Record<string, number> | null;
      if (d) {
        report.today = {
          requests:     d.requests ?? 0,
          found:        d.found ?? 0,
          success_rate: pct(d.found ?? 0, d.requests ?? 0),
          downloads:    d.downloads ?? 0,
          cache_hits:   d.cache_hits ?? 0,
          searches:     d.searches ?? 0,
        };
      }
    }

    if (period === "weekly" || period === "full") {
      report.weekly = weekly;
    }

    if (period === "full") {
      const t = total as Record<string, number> | null;
      if (t) {
        report.total = {
          requests:     t.requests ?? 0,
          found:        t.found ?? 0,
          success_rate: pct(t.found ?? 0, t.requests ?? 0),
          users:        t.users ?? 0,
        };
      }
    }

    // Queue status
    if (queue) report.queue = queue;

    // Funnel
    if (funnel) report.funnel = funnel;

    // Top books
    if (topBooks && (topBooks as unknown[]).length > 0) {
      report.top_books = topBooks;
    }

    // Sources breakdown
    if (incSrc && Array.isArray(sources)) {
      const healthy = (sources as Array<{ ok: number; fail: number; autoDisabled: boolean }>)
        .filter(s => !s.autoDisabled && s.ok + s.fail >= 1);
      const failing = healthy
        .filter(s => s.fail / (s.ok + s.fail) > 0.3)
        .sort((a, b) => b.fail / (b.ok + b.fail) - a.fail / (a.ok + a.fail));
      report.sources = {
        total: (sources as unknown[]).length,
        healthy: healthy.length - failing.length,
        failing: failing.length,
        problem_sources: failing.slice(0, 5).map((s: Record<string, unknown>) => ({
          domain: s.domain, ok: s.ok, fail: s.fail, rate: s.successRate,
        })),
      };
    }

    // Traces
    if (incTraces && Array.isArray(traces) && traces.length > 0) {
      report.recent_traces = (traces as Array<{ book: string; outcome?: string; durationMs?: number }>)
        .slice(0, 10)
        .map(t => ({
          book: t.book,
          outcome: t.outcome ?? "unknown",
          duration: t.durationMs ? `${Math.round(t.durationMs / 100) / 10}s` : "?",
        }));
    }

    return report;
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 5: WEB SEARCH — internet lookup (Manus-style)
// ══════════════════════════════════════════════════════════

const TOOL_WEB_SEARCH: Tool = {
  name:        "web_search",
  description: "ابحث في الإنترنت عن معلومة أو حل مشكلة. بيستخدم DuckDuckGo API.",
  parameters:  {
    type:       "object",
    properties: {
      query:  { type: "string", description: "استعلام البحث (بالعربي أو الإنجليزي)" },
      max_results: { type: "integer", description: "أقصى عدد نتائج (default: 3, max: 5)" },
    },
    required: ["query"],
  },
  isWrite: false,
  async run(args) {
    const query      = asStr(args.query).trim();
    const maxResults = Math.min(asNum(args.max_results, 3), 5);
    if (!query) throw new Error("query is empty");

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as {
        Abstract?: string;
        AbstractSource?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const results: Array<{ title: string; url: string; snippet: string }> = [];

      // Main abstract
      if (data.Abstract) {
        results.push({
          title: data.AbstractSource || "Result",
          url: data.AbstractURL || "",
          snippet: data.Abstract.slice(0, 300),
        });
      }

      // Related topics
      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics) {
          if (results.length >= maxResults) break;
          if (topic.Text && topic.FirstURL) {
            results.push({
              title: topic.Text.slice(0, 100),
              url: topic.FirstURL,
              snippet: topic.Text.slice(0, 200),
            });
          }
        }
      }

      return {
        query,
        results_count: results.length,
        results: results.length > 0 ? results : [{ title: "لا نتائج", url: "", snippet: "جرّب صياغة مختلفة للبحث." }],
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 5: SCHEDULED TASKS — recurring automated actions
// ══════════════════════════════════════════════════════════

// Scheduled tasks stored in Redis hash `admin:agent:schedules`
const SCHEDULES_KEY  = "admin:agent:schedules";
const MAX_SCHEDULES  = 10;

interface ScheduledTask {
  id:          string;
  name:        string;
  toolName:    string;
  args:        Record<string, unknown>;
  cronHuman:   string;     // human-readable schedule
  intervalMs:  number;     // actual interval in ms
  enabled:     boolean;
  lastRun:     number | null;
  nextRun:     number;
  createdAt:   number;
}

const TOOL_LIST_SCHEDULES: Tool = {
  name:        "list_schedules",
  description: "عرض كل الـ scheduled tasks المجدولة.",
  parameters:  { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const raw = await redis.hgetall(SCHEDULES_KEY);
    if (!raw || Object.keys(raw).length === 0) {
      return { schedules: [], note: "لا توجد مهام مجدولة حالياً." };
    }
    const schedules = Object.values(raw)
      .map(v => { try { return JSON.parse(v) as ScheduledTask; } catch { return null; } })
      .filter((s): s is ScheduledTask => s !== null)
      .sort((a, b) => a.nextRun - b.nextRun);
    return { count: schedules.length, schedules };
  },
};

const TOOL_ADD_SCHEDULE: Tool = {
  name:        "add_schedule",
  description: "أضف مهمة مجدولة تتنفذ تلقائياً (مثلاً: تقرير يومي، health check كل 30 دقيقة).",
  parameters:  {
    type:       "object",
    properties: {
      name:       { type: "string", description: "اسم المهمة (مثلاً 'daily_report')" },
      tool_name:  { type: "string", description: "اسم الأداة المراد تنفيذها" },
      tool_args:  { type: "object", description: "arguments الأداة (JSON)" },
      interval:   { type: "string", enum: ["15m", "30m", "1h", "2h", "6h", "12h", "24h"], description: "التكرار" },
    },
    required: ["name", "tool_name", "interval"],
  },
  isWrite: true,
  async run(args) {
    const name     = asStr(args.name).trim();
    const toolName = asStr(args.tool_name).trim();
    const toolArgs = (args.tool_args && typeof args.tool_args === "object" ? args.tool_args : {}) as Record<string, unknown>;
    const interval = asStr(args.interval);

    if (!name) throw new Error("name is required");
    if (!findTool(toolName)) throw new Error(`tool '${toolName}' not found`);

    // Check for write tools — scheduled write tools are not allowed
    const targetTool = findTool(toolName);
    if (targetTool?.isWrite) throw new Error("لا يمكن جدولة write tools (تحتاج تأكيد يدوي)");

    const intervalMap: Record<string, number> = {
      "15m": 15 * 60_000,
      "30m": 30 * 60_000,
      "1h":  60 * 60_000,
      "2h":  2 * 60 * 60_000,
      "6h":  6 * 60 * 60_000,
      "12h": 12 * 60 * 60_000,
      "24h": 24 * 60 * 60_000,
    };
    const intervalMs = intervalMap[interval];
    if (!intervalMs) throw new Error(`interval must be one of: ${Object.keys(intervalMap).join(", ")}`);

    // Check limit
    const existing = await redis.hlen(SCHEDULES_KEY);
    if (existing >= MAX_SCHEDULES) throw new Error(`الحد الأقصى ${MAX_SCHEDULES} مهام مجدولة`);

    const id = `sched_${Date.now()}`;
    const task: ScheduledTask = {
      id,
      name,
      toolName,
      args: toolArgs,
      cronHuman: `every ${interval}`,
      intervalMs,
      enabled: true,
      lastRun: null,
      nextRun: Date.now() + intervalMs,
      createdAt: Date.now(),
    };

    await redis.hset(SCHEDULES_KEY, id, JSON.stringify(task));
    return { ok: true, task };
  },
};

const TOOL_REMOVE_SCHEDULE: Tool = {
  name:        "remove_schedule",
  description: "احذف مهمة مجدولة.",
  parameters:  {
    type:       "object",
    properties: {
      id: { type: "string", description: "معرّف المهمة (مثلاً 'sched_1234567890')" },
    },
    required: ["id"],
  },
  isWrite: true,
  async run(args) {
    const id = asStr(args.id).trim();
    const removed = await redis.hdel(SCHEDULES_KEY, id);
    if (removed === 0) throw new Error(`schedule '${id}' not found`);
    return { ok: true, removed: id };
  },
};

const TOOL_TOGGLE_SCHEDULE: Tool = {
  name:        "toggle_schedule",
  description: "فعّل أو عطّل مهمة مجدولة.",
  parameters:  {
    type:       "object",
    properties: {
      id:      { type: "string", description: "معرّف المهمة" },
      enabled: { type: "boolean", description: "true لتفعيل، false لتعطيل" },
    },
    required: ["id", "enabled"],
  },
  isWrite: true,
  async run(args) {
    const id      = asStr(args.id).trim();
    const enabled = asBool(args.enabled);
    const raw = await redis.hget(SCHEDULES_KEY, id);
    if (!raw) throw new Error(`schedule '${id}' not found`);
    const task = JSON.parse(raw) as ScheduledTask;
    task.enabled = enabled;
    if (enabled) task.nextRun = Date.now() + task.intervalMs;
    await redis.hset(SCHEDULES_KEY, id, JSON.stringify(task));
    return { ok: true, task };
  },
};

// ══════════════════════════════════════════════════════════
// PHASE 5: SCHEDULE RUNNER — runs scheduled tools
// ══════════════════════════════════════════════════════════

let _scheduleTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduleRunner(): void {
  if (_scheduleTimer) return;
  // Check for due tasks every 60 seconds
  _scheduleTimer = setInterval(async () => {
    try {
      const raw = await redis.hgetall(SCHEDULES_KEY);
      if (!raw) return;
      const now = Date.now();
      for (const [id, json] of Object.entries(raw)) {
        try {
          const task = JSON.parse(json) as ScheduledTask;
          if (!task.enabled || task.nextRun > now) continue;
          const tool = findTool(task.toolName);
          if (!tool || tool.isWrite) continue;

          // Execute the tool
          const result = await tool.run(task.args, { userId: "scheduler" });

          // Store last run result in Redis (brief)
          const resultStr = JSON.stringify(result).slice(0, 500);
          await redis.set(
            `admin:agent:schedule_result:${id}`,
            resultStr,
            "EX", 86400 * 7, // 7 day TTL
          );

          // Update schedule
          task.lastRun = now;
          task.nextRun = now + task.intervalMs;
          await redis.hset(SCHEDULES_KEY, id, JSON.stringify(task));
        } catch (e) {
          // Log but don't crash the runner
          const msg = e instanceof Error ? e.message : String(e);
          await redis.set(
            `admin:agent:schedule_error:${id}`,
            msg.slice(0, 200),
            "EX", 86400,
          );
        }
      }
    } catch { /* ignore top-level errors */ }
  }, 60_000);
}

export function stopScheduleRunner(): void {
  if (_scheduleTimer) {
    clearInterval(_scheduleTimer);
    _scheduleTimer = null;
  }
}

// ══════════════════════════════════════════════════════════
// REGISTRY
// ══════════════════════════════════════════════════════════

export const TOOLS: Tool[] = [
  // ── reasoning (1) ──
  TOOL_THINK,                    // ← ALWAYS use this first
  // ── memory (3) ──
  TOOL_SAVE_KNOWLEDGE,
  TOOL_RECALL_KNOWLEDGE,
  TOOL_DELETE_KNOWLEDGE,
  // ── proactive (2) ──
  TOOL_TRIGGER_HEALTH_CHECK,
  TOOL_GET_PROACTIVE_LOG,
  // ── diagnostic (1) ──
  TOOL_DIAGNOSE,
  // ── Phase 4: code execution + reports (2) ──
  TOOL_EXEC_COMMAND,
  TOOL_GENERATE_REPORT,
  // ── Phase 5: web search + scheduling (4) ──
  TOOL_WEB_SEARCH,
  TOOL_LIST_SCHEDULES,
  TOOL_ADD_SCHEDULE,
  TOOL_REMOVE_SCHEDULE,
  TOOL_TOGGLE_SCHEDULE,
  // ── read (20) ──
  TOOL_QUICK_OVERVIEW,           // ← prefer this one for general questions
  TOOL_GET_COUNTERS,
  TOOL_GET_TEL_COUNTERS_SUMMARY,
  TOOL_GET_QUEUE_STATUS,
  TOOL_GET_DLQ_JOBS,
  TOOL_GET_TODAY_STATS,
  TOOL_GET_WEEKLY_STATS,
  TOOL_GET_TOTAL_STATS,
  TOOL_GET_USER_COUNT,
  TOOL_GET_FUNNEL_STATS,
  TOOL_GET_TOP_BOOKS,
  TOOL_GET_SOURCE_HEALTH,
  TOOL_GET_RECENT_TRACES,
  TOOL_GET_USER,
  TOOL_GET_PREMIUM_INFO,
  TOOL_GET_PDF_VALIDATION_STATS,
  TOOL_GET_BLACKLIST_STATS,
  TOOL_GET_RECENT_LOGS,
  TOOL_GET_MAINTENANCE_STATUS,
  TOOL_LIST_LLM_PROVIDERS,
  TOOL_LLM_PROVIDER_STATS,
  // ── write (15) ──
  TOOL_SET_PREMIUM,
  TOOL_GRANT_PREMIUM_30D,
  TOOL_REVOKE_PREMIUM,
  TOOL_PAUSE_SOURCE,
  TOOL_UNPAUSE_SOURCE,
  TOOL_CLEAR_DLQ,
  TOOL_CANCEL_USER_JOBS,
  TOOL_CLEAR_CACHE,
  TOOL_TOGGLE_MAINTENANCE,
  TOOL_BROADCAST,
  TOOL_ADD_LLM_PROVIDER,
  TOOL_UPDATE_LLM_PROVIDER,
  TOOL_REMOVE_LLM_PROVIDER,
  TOOL_SET_LLM_PRIORITY,
  TOOL_RESET_LLM_STATS,
];

export function getToolDefinitions(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return TOOLS.map(t => ({
    type:     "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function findTool(name: string): Tool | undefined {
  return TOOLS.find(t => t.name === name);
}
