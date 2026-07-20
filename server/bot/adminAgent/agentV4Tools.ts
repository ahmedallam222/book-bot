// ══════════════════════════════════════════════════════════
// Admin Agent — v4 power tools (playbooks, incidents, compare)
// ══════════════════════════════════════════════════════════

import { redis } from "../redis.js";
import {
  getDailyStats,
  getWeeklyStats,
  getTotalStats,
  getSourceStats,
  getFunnelStats,
  getTopBooks,
} from "../analytics.js";
import { getQueueStats } from "../queue.js";
import { getDeliveryStats } from "../deliveryMetrics.js";
import { buildAdminLibraryTasteMessage } from "../adminDashboard.js";
import { getAdminAudit } from "../adminAudit.js";
import { storage } from "../../storage.js";
import { cairoDateString } from "../text.js";
import { getRecentLogs } from "../logBuffer.js";
import type { Tool, ToolRunCtx } from "./toolTypes.js";

function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// ── Incidents (structured memory) ─────────────
const INCIDENT_KEY = "admin:agent:incidents";
const INCIDENT_MAX = 80;

export interface Incident {
  id: string;
  title: string;
  severity: "info" | "warning" | "critical";
  status: "open" | "resolved" | "monitoring";
  detail: string;
  actions?: string;
  ts: number;
  by: string;
}

const TOOL_SAVE_INCIDENT: Tool = {
  name: "save_incident",
  description:
    "احفظ حادث/مشكلة منظمة في سجل الوكيل (عنوان، خطورة، حالة، تفاصيل). يعيش 180 يوماً.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      severity: { type: "string", enum: ["info", "warning", "critical"] },
      status: { type: "string", enum: ["open", "resolved", "monitoring"] },
      detail: { type: "string", description: "ما حدث + root cause إن وُجد" },
      actions: { type: "string", description: "ما نُفّذ أو الموصى به" },
    },
    required: ["title", "detail"],
  },
  isWrite: false,
  async run(args, ctx) {
    const inc: Incident = {
      id: `inc_${Date.now().toString(36)}`,
      title: asStr(args.title).slice(0, 120),
      severity: (asStr(args.severity, "warning") as Incident["severity"]) || "warning",
      status: (asStr(args.status, "open") as Incident["status"]) || "open",
      detail: asStr(args.detail).slice(0, 1500),
      actions: asStr(args.actions).slice(0, 800) || undefined,
      ts: Date.now(),
      by: ctx.userId,
    };
    await redis.lpush(INCIDENT_KEY, JSON.stringify(inc));
    await redis.ltrim(INCIDENT_KEY, 0, INCIDENT_MAX - 1);
    await redis.expire(INCIDENT_KEY, 180 * 86400);
    return { ok: true, incident: inc };
  },
};

const TOOL_LIST_INCIDENTS: Tool = {
  name: "list_incidents",
  description: "اعرض آخر الحوادث المحفوظة (مفتوحة أو الكل).",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer" },
      open_only: { type: "boolean" },
    },
  },
  isWrite: false,
  async run(args) {
    const limit = Math.min(asNum(args.limit, 15), 40);
    const openOnly = !!args.open_only;
    const raw = await redis.lrange(INCIDENT_KEY, 0, 79);
    let items: Incident[] = [];
    for (const r of raw) {
      try {
        items.push(JSON.parse(r) as Incident);
      } catch { /* */ }
    }
    if (openOnly) items = items.filter((i) => i.status === "open" || i.status === "monitoring");
    return { count: items.slice(0, limit).length, incidents: items.slice(0, limit) };
  },
};

