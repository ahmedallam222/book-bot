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

const TOOL_GET_TODAY_STATS: Tool = {
  name:        "get_today_stats",
  description: "إحصاءات اليوم (Cairo TZ): طلبات، نجاحات، إخفاقات.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    return await getDailyStats();
  },
};

const TOOL_GET_WEEKLY_STATS: Tool = {
  name:        "get_weekly_stats",
  description: "إحصاءات آخر 7 أيام (يومياً).",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    return await getWeeklyStats();
  },
};

const TOOL_GET_TOTAL_STATS: Tool = {
  name:        "get_total_stats",
  description: "الإحصاءات الإجمالية للبوت من بدايته.",
  parameters:  { type: "object", properties: {} },
  isWrite:     false,
  async run() {
    return await getTotalStats();
  },
};

const TOOL_GET_FUNNEL_STATS: Tool = {
  name:        "get_funnel_stats",
  description: "Funnel: search → enrich → download → validate → sent. لليوم الحالي بشكل افتراضي.",
  parameters:  {
    type:       "object",
    properties: { date: { type: "string", description: "YYYY-MM-DD (اختياري)" } },
  },
  isWrite: false,
  async run(args) {
    const date = asStr(args.date) || undefined;
    return await getFunnelStats(date);
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
// REGISTRY
// ══════════════════════════════════════════════════════════

export const TOOLS: Tool[] = [
  // read (15)
  TOOL_GET_COUNTERS,
  TOOL_GET_QUEUE_STATUS,
  TOOL_GET_DLQ_JOBS,
  TOOL_GET_TODAY_STATS,
  TOOL_GET_WEEKLY_STATS,
  TOOL_GET_TOTAL_STATS,
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
  // write (10)
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
