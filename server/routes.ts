import type { Express, Request, Response, NextFunction } from "express";

import path from "path";
import { timingSafeEqual } from "crypto";
import { fileURLToPath } from "url";
import { readFileSync, accessSync } from "fs";
import { redis } from "./bot/redis.js";
import {
  getDailyStats, getTotalStats, getTopBooks,
  getSourceStats, getWeeklyStats, getFunnelStats,
} from "./bot/analytics.js";
import { getRecentTraces, getTrace } from "./bot/telemetry.js";
import { getPdfValidationStats } from "./bot/pdfValidator.js";
import {
  getQueueStats, getDLQJobs, clearDLQ, clearQueues,
} from "./bot/queue.js";
import {
  isPremium, setPremium, listPremiumUsers, premiumCount,
  getUserDailyLimit, setUserDailyLimit, resetUserDailyLimit,
} from "./bot/userSettings.js";
import { bannedList, banUser, unbanUser, bannedCount } from "./bot/guards.js";
import { blacklistStats, clearBlacklist }               from "./bot/blacklist.js";
import { startBot, activeWorkerCount }                  from "./bot/index.js";
import { storage }                                       from "./storage.js";
import { L }                                             from "./bot/logger.js";

// ── Config ────────────────────────────────────────────────────
// ADMIN_IDS للـ dashboard auth fallback — يجب أن تطابق سلوك bot/config.ts تماماً:
// الأدمن الرئيسي "5469997406" مُضمَّن دائماً + أي IDs من الـ env
// لو استخدمنا (env || default) → عند ضبط env يُستبعد الأدمن الرئيسي
// BUG-3 FIX: كان {5,12} → لا يدعم معرّفات Telegram الجديدة (13-15 رقم)
// يجب أن يتطابق مع config.ts الذي يستخدم {5,15}
const _envAdminIds = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(s => /^\d{5,15}$/.test(s));
const ADMIN_IDS = ["5469997406", ..._envAdminIds.filter(id => id !== "5469997406")];
const MAINTENANCE_KEY = "flag:maintenance";   // ← matches bot/config.ts

// ── Auth ──────────────────────────────────────────────────────
// SECURITY: نستخدم DASHBOARD_SECRET منفصل عن Admin Telegram IDs
// Telegram IDs رقمية وقابلة للتخمين — Dashboard secret مستقل وأكثر أماناً
// لو لم يُضبط DASHBOARD_SECRET، نرجع للـ ADMIN_IDS كـ fallback (backward compat)
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET?.trim();

/** مقارنة بوقت ثابت (constant-time) — تمنع timing attacks على الـ secret */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function auth(req: Request, res: Response, next: NextFunction): void {
  const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  const valid = DASHBOARD_SECRET
    ? safeEqual(token, DASHBOARD_SECRET)
    : ADMIN_IDS.includes(token);
  if (!valid) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; }
  next();
}

function ok(res: Response, data: unknown): void { res.json({ ok: true, data, ts: Date.now() }); }
function fail(res: Response, msg: string, code = 500): void { res.status(code).json({ ok: false, error: msg }); }

/**
 * يتحقق أن الـ :id في URL هو Telegram numeric user ID حقيقي.
 * يمنع الأخطاء الشائعة مثل استخدام @username بدل الـ ID الرقمي.
 * Telegram user IDs: أرقام موجبة، حالياً أقل من 10^12.
 */
function validateNumericId(id: string): boolean {
  // BUG-3 FIX: {5,12} → {5,15} لدعم معرّفات Telegram الجديدة (13-15 رقم)
  return /^\d{5,15}$/.test(id) && !isNaN(Number(id));
}

function requireNumericId(req: Request, res: Response): string | null {
  const id = req.params.id?.trim();
  if (!id || !validateNumericId(id)) {
    fail(res, `Invalid user ID "${id}" — must be a numeric Telegram user ID (e.g. 123456789)`, 400);
    return null;
  }
  return id;
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => fn(req, res).catch(e => fail(res, String(e)));
}