// ── Compare periods ───────────────────────────
const TOOL_COMPARE: Tool = {
  name: "compare_periods",
  description:
    "قارن أداء اليوم مع متوسط آخر 7 أيام (طلبات، نجاح، تسليم، طابور).",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const [today, weekly, delivery, queue] = await Promise.all([
      getDailyStats(),
      getWeeklyStats(),
      getDeliveryStats(),
      getQueueStats(),
    ]);
    const days = Object.values(weekly);
    const sum = { requests: 0, found: 0, downloads: 0, cache_hits: 0, searches: 0 };
    for (const d of days) {
      sum.requests += d.requests ?? 0;
      sum.found += d.found ?? 0;
      sum.downloads += d.downloads ?? 0;
      sum.cache_hits += d.cache_hits ?? 0;
      sum.searches += d.searches ?? 0;
    }
    const n = Math.max(days.length, 1);
    const avgReq = sum.requests / n;
    const todayReq = today.requests ?? 0;
    const todaySucc = pct(today.found ?? 0, todayReq);
    const weekSucc = pct(sum.found, sum.requests);
    return {
      today: {
        requests: todayReq,
        success_pct: todaySucc,
        downloads: today.downloads ?? 0,
        cache_hits: today.cache_hits ?? 0,
      },
      week_daily_avg: {
        requests: Math.round(avgReq * 10) / 10,
        success_pct: weekSucc,
        downloads: Math.round((sum.downloads / n) * 10) / 10,
      },
      delta: {
        requests_vs_avg_pct:
          avgReq > 0 ? Math.round(((todayReq - avgReq) / avgReq) * 1000) / 10 : null,
        success_pts:
          todaySucc != null && weekSucc != null
            ? Math.round((todaySucc - weekSucc) * 10) / 10
            : null,
      },
      delivery_today: {
        successRate: delivery.successRate,
        p50_sec: Math.round((delivery.p50Ms / 1000) * 10) / 10,
        p95_sec: Math.round((delivery.p95Ms / 1000) * 10) / 10,
      },
      queue,
      insight_ar:
        todaySucc != null && weekSucc != null && todaySucc + 5 < weekSucc
          ? "نسبة نجاح اليوم أقل من متوسط الأسبوع — راجع المصادر والتسليم."
          : todayReq > avgReq * 1.3
            ? "حجم الطلبات أعلى من المتوسط — راقب الطابور والـ p95."
            : "الأرقام ضمن نطاق معقول مقارنة بالأسبوع.",
    };
  },
};

