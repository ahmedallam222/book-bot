// ══════════════════════════════════════════════════════════
// Admin Agent — Rafiqa control-plane tools (v3)
// ══════════════════════════════════════════════════════════
// Bridges the admin agent to everything built for /admin:
// feature flags, limits, health, delivery, retention, audit,
// bans, groups, images, backups, announce, session plans.
// Imported into tools.ts and registered in TOOLS[].

import { redis } from "../redis.js";
import {
  ALL_FEATS,
  featLabel,
  getAllFeatures,
  setFeature,
  getLimitsSnapshot,
  setLimit,
  clearLimit,
  type FeatName,
  type LimitName,
} from "../featureFlags.js";
import {
  banUser,
  unbanUser,
  bannedList,
  bannedCount,
  isBanned,
} from "../guards.js";
import {
  setPremium,
  isPremium,
  getUserDailyLimit,
  setUserDailyLimit,
  resetUserDailyLimit,
  setUserNote,
  clearUserNote,
  getUserNote,
} from "../userSettings.js";
import { getDeliveryStats } from "../deliveryMetrics.js";
import {
  buildSystemHealthMessage,
  listBackupFiles,
  runBackupNow,
} from "../adminHealth.js";
import { getAdminAudit, recordAdminAudit } from "../adminAudit.js";
import { getImageGenStats } from "../imageGen.js";
import { listKnownGroups } from "../groupTracker.js";
import {
  getDailyStats,
  getTotalStats,
  getWeeklyStats,
  getFunnelStats,
  getSourceStats,
  getTopBooks,
} from "../analytics.js";
import { getQueueStats } from "../queue.js";
import { storage } from "../../storage.js";
import { BOT_ANNOUNCE_KEY, MAINTENANCE_KEY } from "../config.js";
import { cairoDateString } from "../text.js";

import type { Tool, ToolRunCtx } from "./toolTypes.js";
export type { Tool, ToolRunCtx } from "./toolTypes.js";

// ── local helpers ──
function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|1|yes|on)$/i.test(v);
  return fallback;
}