// ═════════════════════════════════════════════════════════════
export async function registerRoutes(httpServer: any, app: Express): Promise<void> {
  // ── Dashboard HTML ─────────────────────────────────────────
  // يُخدَم من نفس السيرفر → لا مشكلة HTTPS / Mixed Content
  app.get("/dashboard", (_req, res) => {
    try {
      const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
      // Check dist/ (production) then server/ (dev)
      const candidates = [
        path.join(__dirname2, "dashboard.html"),
        path.join(__dirname2, "..", "server", "dashboard.html"),
      ];
      const file = candidates.find(p => { try { accessSync(p); return true; } catch { return false; } });
      if (!file) throw new Error("dashboard.html not found");
      const html = readFileSync(file, "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch {
      res.status(500).send("<h2>dashboard.html not found</h2>");
    }
  });

  // ── CORS for dashboard — يجب أن يكون قبل startBot ────────
  // M3 FIX: لا wildcard — fallback للـ localhost بدل "*"
  app.use("/api/admin", (req, res, next) => {
    const origin = process.env.DASHBOARD_ORIGIN || "http://localhost:5000";
    res.header("Access-Control-Allow-Origin",  origin);
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

  // ── Start Bot (fire-and-forget) ───────────────────────────
  startBot().catch(e => L.error("server", "bot start error", { e: String(e) }));

  // ── Public health ─────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, uptime: Math.floor(process.uptime()), ts: Date.now() });
  });

  // ═══════════════════════════════════════════════════════════
  //  PROTECTED ADMIN API
  // ═══════════════════════════════════════════════════════════

  // Overview — single call that loads the entire dashboard
  app.get("/api/admin/overview", auth, wrap(async (_req, res) => {
    const [today, total, qStats, pCount, bCount, blStats, weekly, sysInfo] = await Promise.all([
      getDailyStats(),
      getTotalStats(),
      getQueueStats(),
      premiumCount().catch(() => 0),
      bannedCount().catch(() => 0),
      blacklistStats().catch(() => ({ total: 0, active: 0 })),
      getWeeklyStats(),
      getSystemInfo(),
    ]);
    ok(res, { today, total, queue: qStats, premium: { count: pCount },
              banned: { count: bCount }, blacklist: blStats, weekly, system: sysInfo });
  }));

  // Stats
  app.get("/api/admin/stats/daily",   auth, wrap(async (req, res) => ok(res, await getDailyStats(req.query.date as string))));
  app.get("/api/admin/stats/weekly",  auth, wrap(async (_req, res) => ok(res, await getWeeklyStats())));
  app.get("/api/admin/stats/total",   auth, wrap(async (_req, res) => ok(res, await getTotalStats())));
  app.get("/api/admin/stats/top-books", auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "15", 10);
    const limit = isNaN(rawLimit) ? 15 : Math.min(50, Math.max(1, rawLimit));
    ok(res, await getTopBooks(limit, req.query.date as string));
  }));
  app.get("/api/admin/stats/sources", auth, wrap(async (_req, res) => {
    // BUG-2 FIX: getSourceStats() لا تقبل date param — كانت تُرسَل وتُتجاهَل صمتاً
    // الدالة تُجمِّع بيانات من كل الأيام الموجودة في Redis (all-time)
    ok(res, await getSourceStats());
  }));

  // Queue
  app.get("/api/admin/queue",         auth, wrap(async (_req, res) => ok(res, await getQueueStats())));
  app.get("/api/admin/queue/dlq",     auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "30", 10);
    const limit = isNaN(rawLimit) ? 30 : Math.min(50, Math.max(1, rawLimit));
    ok(res, await getDLQJobs(limit));
  }));
  app.delete("/api/admin/queue/dlq",  auth, wrap(async (_req, res) => {
    await clearDLQ(); L.adminAction("dashboard", "DLQ cleared"); ok(res, { cleared: true });
  }));
  app.delete("/api/admin/queue/all",  auth, wrap(async (_req, res) => {
    await clearQueues(); L.adminAction("dashboard", "All queues cleared"); ok(res, { cleared: true });
  }));

  // Users — banned
  app.get("/api/admin/users/banned",  auth, wrap(async (_req, res) => ok(res, await bannedList())));
  app.post("/api/admin/users/:id/ban", auth, wrap(async (req, res) => {
    const id = requireNumericId(req, res); if (!id) return;
    await banUser(id); L.adminAction("dashboard", `ban ${id}`); ok(res, { done: true });
  }));
  app.delete("/api/admin/users/:id/ban", auth, wrap(async (req, res) => {
    const id = requireNumericId(req, res); if (!id) return;
    await unbanUser(id); L.adminAction("dashboard", `unban ${id}`); ok(res, { done: true });
  }));

  // Users — premium
  app.get("/api/admin/users/premium",  auth, wrap(async (_req, res) => ok(res, await listPremiumUsers())));
  app.post("/api/admin/users/:id/premium", auth, wrap(async (req, res) => {
    const id = requireNumericId(req, res); if (!id) return;
    const { enable } = req.body as { enable: boolean };
    await setPremium(id, enable);
    L.adminAction("dashboard", `${enable ? "grant" : "revoke"} premium ${id}`);
    ok(res, { done: true, enable });
  }));

  // User limit
  app.get("/api/admin/users/:id/limit", auth, wrap(async (req, res) => {
    const id = requireNumericId(req, res); if (!id) return;
    ok(res, { limit: await getUserDailyLimit(id) });
  }));
  app.put("/api/admin/users/:id/limit", auth, wrap(async (req, res) => {
    const id = requireNumericId(req, res); if (!id) return;
    const { limit } = req.body as { limit: number };
    await setUserDailyLimit(id, limit);
    L.adminAction("dashboard", `limit ${limit} → ${id}`);
    ok(res, { done: true, limit });
  }));
  app.delete("/api/admin/users/:id/limit", auth, wrap(async (req, res) => {
    const id = requireNumericId(req, res); if (!id) return;
    await resetUserDailyLimit(id); ok(res, { reset: true });
  }));

  // Blacklist
  app.get("/api/admin/blacklist",    auth, wrap(async (_req, res) => ok(res, await blacklistStats())));
  app.delete("/api/admin/blacklist", auth, wrap(async (_req, res) => {
    await clearBlacklist(); L.adminAction("dashboard", "blacklist cleared"); ok(res, { cleared: true });
  }));

  // Maintenance
  app.get("/api/admin/maintenance",  auth, wrap(async (_req, res) => {
    ok(res, { active: (await redis.get(MAINTENANCE_KEY).catch(() => null)) === "1" });
  }));
  app.put("/api/admin/maintenance",  auth, wrap(async (req, res) => {
    const { active } = req.body as { active: boolean };
    active ? await redis.set(MAINTENANCE_KEY, "1") : await redis.del(MAINTENANCE_KEY);
    L.adminAction("dashboard", `maintenance ${active ? "ON" : "OFF"}`);
    ok(res, { active });
  }));

  // System
  app.get("/api/admin/system", auth, wrap(async (_req, res) => ok(res, await getSystemInfo())));

  // ── Telemetry endpoints ──────────────────────────────────────
  // GET /api/admin/telemetry/funnel?date=YYYY-MM-DD
  app.get("/api/admin/telemetry/funnel", auth, wrap(async (req, res) => {
    ok(res, await getFunnelStats(req.query.date as string | undefined));
  }));

  // GET /api/admin/telemetry/pdf-validation
  // إحصاءات فلتر الـ false positives — accepted/rejected/mistral_used
  app.get("/api/admin/telemetry/pdf-validation", auth, wrap(async (_req, res) => {
    ok(res, await getPdfValidationStats());
  }));

  // GET /api/admin/telemetry/traces?limit=50
  app.get("/api/admin/telemetry/traces", auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "50", 10);
    const limit = isNaN(rawLimit) ? 50 : Math.min(200, Math.max(1, rawLimit));
    ok(res, await getRecentTraces(limit));
  }));

  // GET /api/admin/telemetry/traces/:id
  app.get("/api/admin/telemetry/traces/:id", auth, wrap(async (req, res) => {
    const trace = await getTrace(req.params.id);
    if (!trace) { res.status(404).json({ ok: false, error: "trace not found" }); return; }
    ok(res, trace);
  }));

}

// ── System info helper ────────────────────────────────────────
async function getSystemInfo() {
  const mem     = process.memoryUsage();
  const uptime  = Math.floor(process.uptime());
  const isMaint = await redis.get(MAINTENANCE_KEY).catch(() => null);
  let redisOk   = false;
  try { await redis.ping(); redisOk = true; } catch {}

  return {
    uptime,
    uptimeHuman: formatUptime(uptime),
    memory: {
      heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      rss:       Math.round(mem.rss       / 1024 / 1024),
    },
    workers:     activeWorkerCount(),
    maintenance: isMaint === "1",
    redis:       redisOk,
    nodeVersion: process.version,
    pid:         process.pid,
  };
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}ي ${h}س ${m}د`;
  if (h > 0) return `${h}س ${m}د`;
  return `${m} دقيقة`;
}