// ── Playbooks (multi-tool recipes, single call) ─
const TOOL_PLAYBOOK: Tool = {
  name: "run_playbook",
  description:
    "شغّل playbook جاهز يجمع عدة قراءات دفعة واحدة. playbooks: health_full | slow_delivery | source_outage | daily_brief | user_deep | retention_pulse | library_taste.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        enum: [
          "health_full",
          "slow_delivery",
          "source_outage",
          "daily_brief",
          "user_deep",
          "retention_pulse",
          "library_taste",
        ],
      },
      user_id: { type: "string", description: "مطلوب لـ user_deep فقط" },
    },
    required: ["name"],
  },
  isWrite: false,
  async run(args) {
    const name = asStr(args.name);
    const day = cairoDateString();

    if (name === "health_full") {
      const [today, queue, sources, delivery, logs] = await Promise.all([
        getDailyStats(),
        getQueueStats(),
        getSourceStats(),
        getDeliveryStats(day),
        Promise.resolve(getRecentLogs(30)),
      ]);
      const weak = sources
        .filter((s: { ok: number; fail: number; successRate: number }) => s.ok + s.fail >= 5 && s.successRate < 0.5)
        .slice(0, 6)
        .map((s: any) => ({
          domain: s.domain,
          success_pct: Math.round(s.successRate * 1000) / 10,
          ok: s.ok,
          fail: s.fail,
          paused: s.manuallyDisabled || s.autoDisabled,
        }));
      return {
        playbook: name,
        today: {
          ...today,
          success_pct: pct(today.found ?? 0, today.requests ?? 0),
        },
        queue,
        delivery,
        weak_sources: weak,
        recent_warn_logs: (logs as { level?: string; msg?: string }[])
          .filter((l) => /warn|error/i.test(String(l.level || "")))
          .slice(0, 10),
      };
    }

    if (name === "slow_delivery") {
      const [delivery, queue, sources, funnel] = await Promise.all([
        getDeliveryStats(day),
        getQueueStats(),
        getSourceStats(),
        getFunnelStats(),
      ]);
      return {
        playbook: name,
        delivery: {
          ...delivery,
          p50_sec: Math.round((delivery.p50Ms / 1000) * 10) / 10,
          p95_sec: Math.round((delivery.p95Ms / 1000) * 10) / 10,
        },
        queue,
        funnel,
        slowest_hint:
          queue.highQueue + queue.normalQueue > 20
            ? "تراكم طابور — زد workers أو افحص jobs عالقة"
            : delivery.p95Ms > 90000
              ? "p95 مرتفع — افحص مصادر بطيئة وPDF validation"
              : "لا مؤشر طابور واضح — راجع network/sources",
        top_sources: sources.slice(0, 8).map((s: any) => ({
          domain: s.domain,
          success_pct: Math.round(s.successRate * 1000) / 10,
          ok: s.ok,
          fail: s.fail,
        })),
      };
    }

    if (name === "source_outage") {
      const sources = await getSourceStats();
      const bad = sources
        .filter((s) => s.ok + s.fail >= 3)
        .map((s: any) => ({
          domain: s.domain,
          success_pct: Math.round(s.successRate * 1000) / 10,
          trust_pct: Math.round(s.trustRate * 1000) / 10,
          ok: s.ok,
          fail: s.fail,
          mistralRejected: s.mistralRejected,
          autoDisabled: s.autoDisabled,
          manuallyDisabled: s.manuallyDisabled,
        }))
        .sort((a, b) => a.success_pct - b.success_pct);
      return {
        playbook: name,
        worst: bad.slice(0, 10),
        paused: bad.filter((s) => s.autoDisabled || s.manuallyDisabled),
        action_hint:
          "للمصادر بنسبة فشل >80% مع محاولات كافية: pause_source بعد التأكيد.",
      };
    }

    if (name === "daily_brief") {
      const [today, weekly, delivery, queue, tops, users, audit] = await Promise.all([
        getDailyStats(),
        getWeeklyStats(),
        getDeliveryStats(day),
        getQueueStats(),
        getTopBooks(5),
        storage.getStats().catch(() => ({ totalUsers: 0 })),
        getAdminAudit(8),
      ]);
      const wAgg = { requests: 0, found: 0 };
      for (const d of Object.values(weekly)) {
        wAgg.requests += d.requests ?? 0;
        wAgg.found += d.found ?? 0;
      }
      return {
        playbook: name,
        day,
        users_db: (users as { totalUsers?: number }).totalUsers ?? 0,
        today: {
          ...today,
          success_pct: pct(today.found ?? 0, today.requests ?? 0),
        },
        week_success_pct: pct(wAgg.found, wAgg.requests),
        delivery: {
          successRate: delivery.successRate,
          p50_sec: Math.round((delivery.p50Ms / 1000) * 10) / 10,
          p95_sec: Math.round((delivery.p95Ms / 1000) * 10) / 10,
        },
        queue,
        top_books: tops,
        recent_admin_actions: audit.map((a) => ({
          who: a.who,
          action: a.action,
          at: new Date(a.ts).toISOString(),
        })),
      };
    }

    if (name === "user_deep") {
      const userId = asStr(args.user_id).trim();
      if (!/^\d{5,15}$/.test(userId)) throw new Error("user_id مطلوب وصالح لـ user_deep");
      const [hist, prem, ban, note] = await Promise.all([
        storage.getUserSearchHistory(userId, 10).catch(() => []),
        redis.sismember("premium:users", userId).catch(() => 0),
        redis.sismember("bans", userId).catch(() => 0),
        (async () => {
          try {
            const { getUserNote } = await import("../userSettings.js");
            return await getUserNote(userId);
          } catch { return null; }
        })(),
      ]);
      let lib: unknown[] = [];
      let interests: unknown[] = [];
      try {
        const { getLibrary } = await import("../library.js");
        lib = await getLibrary(userId, 10);
      } catch { /* */ }
      try {
        const { getTopInterests } = await import("../interests.js");
        interests = await getTopInterests(userId, 5);
      } catch { /* */ }
      return {
        playbook: name,
        user_id: userId,
        premium: prem === 1,
        banned: ban === 1,
        note: note || null,
        recent_searches: hist,
        library: lib,
        interests,
      };
    }

    if (name === "retention_pulse") {
      const keys = [
        "tel:retention:daily_claim",
        "tel:retention:quest_complete",
        "tel:retention:morning_note",
        "tel:retention:evening_note",
        "tel:retention:continue_nudge",
        "tel:retention:week_report",
        "tel:retention:comeback",
        "tel:onboard:complete",
      ];
      const vals = await Promise.all(
        keys.map(async (k) => parseInt((await redis.get(k)) || "0", 10) || 0),
      );
      const counters: Record<string, number> = {};
      keys.forEach((k, i) => {
        counters[k] = vals[i];
      });
      const readingUsers = await redis.scard("lib:reading_users").catch(() => 0);
      return { playbook: name, counters, reading_users_now: readingUsers };
    }

    if (name === "library_taste") {
      const text = await buildAdminLibraryTasteMessage();
      return { playbook: name, message_ar: text };
    }

    throw new Error(`unknown playbook: ${name}`);
  },
};

const TOOL_LIBRARY_TASTE: Tool = {
  name: "get_library_taste_stats",
  description: "إحصاءات مكتبة المستخدمين + توزيع الذوق + تذكيرات أكمل قراءتك.",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run() {
    const text = await buildAdminLibraryTasteMessage();
    const keys = [
      "tel:lib:record",
      "tel:lib:status:reading",
      "tel:lib:status:done",
      "tel:retention:continue_nudge",
    ];
    const vals = await Promise.all(
      keys.map(async (k) => parseInt((await redis.get(k)) || "0", 10) || 0),
    );
    const counters: Record<string, number> = {};
    keys.forEach((k, i) => {
      counters[k] = vals[i];
    });
    return {
      counters,
      reading_users: await redis.scard("lib:reading_users").catch(() => 0),
      message_ar: text,
    };
  },
};