async function safeInt(key: string): Promise<number> {
  try {
    return parseInt((await redis.get(key)) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

async function activeUsers(hours: number): Promise<number> {
  try {
    const since = Date.now() - hours * 3600_000;
    return await redis.zcount("user:lastSeen", since, "+inf");
  } catch {
    return 0;
  }
}

const FEAT_SET = new Set<string>(ALL_FEATS);
const LIMIT_SET = new Set<string>(["daily_free", "daily_prem", "image_free", "image_prem"]);

// ── Session plans (in-memory + Redis mirror) ──────────────
const PLAN_KEY = (uid: string) => `admin:agent:plan:${uid}`;
const PLAN_TTL = 7 * 24 * 3600;

interface AgentPlan {
  goal: string;
  steps: { id: number; text: string; status: "pending" | "done" | "blocked" | "skipped" }[];
  notes: string;
  updatedAt: number;
}

async function loadPlan(uid: string): Promise<AgentPlan | null> {
  try {
    const raw = await redis.get(PLAN_KEY(uid));
    if (!raw) return null;
    return JSON.parse(raw) as AgentPlan;
  } catch {
    return null;
  }
}

async function savePlan(uid: string, plan: AgentPlan): Promise<void> {
  await redis.set(PLAN_KEY(uid), JSON.stringify(plan), "EX", PLAN_TTL);
}

// ══════════════════════════════════════════════════════════
// TOOLS
// ══════════════════════════════════════════════════════════

const TOOL_GET_DASHBOARD: Tool = {
  name: "get_dashboard_snapshot",
  description:
    "لقطة رفيق الشاملة: نشاط، إحصاء اليوم، delivery p50/p95، صور، retention counters، طابور، صيانة/إعلان، flags مختصرة. للأسأل العامة «إيه حال البوت؟».",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const day = cairoDateString();
    const [
      today,
      total,
      qs,
      dbStats,
      img,
      delivery,
      a24,
      a7,
      isMaint,
      announce,
      feats,
      limits,
      sources,
    ] = await Promise.all([
      getDailyStats(),
      getTotalStats(),
      getQueueStats(),
      storage.getStats().catch(() => ({ totalUsers: 0 })),
      getImageGenStats(5).catch(() => ({
        todayCount: 0,
        totalSuccess: 0,
        totalFail: 0,
        topUsers: [] as { userId: string; count: number }[],
      })),
      getDeliveryStats(day),
      activeUsers(24),
      activeUsers(24 * 7),
      redis.get(MAINTENANCE_KEY).catch(() => null),
      redis.get(BOT_ANNOUNCE_KEY).catch(() => null),
      getAllFeatures(),
      getLimitsSnapshot(),
      getSourceStats().catch(() => []),
    ]);

    const pct = (n: number, d: number) =>
      d > 0 ? Math.round((n / d) * 1000) / 10 : null;

    const retKeys = [
      "tel:retention:daily_claim",
      "tel:retention:quest_complete",
      "tel:retention:morning_note",
      "tel:retention:evening_note",
      "tel:retention:week_report",
      "tel:retention:comeback",
    ] as const;
    const retVals = await Promise.all(retKeys.map((k) => safeInt(k)));
    const retention: Record<string, number> = {};
    retKeys.forEach((k, i) => {
      retention[k.replace("tel:retention:", "")] = retVals[i];
    });

    const badSources = (sources as { domain: string; successRate: number; fail: number; ok: number }[])
      .filter((s) => s.ok + s.fail >= 5 && s.successRate < 0.5)
      .slice(0, 5)
      .map((s) => ({
        domain: s.domain,
        success_pct: Math.round(s.successRate * 1000) / 10,
        ok: s.ok,
        fail: s.fail,
      }));

    return {
      day,
      activity: {
        active_24h: a24,
        active_7d: a7,
        total_users_db: (dbStats as { totalUsers?: number }).totalUsers ?? 0,
      },
      today: {
        ...today,
        success_rate_pct: pct(today.found ?? 0, today.requests ?? 0),
        delivery_rate_pct: pct(
          (today.downloads ?? 0) + (today.cache_hits ?? 0),
          today.requests ?? 0,
        ),
      },
      delivery,
      images: {
        today: img.todayCount,
        total_ok: img.totalSuccess,
        total_fail: img.totalFail,
      },
      retention,
      queue: qs,
      totals: {
        downloads: total.downloads ?? 0,
        searches: total.searches ?? 0,
      },
      maintenance: isMaint === "1",
      announce: announce ? String(announce).slice(0, 200) : null,
      features: feats,
      limits,
      weak_sources: badSources,
    };
  },
};

const TOOL_GET_SYSTEM_HEALTH: Tool = {
  name: "get_system_health",
  description:
    "صحة النظام: Redis/Postgres/queue/memory/uptime + delivery اليوم. يرجع JSON منظم + نص عربي.",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const day = cairoDateString();
    let redisOk = false;
    let redisMs = -1;
    try {
      const t0 = Date.now();
      redisOk = (await redis.ping()) === "PONG";
      redisMs = Date.now() - t0;
    } catch { /* */ }

    let dbOk = false;
    let dbUsers = 0;
    try {
      const s = await storage.getStats();
      dbOk = true;
      dbUsers = s.totalUsers;
    } catch { /* */ }

    const qs = await getQueueStats().catch(() => ({
      highQueue: -1,
      normalQueue: -1,
      dlqSize: -1,
      totalActiveJobs: -1,
    }));
    const ds = await getDeliveryStats(day).catch(() => null);
    const mem = process.memoryUsage();
    const text = await buildSystemHealthMessage().catch(() => "");

    return {
      overall_ok: redisOk && dbOk && qs.dlqSize >= 0 && qs.dlqSize < 50,
      redis: { ok: redisOk, ping_ms: redisMs },
      postgres: { ok: dbOk, users: dbUsers },
      queue: qs,
      delivery: ds,
      process: {
        node: process.version,
        uptime_min: Math.round(process.uptime() / 60),
        heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
        rss_mb: Math.round(mem.rss / 1024 / 1024),
      },
      message_ar: text,
    };
  },
};

const TOOL_GET_DELIVERY: Tool = {
  name: "get_delivery_metrics",
  description:
    "مقاييس تسليم الكتب: successRate، p50/p95/avg latency، outcomes (ok_cache/ok_send/fail_*). أدق من found/requests للزمن.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD اختياري (Cairo)" },
    },
  },
  isWrite: false,
  async run(args) {
    const date = asStr(args.date) || undefined;
    const s = await getDeliveryStats(date);
    return {
      ...s,
      p50_sec: Math.round((s.p50Ms / 1000) * 10) / 10,
      p95_sec: Math.round((s.p95Ms / 1000) * 10) / 10,
      avg_sec: Math.round((s.avgMs / 1000) * 10) / 10,
    };
  },
};

