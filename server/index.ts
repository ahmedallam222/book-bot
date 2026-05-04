import express from "express";
import helmet from "helmet";
import { createServer, type Server } from "http";
import { registerRoutes } from "./routes.js";
import { L } from "./bot/logger.js";
import { gracefulShutdown } from "./bot/index.js";
import { redis } from "./bot/redis.js";

// ══════════════════════════════════════════════
// ENTRY POINT — Express server + Dashboard + Bot
// registerRoutes() تبدأ البوت داخليا
// ══════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || "5000", 10);
// مهم لما البوت يكون خلف reverse proxy (Nginx/Caddy/Cloudflare):
// (أ) req.ip يرجّع X-Forwarded-For بدل IP الـ proxy (يتمسّ ipRateLimit)،
// (ب) req.protocol يرجّع https لو الـ proxy يفك TLS.
// 0 (افتراضي) = ثقة بـ socket.remoteAddress فقط (آمن لما لا proxy).
// 1 = ثقة بأول hop (آمن عند تشغيل nginx/caddy على نفس الجهاز).
// قابل للضبط عبر env عشان تشغيل خلف Cloudflare يحتاج 2.
const TRUST_PROXY = parseInt(process.env.TRUST_PROXY || "0", 10);
// host binding: 127.0.0.1 افتراضياً عند تشغيل خلف reverse proxy على
// نفس الجهاز (الأكثر أماناً). 0.0.0.0 لو direct exposure أو docker.
// docker-compose يُمرّر BOT_PORT_BIND للـ host port forwarding بشكل منفصل.
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";

let _httpServer: Server | null = null;
let _shuttingDown = false;

// ── ENV validation عند الإقلاع ────────────────
// نفشل بسرعة بدل ما نكتشف لاحقاً أن متغير حرج مفقود (e.g. لما الأول
// مستخدم يبعث رسالة فيظهر error غامض). الـ envs التالية لا غنى عنها:
function validateEnv(): void {
  const required = ["BOT_TOKEN", "DATABASE_URL", "REDIS_URL"] as const;
  const missing: string[] = [];
  for (const k of required) {
    const v = (process.env[k] || "").trim();
    if (!v) missing.push(k);
  }
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!process.env.DASHBOARD_SECRET?.trim()) {
    // لا نوقف التشغيل — auth.ts بيرفض الطلبات بـ 503 لو فاضي.
    // لكن نحذّر بوضوح وقت الإقلاع.
    console.warn("[startup] DASHBOARD_SECRET is not set — /api/admin/* will return 503 until configured");
  }
}

async function main(): Promise<void> {
  validateEnv();
  const app = express();
  // trust proxy: لازم ليصل req.ip للـ ipRateLimit من X-Forwarded-For
  // عند التشغيل خلف reverse proxy. الافتراضي 0 آمن (no trust).
  app.set("trust proxy", TRUST_PROXY);
  // helmet: security headers قياسية. CSP معطّلة لأن الـ dashboard inline
  // (script tag كبير في dashboard.html) — لو فُصِل لاحقاً يمكن تفعيلها.
  // crossOriginEmbedderPolicy معطّلة لأنها تكسر تحميل الفونتس الخارجية.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  // body limit واضح بدل الافتراضي 100KB — يمنع large payloads على الـ admin endpoints
  app.use(express.json({ limit: "200kb" }));
  _httpServer = createServer(app);

  await registerRoutes(_httpServer, app);

  _httpServer.listen(PORT, BIND_HOST, () => {
    L.info("server", `Server ready on ${BIND_HOST}:${PORT} — Dashboard: /dashboard (trust_proxy=${TRUST_PROXY})`);
  });
}

// ── Graceful shutdown ─────────────────────────
async function shutdown(signal: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  L.info("server", `${signal} received — shutting down gracefully...`);

  // 1. أوقِف قبول طلبات HTTP جديدة
  if (_httpServer) {
    _httpServer.close((err) => {
      if (err) L.warn("server", "http server close error", { err: String(err).slice(0, 80) });
    });
  }

  // 2. أوقِف الـ bot polling + انتظر الـ workers ينتهوا
  await gracefulShutdown(30_000);

  // 3. أغلق اتصال Redis
  try { await redis.quit(); }
  catch (e) { L.warn("server", "redis quit error", { err: String(e).slice(0, 80) }); }

  L.info("server", "Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT");  });

// safety net — if shutdown takes longer than 60s, force-exit
process.on("SIGTERM", () => {
  setTimeout(() => {
    L.error("server", "Forced exit after timeout");
    process.exit(1);
  }, 60_000).unref();
});

process.on("uncaughtException", (err) => {
  L.error("server", "uncaughtException", { err: String(err).slice(0, 200) });
});

process.on("unhandledRejection", (reason) => {
  L.error("server", "unhandledRejection", { reason: String(reason).slice(0, 200) });
});

main().catch((e) => {
  console.error("[FATAL] startup failed:", e);
  process.exit(1);
});