const TOOL_SEARCH_USERS: Tool = {
  name: "search_users",
  description:
    "ابحث عن مستخدمين في قاعدة البيانات (بالـ telegram id أو جزء من الاسم). limit افتراضي 10.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "telegram id أو اسم" },
      limit: { type: "integer" },
    },
    required: ["query"],
  },
  isWrite: false,
  async run(args) {
    const q = asStr(args.query).trim();
    const limit = Math.min(asNum(args.limit, 10), 25);
    if (!q) throw new Error("query فارغ");
    // If pure id — direct lookup
    if (/^\d{5,15}$/.test(q)) {
      const hist = await storage.getUserSearchHistory(q, 5).catch(() => []);
      const prem = (await redis.sismember("premium:users", q).catch(() => 0)) === 1;
      const banned = (await redis.sismember("bans", q).catch(() => 0)) === 1;
      return {
        matches: [{ telegramId: q, premium: prem, banned, recent: hist }],
      };
    }
    // scan recent users page
    const page = await storage.getAllUsersWithDetails(50, 0).catch(() => ({
      users: [] as { telegramId: string; firstName?: string | null; username?: string | null; totalDownloads?: number }[],
      total: 0,
    }));
    const ql = q.toLowerCase();
    const matches = page.users
      .filter((u) => {
        const n = `${u.firstName || ""} ${u.username || ""} ${u.telegramId}`.toLowerCase();
        return n.includes(ql);
      })
      .slice(0, limit)
      .map((u) => ({
        telegramId: u.telegramId,
        name: u.firstName || null,
        username: u.username || null,
        downloads: u.totalDownloads ?? 0,
      }));
    return { total_scanned: page.users.length, matches };
  },
};

const TOOL_SKILL_STATUS: Tool = {
  name: "skill_status",
  description: "اعرض المهارة الحالية المقترحة للنص + قائمة أدواتها (للتوضيح).",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "نص سؤال الأدمن" },
    },
    required: ["text"],
  },
  isWrite: false,
  async run(args) {
    const { inferSkill, toolsForSkill, skillLabelAr } = await import("./skills.js");
    const text = asStr(args.text);
    const skill = inferSkill(text);
    const tools = [...toolsForSkill(skill)].sort();
    return {
      skill,
      label_ar: skillLabelAr(skill),
      tool_count: tools.length,
      tools,
    };
  },
};

const TOOL_AUTO_BRIEF: Tool = {
  name: "auto_ops_brief",
  description:
    "موجز عمليات تلقائي: co-pack health + compare + weak sources + open incidents. مثالي لـ «إيه الوضع؟».",
  parameters: { type: "object", properties: {} },
  isWrite: false,
  async run(_args, ctx) {
    const pb = await TOOL_PLAYBOOK.run({ name: "daily_brief" }, ctx);
    const cmp = await TOOL_COMPARE.run({}, ctx);
    const sources = await getSourceStats();
    const weak = sources
      .filter((s) => s.ok + s.fail >= 5 && s.successRate < 0.55)
      .slice(0, 5)
      .map((s) => ({
        domain: s.domain,
        success_pct: Math.round(s.successRate * 1000) / 10,
      }));
    const incidents = await TOOL_LIST_INCIDENTS.run({ limit: 5, open_only: true }, ctx);
    return {
      brief: pb,
      comparison: cmp,
      weak_sources: weak,
      open_incidents: incidents,
      recommended_next:
        weak.length > 0
          ? `راجع المصدر ${weak[0].domain} (نجاح ${weak[0].success_pct}%)`
          : "لا مصدر ضعيف واضح — راقب التسليم والطابور.",
    };
  },
};

export const V4_TOOLS: Tool[] = [
  TOOL_SAVE_INCIDENT,
  TOOL_LIST_INCIDENTS,
  TOOL_COMPARE,
  TOOL_PLAYBOOK,
  TOOL_LIBRARY_TASTE,
  TOOL_SEARCH_USERS,
  TOOL_SKILL_STATUS,
  TOOL_AUTO_BRIEF,
];


import { createParallelBriefsTool } from "./subAgents.js";

/** Registered after V4_TOOLS so run_playbook exists. */
export function getSubAgentTool(): Tool {
  const pb = V4_TOOLS.find((t) => t.name === "run_playbook");
  if (!pb) throw new Error("run_playbook missing");
  return createParallelBriefsTool((args, ctx) => pb.run(args, ctx));
}