const TOOL_GET_FEATURES: Tool = {
  name: "get_feature_flags",
  description:
    "حالة كل feature flags لرفيق: images, summary, retention_push, group_free_text, group_interact, random, book_of_day.",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const feats = await getAllFeatures();
    return {
      features: Object.fromEntries(
        ALL_FEATS.map((f) => [f, { on: feats[f], label_ar: featLabel(f) }]),
      ),
    };
  },
};

const TOOL_SET_FEATURE: Tool = {
  name: "set_feature_flag",
  description:
    "تفعيل/تعطيل ميزة (write). names: images|summary|retention_push|group_free_text|group_interact|random|book_of_day.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "اسم الميزة",
        enum: [...ALL_FEATS],
      },
      enabled: { type: "boolean", description: "true=تشغيل، false=إيقاف" },
    },
    required: ["name", "enabled"],
  },
  isWrite: true,
  async run(args, ctx) {
    const name = asStr(args.name) as FeatName;
    if (!FEAT_SET.has(name)) throw new Error(`unknown feature: ${name}`);
    const enabled = asBool(args.enabled);
    await setFeature(name, enabled);
    await recordAdminAudit(ctx.userId, `agent:set_feature ${name}=${enabled ? "on" : "off"}`);
    return { ok: true, name, enabled, label_ar: featLabel(name) };
  },
};

const TOOL_GET_LIMITS: Tool = {
  name: "get_limits",
  description:
    "حدود الاستخدام الحالية: daily_free/prem و image_free/prem مع مصدر كل قيمة (admin|env).",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    return await getLimitsSnapshot();
  },
};

const TOOL_SET_LIMIT: Tool = {
  name: "set_limit",
  description:
    "ضبط حد عام (write). name: daily_free|daily_prem|image_free|image_prem. value عدد صحيح. clear=true يعيد للـ env.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        enum: ["daily_free", "daily_prem", "image_free", "image_prem"],
      },
      value: { type: "integer", description: "القيمة الجديدة (0–100000)" },
      clear: { type: "boolean", description: "إن true امسح التخصيص وارجع لـ env" },
    },
    required: ["name"],
  },
  isWrite: true,
  async run(args, ctx) {
    const name = asStr(args.name) as LimitName;
    if (!LIMIT_SET.has(name)) throw new Error(`unknown limit: ${name}`);
    if (asBool(args.clear)) {
      await clearLimit(name);
      await recordAdminAudit(ctx.userId, `agent:clear_limit ${name}`);
      return { ok: true, cleared: name, snapshot: await getLimitsSnapshot() };
    }
    const value = asNum(args.value, -1);
    if (value < 0) throw new Error("value required unless clear=true");
    await setLimit(name, value);
    await recordAdminAudit(ctx.userId, `agent:set_limit ${name}=${value}`);
    return { ok: true, name, value, snapshot: await getLimitsSnapshot() };
  },
};

const TOOL_BAN_USER: Tool = {
  name: "ban_user",
  description: "حظر مستخدم من البوت (write).",
  parameters: {
    type: "object",
    properties: {
      user_id: { type: "string", description: "Telegram user id" },
    },
    required: ["user_id"],
  },
  isWrite: true,
  async run(args, ctx) {
    const userId = asStr(args.user_id).trim();
    if (!/^\d{3,20}$/.test(userId)) throw new Error("user_id غير صالح");
    await banUser(userId);
    await recordAdminAudit(ctx.userId, `agent:ban ${userId}`);
    return { ok: true, banned: userId };
  },
};

const TOOL_UNBAN_USER: Tool = {
  name: "unban_user",
  description: "رفع الحظر عن مستخدم (write).",
  parameters: {
    type: "object",
    properties: {
      user_id: { type: "string", description: "Telegram user id" },
    },
    required: ["user_id"],
  },
  isWrite: true,
  async run(args, ctx) {
    const userId = asStr(args.user_id).trim();
    if (!/^\d{3,20}$/.test(userId)) throw new Error("user_id غير صالح");
    await unbanUser(userId);
    await recordAdminAudit(ctx.userId, `agent:unban ${userId}`);
    return { ok: true, unbanned: userId };
  },
};

const TOOL_LIST_BANS: Tool = {
  name: "list_bans",
  description: "قائمة المحظورين + العدد.",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const [list, count] = await Promise.all([bannedList(), bannedCount()]);
    return { count, user_ids: list.slice(0, 100) };
  },
};

