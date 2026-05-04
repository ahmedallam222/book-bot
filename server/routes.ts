import type { Express, Request, Response, NextFunction } from "express";

import path from "path";
import { timingSafeEqual } from "crypto";
import { fileURLToPath } from "url";
import { readFileSync, accessSync } from "fs";
import { redis } from "./bot/redis.js";
import {
  getDailyStats, getTotalStats, getTopBooks,
  getSourceStats, getWeeklyStats, getFunnelStats,
  setSourceManuallyDisabled, sanitizeDomainKey,
} from "./bot/analytics.js";
import { getRecentTraces, getTrace } from "./bot/telemetry.js";
import { getPdfValidationStats } from "./bot/pdfValidator.js";
import {
  getQueueStats, getDLQJobs, clearDLQ, clearQueues,
} from "./bot/queue.js";
import {
  isPremium, setPremium, listPremiumUsers, premiumCount,
  getUserDailyLimit, setUserDailyLimit, resetUserDailyLimit,
  getPremiumAudit,
} from "./bot/userSettings.js";
import { bannedList, banUser, unbanUser, bannedCount } from "./bot/guards.js";
import { blacklistStats, clearBlacklist }               from "./bot/blacklist.js";
import { startBot, activeWorkerCount }                  from "./bot/index.js";
import { storage }                                       from "./storage.js";
import { L }                                             from "./bot/logger.js";
import { searchAllSources, getSearchCacheResults }       from "./bot/engine.js";
import { GENRES }                                        from "./bot/random.js";
import { normalizeArabic }                               from "./bot/text.js";
import { GENRE_MAP, SUGGESTIONS }                        from "./bot/suggestions.js";
import { ipRateLimit }                                   from "./bot/ipRateLimit.js";

// ── Config ────────────────────────────────────────────────────
const MAINTENANCE_KEY = "flag:maintenance";   // ← matches bot/config.ts

// ── Auth ──────────────────────────────────────────────────────
// SECURITY: الـ dashboard auth يعتمد على DASHBOARD_SECRET فقط — لا fallback
// إلى Telegram numeric IDs. الـ IDs مكشوفة في الكود/اللوجز/الجروبات
// وقابلة للتخمين — استخدامها كـ secret كان ثغرة كبيرة.
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET?.trim();