const TOOL_GET_AUDIT: Tool = {
  name: "get_admin_audit",
  description: "سجل عمليات الأدمن الأخيرة (لوحة + وكيل).",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "max 100, default 30" },
    },
  },
  isWrite: false,
  async run(args) {
    const limit = Math.min(asNum(args.limit, 30), 100);
    const entries = await getAdminAudit(limit);
    return {
      count: entries.length,
      entries: entries.map((e) => ({
        who: e.who,
        action: e.action,
        at: new Date(e.ts).toISOString(),
        ts: e.ts,
      })),
    };
  },
};

const TOOL_GET_RETENTION: Tool = {
  name: "get_retention_metrics",
  description:
    "عدادات retention والجروبات: daily_claim، quests، morning/evening، week_report، comeback، group counters.",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const keys = [
      "tel:retention:daily_claim",
      "tel:retention:quest_complete",
      "tel:retention:morning_note",
      "tel:retention:evening_note",
      "tel:retention:week_report",
      "tel:retention:comeback",
      "tel:retention:level_up",
      "tel:retention:shield_used",
      "tel:group:club_post",
      "tel:group:free_text_hit",
      "tel:group:rate_limited",
      "tel:group:welcome_sent",
      "tel:group:soft_not_book",
    ] as const;
    const vals = await Promise.all(keys.map((k) => safeInt(k)));
    const out: Record<string, number> = {};
    keys.forEach((k, i) => {
      out[k] = vals[i];
    });
    return { counters: out };
  },
};

const TOOL_GET_IMAGE_STATS: Tool = {
  name: "get_image_stats",
  description: "إحصاءات توليد الصور AI: اليوم، totals، أعلى مستخدمين.",
  parameters: {
    type: "object",
    properties: {
      top_n: { type: "integer", description: "أعلى N مستخدمين (default 8)" },
    },
  },
  isWrite: false,
  async run(args) {
    const n = Math.min(asNum(args.top_n, 8), 20);
    return await getImageGenStats(n);
  },
};

const TOOL_GET_GROUPS: Tool = {
  name: "get_known_groups",
  description: "المجموعات المعروفة للبوت (من group tracker).",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const groups = await listKnownGroups();
    return {
      count: groups.length,
      groups: groups.slice(0, 50).map((g) => ({
        chatId: g.chatId,
        title: g.title || null,
        lastSeen: g.lastSeen || 0,
      })),
    };
  },
};

const TOOL_LIST_BACKUPS: Tool = {
  name: "list_backups",
  description: "قائمة ملفات النسخ الاحتياطي الأخيرة.",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const files = await listBackupFiles();
    return {
      count: files.length,
      files: files.map((f) => ({
        name: f.name,
        size_mb: Math.round((f.size / 1024 / 1024) * 10) / 10,
        mtime: new Date(f.mtime).toISOString(),
      })),
    };
  },
};

const TOOL_RUN_BACKUP: Tool = {
  name: "run_backup",
  description: "تشغيل نسخة احتياطية الآن (write — قد تستغرق وقتًا).",
  parameters: { type: "object", properties: {} },
  isWrite: true,
  async run(_args, ctx) {
    const r = await runBackupNow();
    await recordAdminAudit(ctx.userId, `agent:backup ${r.ok ? "ok" : "fail"}`);
    return r;
  },
};

const TOOL_SET_ANNOUNCE: Tool = {
  name: "set_announce",
  description:
    "تعيين أو مسح رسالة الإعلان العامة (write). text فارغ أو clear=true يمسح الإعلان.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "نص الإعلان" },
      clear: { type: "boolean", description: "امسح الإعلان" },
    },
  },
  isWrite: true,
  async run(args, ctx) {
    if (asBool(args.clear) || !asStr(args.text).trim()) {
      await redis.del(BOT_ANNOUNCE_KEY);
      await recordAdminAudit(ctx.userId, "agent:announce clear");
      return { ok: true, announce: null };
    }
    const text = asStr(args.text).trim().slice(0, 500);
    await redis.set(BOT_ANNOUNCE_KEY, text);
    await recordAdminAudit(ctx.userId, `agent:announce set (${text.length} chars)`);
    return { ok: true, announce: text };
  },
};

const TOOL_SET_USER_LIMIT: Tool = {
  name: "set_user_daily_limit",
  description:
    "حد يومي خاص بمستخدم (write). reset=true يعيد للافتراضي. value<=0 يعني بلا حد عمليًا حسب منطق البوت.",
  parameters: {
    type: "object",
    properties: {
      user_id: { type: "string" },
      value: { type: "integer" },
      reset: { type: "boolean" },
    },
    required: ["user_id"],
  },
  isWrite: true,
  async run(args, ctx) {
    const userId = asStr(args.user_id).trim();
    if (!/^\d{3,20}$/.test(userId)) throw new Error("user_id غير صالح");
    if (asBool(args.reset)) {
      await resetUserDailyLimit(userId);
      await recordAdminAudit(ctx.userId, `agent:user_limit reset ${userId}`);
      return { ok: true, user_id: userId, reset: true };
    }
    const value = asNum(args.value, NaN);
    if (!Number.isFinite(value)) throw new Error("value required unless reset");
    await setUserDailyLimit(userId, value);
    await recordAdminAudit(ctx.userId, `agent:user_limit ${userId}=${value}`);
    return {
      ok: true,
      user_id: userId,
      value,
      current: await getUserDailyLimit(userId),
    };
  },
};

const TOOL_SET_USER_NOTE: Tool = {
  name: "set_user_note",
  description: "ملاحظة أدمن على مستخدم (write). clear=true للمسح.",
  parameters: {
    type: "object",
    properties: {
      user_id: { type: "string" },
      note: { type: "string" },
      clear: { type: "boolean" },
    },
    required: ["user_id"],
  },
  isWrite: true,
  async run(args, ctx) {
    const userId = asStr(args.user_id).trim();
    if (!/^\d{3,20}$/.test(userId)) throw new Error("user_id غير صالح");
    if (asBool(args.clear)) {
      await clearUserNote(userId);
      await recordAdminAudit(ctx.userId, `agent:user_note clear ${userId}`);
      return { ok: true, cleared: true };
    }
    const note = asStr(args.note).trim().slice(0, 500);
    if (!note) throw new Error("note required unless clear");
    await setUserNote(userId, note);
    await recordAdminAudit(ctx.userId, `agent:user_note set ${userId}`);
    return { ok: true, user_id: userId, note };
  },
};

const TOOL_USER_OPS_INFO: Tool = {
  name: "get_user_ops",
  description:
    "معلومات تشغيلية عن مستخدم: premium، ban، daily limit، note — مكمّل لـ get_user.",
  parameters: {
    type: "object",
    properties: {
      user_id: { type: "string" },
    },
    required: ["user_id"],
  },
  isWrite: false,
  async run(args) {
    const userId = asStr(args.user_id).trim();
    if (!/^\d{3,20}$/.test(userId)) throw new Error("user_id غير صالح");
    const [prem, banned, limit, note] = await Promise.all([
      isPremium(userId),
      isBanned(userId),
      getUserDailyLimit(userId),
      getUserNote(userId),
    ]);
    return {
      user_id: userId,
      premium: prem,
      banned,
      daily_limit: limit,
      note: note || null,
    };
  },
};

const TOOL_CREATE_PLAN: Tool = {
  name: "create_plan",
  description:
    "أنشئ خطة/هدف متعدد الخطوات للجلسة الحالية. استخدم للمهام المعقدة (تشخيص+إصلاح+تحقق).",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "الهدف النهائي" },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "قائمة خطوات (2–8)",
      },
    },
    required: ["goal", "steps"],
  },
  isWrite: false,
  async run(args, ctx) {
    const goal = asStr(args.goal).slice(0, 400);
    const rawSteps = Array.isArray(args.steps) ? args.steps : [];
    const steps = rawSteps
      .map((s, i) => ({
        id: i + 1,
        text: String(s).slice(0, 200),
        status: "pending" as const,
      }))
      .slice(0, 8);
    if (!goal || steps.length < 1) throw new Error("goal + steps مطلوبة");
    const plan: AgentPlan = { goal, steps, notes: "", updatedAt: Date.now() };
    await savePlan(ctx.userId, plan);
    return { ok: true, plan };
  },
};

const TOOL_UPDATE_PLAN: Tool = {
  name: "update_plan",
  description:
    "حدّث حالة خطوة في الخطة (done|pending|blocked|skipped) أو أضف ملاحظة.",
  parameters: {
    type: "object",
    properties: {
      step_id: { type: "integer", description: "رقم الخطوة" },
      status: {
        type: "string",
        enum: ["pending", "done", "blocked", "skipped"],
      },
      notes: { type: "string", description: "ملاحظات اختيارية" },
    },
  },
  isWrite: false,
  async run(args, ctx) {
    const plan = await loadPlan(ctx.userId);
    if (!plan) throw new Error("لا توجد خطة — استخدم create_plan أولاً");
    const stepId = asNum(args.step_id, 0);
    const status = asStr(args.status) as AgentPlan["steps"][0]["status"];
    if (stepId > 0) {
      const step = plan.steps.find((s) => s.id === stepId);
      if (!step) throw new Error(`step ${stepId} not found`);
      if (status) step.status = status;
    }
    if (asStr(args.notes)) plan.notes = asStr(args.notes).slice(0, 1000);
    plan.updatedAt = Date.now();
    await savePlan(ctx.userId, plan);
    return { ok: true, plan };
  },
};