if (!DASHBOARD_SECRET) {
  // fail-closed: نُسجِّل تحذيراً صريحاً عند الإقلاع بدل قبول auth غير آمن
  L.warn("routes", "DASHBOARD_SECRET is not set — admin dashboard API will reject all requests until configured");
}

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
  if (!DASHBOARD_SECRET) {
    res.status(503).json({ ok: false, error: "Dashboard auth not configured (set DASHBOARD_SECRET)" });
    return;
  }
  const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !safeEqual(token, DASHBOARD_SECRET)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
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
      // FIX: import.meta.url مقبول في TypeScript ESM — esbuild يحوّله لـ __filename تلقائياً في CJS
      // CJS fallback: import.meta.url is empty in bundled CJS
      const __dirname2 = (typeof import.meta?.url === "string" && import.meta.url) ? path.dirname(fileURLToPath(import.meta.url)) : path.join(process.cwd(), "dist");
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

  // ── CORS للـ mobile app (public endpoints) ───────────────────
  // قابل للضبط عبر env. الافتراضي "*" للتوافق مع تطبيقات mobile قائمة.
  // الحماية الفعلية ضد abuse تأتي من ipRateLimit أدناه.
  const PUBLIC_API_ORIGIN = process.env.PUBLIC_API_ORIGIN || "*";
  const publicCors = (_req: Request, res: Response, next: NextFunction): void => {
    res.header("Access-Control-Allow-Origin",  PUBLIC_API_ORIGIN);
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
    next();
  };
  app.use("/api/search",    publicCors);
  app.use("/api/random",    publicCors);
  app.use("/api/top-books", publicCors);
  app.use("/api/genres",    publicCors);

  // ── Per-IP rate limits على الـ public APIs ───────────────────
  // searchAllSources() تستهلك Firecrawl quota → الـ endpoint كان قابلاً
  // للاستنزاف بدقائق بدون حماية. الحدود محسوبة لحالة الاستخدام العادية:
  //   /api/search    →  20 طلب/دقيقة (مطابق للـ user search rate limit)
  //   /api/random    →  60 طلب/دقيقة (cheap، بدون Firecrawl)
  //   /api/top-books → 120 طلب/دقيقة (Redis read فقط)
  app.use("/api/search",    ipRateLimit({ prefix: "search",    max: 20,  windowMs: 60_000 }));
  app.use("/api/random",    ipRateLimit({ prefix: "random",    max: 60,  windowMs: 60_000 }));
  app.use("/api/top-books", ipRateLimit({ prefix: "top-books", max: 120, windowMs: 60_000 }));

  // ── CORS for dashboard ────────────────────────────────────
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
    // days اختياري: لو محدد ورقم موجب → اشتراك مدفوع بمدة محددة.
    // لو غير محدد أو 0 → admin manual grant بلا انتهاء.
    // reason اختياري — يُسجَّل في audit log عشان نعرف ليه الأدمن منح/سحب
    const body = req.body as { enable: boolean; days?: number; reason?: string };
    const days = Number.isFinite(body.days) && (body.days as number) > 0 ? Math.floor(body.days as number) : 0;
    const reason = (body.reason ?? "").toString().slice(0, 200) || undefined;
    await setPremium(id, body.enable, days, { by: "dashboard", source: "dashboard", reason });
    L.adminAction("dashboard", `${body.enable ? "grant" : "revoke"} premium ${id}${days ? ` (${days}d)` : ""}${reason ? ` — ${reason}` : ""}`);
    ok(res, { done: true, enable: body.enable, days });
  }));

  // Audit log للـ premium — يطبع آخر 50 حركة (grant/revoke) لمستخدم
  app.get("/api/admin/users/:id/premium/audit", auth, wrap(async (req, res) => {
    const id = requireNumericId(req, res); if (!id) return;
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
    ok(res, await getPremiumAudit(id, limit));
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
    // FIX (maintenance-announce): نقرأ الحالة قبل التغيير عشان نعرف لو حصل
    // transition من ON→OFF بالظبط — مش نبعت إعلان لو الـ admin بيتأكد بس
    // (OFF→OFF) أو لو فعّل الصيانة (any→ON).
    const wasActive = (await redis.get(MAINTENANCE_KEY).catch(() => null)) === "1";
    active ? await redis.set(MAINTENANCE_KEY, "1") : await redis.del(MAINTENANCE_KEY);
    L.adminAction("dashboard", `maintenance ${active ? "ON" : "OFF"}`);
    if (wasActive && !active) {
      // emit event — listener في bot/index.ts يبعت الإعلان فعلياً
      (process as NodeJS.EventEmitter).emit("bot:maintenance_ended");
    }
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

  // ── /random genre stats (للـ dashboard) ──────────────────────
  // يقرأ ZREVRANGE stats:random:genres من Redis
  app.get("/api/admin/stats/random-genres", auth, wrap(async (_req, res) => {
    try {
      const raw = await redis.zrevrange("stats:random:genres", 0, -1, "WITHSCORES");
      const genres: {genre:string;count:number}[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        genres.push({ genre: String(raw[i]), count: parseInt(String(raw[i + 1]), 10) || 0 });
      }
      ok(res, genres);
    } catch { ok(res, []); }
  }));

  // ─────────────────────────────────────────────────────────────
  // DB QUERIES — direct PostgreSQL reads for the dashboard
  // ─────────────────────────────────────────────────────────────
  // Used by Users tab (existing UI calls users/all)
  app.get("/api/admin/users/all", auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "200", 10);
    const rawOffset = parseInt(req.query.offset as string || "0", 10);
    const limit = isNaN(rawLimit) ? 200 : Math.min(500, Math.max(1, rawLimit));
    const offset = isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
    const result = await storage.getAllUsersWithDetails(limit, offset);
    ok(res, result);
  }));

  app.get("/api/admin/db/users", auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "50", 10);
    const rawOffset = parseInt(req.query.offset as string || "0", 10);
    const limit = isNaN(rawLimit) ? 50 : Math.min(200, Math.max(1, rawLimit));
    const offset = isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
    const result = await storage.getAllUsersWithDetails(limit, offset);
    ok(res, result);
  }));

  app.get("/api/admin/db/top-users", auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "20", 10);
    const limit = isNaN(rawLimit) ? 20 : Math.min(100, Math.max(1, rawLimit));
    ok(res, await storage.getTopUsers(limit));
  }));

  app.get("/api/admin/db/recent-searches", auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "50", 10);
    const limit = isNaN(rawLimit) ? 50 : Math.min(200, Math.max(1, rawLimit));
    ok(res, await storage.getRecentSearches(limit));
  }));

  app.get("/api/admin/db/cached-books", auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "100", 10);
    const limit = isNaN(rawLimit) ? 100 : Math.min(500, Math.max(1, rawLimit));
    try {
      const { db } = await import("./storage.js");
      const { cachedBooks } = await import("../shared/schema.js");
      const { desc } = await import("drizzle-orm");
      const rows = await db.select().from(cachedBooks).orderBy(desc(cachedBooks.timesServed)).limit(limit);
      ok(res, rows);
    } catch (err) {
      L.error("admin", "cached-books query failed", { err: String(err).slice(0, 200) });
      ok(res, []);
    }
  }));

  app.get("/api/admin/db/user/:id", auth, wrap(async (req, res) => {
    const id = req.params.id;
    try {
      const history = await storage.getUserSearchHistory(id, 50);
      const limit = await storage.getDailyDownloadCount(id);
      ok(res, { telegramId: id, history, todayDownloads: limit });
    } catch (err) {
      ok(res, { telegramId: id, history: [], todayDownloads: 0 });
    }
  }));

  // Full user profile (drilldown) — used by UserModal
  app.get("/api/admin/db/user/:id/full", auth, wrap(async (req, res) => {
    const id = req.params.id;
    try {
      const { db } = await import("./storage.js");
      const { users, searchLogs } = await import("../shared/schema.js");
      const { eq, desc, sql } = await import("drizzle-orm");

      const [userRow] = await db.select().from(users).where(eq(users.telegramId, id)).limit(1);
      const recentSearches = await db.select().from(searchLogs)
        .where(eq(searchLogs.telegramUserId, id))
        .orderBy(desc(searchLogs.createdAt))
        .limit(50);
      const daily = await db.select({
        day: sql<string>`TO_CHAR(${searchLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        searches: sql<number>`COUNT(*)::int`,
        downloads: sql<number>`COUNT(*) FILTER (WHERE ${searchLogs.pdfSent} = true)::int`,
        success: sql<number>`COUNT(*) FILTER (WHERE ${searchLogs.bookFound} = true)::int`,
      }).from(searchLogs)
        .where(eq(searchLogs.telegramUserId, id))
        .groupBy(sql`TO_CHAR(${searchLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`)
        .orderBy(sql`TO_CHAR(${searchLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD') DESC`)
        .limit(30);

      const [premiumStatus, bannedStatus, todayDownloads] = await Promise.all([
        isPremium(id).catch(() => false),
        (redis.sismember("banned_users", id).catch(() => 0)).then(v => !!v),
        storage.getDailyDownloadCount(id).catch(() => 0),
      ]);

      ok(res, {
        user: userRow || { telegramId: id, firstName: null, username: null, totalSearches: 0, totalDownloads: 0, createdAt: null },
        recentSearches,
        daily: daily.reverse(),
        premium: premiumStatus,
        banned: bannedStatus,
        todayDownloads,
      });
    } catch (err) {
      L.error("admin", "user/full failed", { id, err: String(err).slice(0, 200) });
      ok(res, { user: null, recentSearches: [], daily: [], premium: false, banned: false, todayDownloads: 0 });
    }
  }));

  // Failed searches — top queries that didn't find anything
  app.get("/api/admin/db/failed-searches", auth, wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "100", 10);
    const limit = isNaN(rawLimit) ? 100 : Math.min(500, Math.max(1, rawLimit));
    try {
      const { db } = await import("./storage.js");
      const { searchLogs } = await import("../shared/schema.js");
      const { eq, sql } = await import("drizzle-orm");
      const rows = await db.select({
        query: searchLogs.query,
        times: sql<number>`COUNT(*)::int`,
        users: sql<number>`COUNT(DISTINCT ${searchLogs.telegramUserId})::int`,
        lastTry: sql<string>`MAX(${searchLogs.createdAt})`,
      }).from(searchLogs)
        .where(eq(searchLogs.bookFound, false))
        .groupBy(searchLogs.query)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(limit);
      ok(res, rows);
    } catch (err) {
      L.error("admin", "failed-searches query failed", { err: String(err).slice(0, 200) });
      ok(res, []);
    }
  }));

  // Hour-of-day × day-of-week heatmap
  app.get("/api/admin/db/hourly-heatmap", auth, wrap(async (_req, res) => {
    try {
      const { db } = await import("./storage.js");
      const { searchLogs } = await import("../shared/schema.js");
      const { sql } = await import("drizzle-orm");
      const rows = await db.select({
        dow: sql<number>`EXTRACT(DOW FROM ${searchLogs.createdAt})::int`,
        hour: sql<number>`EXTRACT(HOUR FROM ${searchLogs.createdAt})::int`,
        count: sql<number>`COUNT(*)::int`,
      }).from(searchLogs).groupBy(sql`EXTRACT(DOW FROM ${searchLogs.createdAt}), EXTRACT(HOUR FROM ${searchLogs.createdAt})`);
      // Build 7×24 matrix
      const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      let max = 0;
      for (const r of rows) {
        const d = Number(r.dow), h = Number(r.hour), c = Number(r.count);
        if (d >= 0 && d < 7 && h >= 0 && h < 24) {
          matrix[d][h] = c;
          if (c > max) max = c;
        }
      }
      ok(res, { matrix, max });
    } catch (err) {
      L.error("admin", "heatmap query failed", { err: String(err).slice(0, 200) });
      ok(res, { matrix: Array.from({ length: 7 }, () => Array(24).fill(0)), max: 0 });
    }
  }));

  // ── source toggle (تفعيل/إيقاف مصدر من الـ dashboard) ────────
  // BUG FIX: كان يكتب `src:off:{domain}` بـ raw param بدون normalization،
  // بينما analytics.ts يكتب stats الـ source بـ sanitizeDomainKey (lowercase،
  // strip `www.`، strip non-alnum). نتيجة: الـ engine ما كانش يلاقي الـ key
  // لما يقرأ الـ disabled set عشان مفتاح الكتابة != مفتاح القراءة.
  // الآن: setSourceManuallyDisabled تسلسل واحد ومتسق مع باقي الـ analytics.
  app.post("/api/admin/sources/:domain/toggle", auth, wrap(async (req, res) => {
    const domain = sanitizeDomainKey(req.params.domain);
    if (!domain) { res.status(400).json({ ok: false, error: "invalid domain" }); return; }
    const { action }  = req.body as { action: "enable" | "disable" };
    const off = action === "disable";
    await setSourceManuallyDisabled(domain, off);
    L.adminAction("dashboard", `source ${off ? "disabled" : "enabled"}: ${domain}`);
    ok(res, { domain, enabled: !off });
  }));

  // ── broadcast (بث جماعي من الـ dashboard) ────────────────────
  app.post("/api/admin/broadcast", auth, wrap(async (req, res) => {
    const { message, parse_mode, target } = req.body as { message: string; parse_mode?: string; target?: string };
    if (!message?.trim()) { res.status(400).json({ ok: false, error: "message required" }); return; }
    if (message.length > 4000) { res.status(400).json({ ok: false, error: "message too long" }); return; }
    const tgt = ["all", "premium", "active7"].includes(target || "") ? target! : "all";
    // تقدير عدد المستلمين قبل الإطلاق (للعرض في الـ dashboard)
    let total = 0;
    try {
      if (tgt === "premium") {
        const { listPremiumUsers } = await import("./bot/userSettings.js");
        total = (await listPremiumUsers()).length;
      } else {
        total = (await storage.getAllUserIds().catch(() => [] as string[])).length;
      }
    } catch { /* keep 0 */ }
    // نُشغِّل البث عبر event — bot/index.ts يتولى الإرسال
    (process.emit as any)("dashboard:broadcast", { message, parse_mode: parse_mode || "Markdown", target: tgt });
    L.adminAction("dashboard", `broadcast queued [target=${tgt}, est=${total}]: ${message.slice(0, 50)}`);
    ok(res, { queued: true, target: tgt, total, sent: 0, failed: 0 });
  }));

  // ── user info ─────────────────────────────────────────────────
  app.get("/api/admin/users/:id/info", auth, wrap(async (req, res) => {
    const { id } = req.params;
    const [prem, limit, dlCount, banned] = await Promise.all([
      isPremium(id),
      getUserDailyLimit(id),
      storage.getDailyDownloadCount(id).catch(() => 0),
      (redis.sismember("banned_users", id).catch(() => 0)).then(v => !!v),
    ]);
    ok(res, { id, premium: prem, dailyLimit: limit, todayDownloads: dlCount, banned });
  }));

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API — للـ Mobile App
  //  لا يحتاج auth — مفتوح لأي client
  // ═══════════════════════════════════════════════════════════

  // ── GET /api/search?q={bookName} ──────────────────────────
  // يبحث في 13+ مصدر عربي ويُعيد أفضل نتيجة
  app.get("/api/search", wrap(async (req, res) => {
    const q = ((req.query.q as string) || "").trim();
    if (!q || q.length < 2) {
      return fail(res, "query too short", 400);
    }
    if (q.length > 200) {
      return fail(res, "query too long", 400);
    }

    try {
      // 1. جرّب الكاش أولاً
      const cached = await getSearchCacheResults(q).catch(() => []);
      if (cached.length > 0) {
        const best = cached[0];
        return ok(res, {
          title:   best.title,
          author:  extractAuthor(best.title),
          pdfUrl:  best.directPdfUrl || best.url,
          source:  best.source?.name || best.source?.domain || "مصدر عربي",
          emoji:   best.source?.emoji || "📚",
          sizeMB:  null,
          cached:  true,
        });
      }

      // 2. بحث حقيقي في المصادر
      const results = await searchAllSources(q);
      if (!results || results.length === 0) {
        // أعد اقتراحات مشابهة
        const suggestions = getSuggestionsFor(q);
        return ok(res, {
          found:       false,
          suggestions,
          tips:        [],
        });
      }

      // أعد أفضل نتيجة
      const best = results[0];
      return ok(res, {
        title:   best.title,
        author:  extractAuthor(best.title),
        pdfUrl:  best.directPdfUrl || best.url,
        source:  best.source?.name || best.source?.domain || "مصدر عربي",
        emoji:   best.source?.emoji || "📚",
        sizeMB:  null,
        cached:  false,
        found:   true,
      });
    } catch (e) {
      L.error("api", "search error", { q: q.slice(0, 50), err: String(e).slice(0, 100) });
      return fail(res, "search failed", 500);
    }
  }));

  // ── GET /api/random?genre={genre} ────────────────────────
  // يُعيد كتاباً عشوائياً من النوع المطلوب
  app.get("/api/random", wrap(async (req, res) => {
    const genreId = ((req.query.genre as string) || "").trim().toLowerCase();

    // ابحث عن النوع المطلوب
    let genre = GENRES.find(g => g.id === genreId);
    if (!genre && genreId) {
      // جرّب بالاسم العربي
      genre = GENRES.find(g =>
        normalizeArabic(g.label).includes(normalizeArabic(genreId)) ||
        normalizeArabic(genreId).includes(normalizeArabic(g.label))
      );
    }
    // لو ما لقيناش → اختر نوع عشوائي
    if (!genre) {
      genre = GENRES[Math.floor(Math.random() * GENRES.length)];
    }

    // اختر كتاباً عشوائياً من النوع
    const books = genre.books || [];
    if (!books.length) return fail(res, "no books for genre", 404);

    const book = books[Math.floor(Math.random() * books.length)];

    return ok(res, {
      title:   book,
      author:  extractAuthor(book),
      genre:   genre.label,
      genreId: genre.id,
      emoji:   genre.emoji || "📚",
    });
  }));

  // ── GET /api/top-books?limit=10 ──────────────────────────
  // أكثر الكتب طلباً — بدون auth
  app.get("/api/top-books", wrap(async (req, res) => {
    const rawLimit = parseInt(req.query.limit as string || "10", 10);
    const limit = isNaN(rawLimit) ? 10 : Math.min(50, Math.max(1, rawLimit));
    const books = await getTopBooks(limit).catch(() => []);
    return ok(res, books);
  }));

  // ── GET /api/genres ──────────────────────────────────────
  // قائمة الأنواع المتاحة للـ random
  app.get("/api/genres", (_req, res) => {
    ok(res, GENRES.map(g => ({
      id:    g.id,
      label: g.label,
      emoji: g.emoji,
      count: (g.books || []).length,
    })));
  });

  // ── POST /api/broadcast (من dashboard) ──────────────────
  // listener للـ broadcast event
  process.on("dashboard:broadcast" as any, async ({ message, parse_mode }: { message: string; parse_mode: string }) => {
    try {
      const allIds = await storage.getAllUserIds().catch(() => [] as string[]);
      L.info("broadcast", `Sending to ${allIds.length} users`);
      let sent = 0, failed = 0;
      for (const userId of allIds) {
        try {
          // استخدم botInstance من index.ts عبر global
          const botGlobal = (global as any).__botInstance;
          if (botGlobal) {
            await botGlobal.sendMessage(Number(userId), message, { parse_mode });
            sent++;
          }
          // rate limit: 30 رسالة/ثانية لـ Telegram API
          if (sent % 30 === 0) await new Promise(r => setTimeout(r, 1000));
        } catch { failed++; }
      }
      L.info("broadcast", `Done: ${sent} sent, ${failed} failed`);
    } catch (e) {
      L.error("broadcast", "broadcast error", { err: String(e).slice(0, 100) });
    }
  });

}

// ── Helpers للـ public API ────────────────────────────────────

/** يستخرج اسم المؤلف من "العنوان — المؤلف" */
function extractAuthor(title: string): string {
  const sep = title.includes(" — ") ? " — " : title.includes(" - ") ? " - " : null;
  if (sep) {
    const parts = title.split(sep);
    if (parts.length >= 2) return parts[parts.length - 1].trim();
  }
  return "";
}

/** يُعيد اقتراحات مشابهة للكتاب غير الموجود */
function getSuggestionsFor(bookName: string): string[] {
  const norm = normalizeArabic(bookName);
  for (const [keys, books] of Object.entries(GENRE_MAP)) {
    if (keys.split("|").some(k => norm.includes(normalizeArabic(k)) || normalizeArabic(k).includes(norm))) {
      return books.slice(0, 3);
    }
  }
  // fallback: 3 كتب عشوائية من SUGGESTIONS
  return SUGGESTIONS.sort(() => 0.5 - Math.random()).slice(0, 3);
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