const TOOL_GET_PLAN: Tool = {
  name: "get_plan",
  description: "اعرض خطة الجلسة الحالية إن وُجدت.",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run(_args, ctx) {
    const plan = await loadPlan(ctx.userId);
    return plan
      ? { has_plan: true, plan }
      : { has_plan: false, note: "لا خطة نشطة" };
  },
};

const TOOL_REFLECT: Tool = {
  name: "reflect",
  description:
    "أداة تأمّل: سجّل ما عرفته، ما ينقص، والفرضيات. استخدم قبل الرد النهائي في التشخيص المعقد. لا تستدعِها عبثًا كل دورة.",
  parameters: {
    type: "object",
    properties: {
      known: { type: "string", description: "ما تأكدنا منه" },
      unknown: { type: "string", description: "ما ينقصنا" },
      hypothesis: { type: "string", description: "الفرضية الحالية" },
      next_action: { type: "string", description: "الخطوة التالية" },
    },
    required: ["known"],
  },
  isWrite: false,
  async run(args) {
    return {
      reflection: {
        known: asStr(args.known).slice(0, 800),
        unknown: asStr(args.unknown).slice(0, 500),
        hypothesis: asStr(args.hypothesis).slice(0, 500),
        next_action: asStr(args.next_action).slice(0, 400),
      },
      hint: "استخدم هذه النقاط لصياغة الرد أو لاستدعاء أدوات إضافية.",
    };
  },
};

const TOOL_GRANT_PREMIUM_AUDIT: Tool = {
  name: "set_premium_days",
  description:
    "منح/تجديد premium لأيام محددة (write). days=0 يلغي. يسجّل في audit.",
  parameters: {
    type: "object",
    properties: {
      user_id: { type: "string" },
      days: { type: "integer", description: "عدد الأيام (0=إلغاء)" },
    },
    required: ["user_id", "days"],
  },
  isWrite: true,
  async run(args, ctx) {
    const userId = asStr(args.user_id).trim();
    const days = asNum(args.days, 0);
    if (!/^\d{3,20}$/.test(userId)) throw new Error("user_id غير صالح");
    const grantCtx = {
      by: ctx.userId,
      source: "telegram-cmd" as const,
      reason: "admin_agent",
    };
    if (days <= 0) {
      await setPremium(userId, false, 0, grantCtx);
      await recordAdminAudit(ctx.userId, `agent:premium revoke ${userId}`);
      return { ok: true, user_id: userId, premium: false };
    }
    await setPremium(userId, true, days, grantCtx);
    await recordAdminAudit(ctx.userId, `agent:premium ${userId} ${days}d`);
    return {
      ok: true,
      user_id: userId,
      premium: true,
      days,
      approx_until: new Date(Date.now() + days * 86400_000).toISOString(),
    };
  },
};

export const RAFIQA_TOOLS: Tool[] = [
  TOOL_GET_DASHBOARD,
  TOOL_GET_SYSTEM_HEALTH,
  TOOL_GET_DELIVERY,
  TOOL_GET_FEATURES,
  TOOL_SET_FEATURE,
  TOOL_GET_LIMITS,
  TOOL_SET_LIMIT,
  TOOL_BAN_USER,
  TOOL_UNBAN_USER,
  TOOL_LIST_BANS,
  TOOL_GET_AUDIT,
  TOOL_GET_RETENTION,
  TOOL_GET_IMAGE_STATS,
  TOOL_GET_GROUPS,
  TOOL_LIST_BACKUPS,
  TOOL_RUN_BACKUP,
  TOOL_SET_ANNOUNCE,
  TOOL_SET_USER_LIMIT,
  TOOL_SET_USER_NOTE,
  TOOL_USER_OPS_INFO,
  TOOL_CREATE_PLAN,
  TOOL_UPDATE_PLAN,
  TOOL_GET_PLAN,
  TOOL_REFLECT,
  TOOL_GRANT_PREMIUM_AUDIT,
];
