import express from "express";
import { createServer } from "http";
import { registerRoutes } from "./routes.js";
import { L } from "./bot/logger.js";

// ══════════════════════════════════════════════
// ENTRY POINT — Express server + Dashboard + Bot
// registerRoutes() تبدأ البوت داخليا
// ══════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || "5000", 10);

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);

  await registerRoutes(httpServer, app);

  httpServer.listen(PORT, "0.0.0.0", () => {
    L.info("server", `Server ready on port ${PORT} — Dashboard: /dashboard`);
  });
}

// ── Graceful shutdown ─────────────────────────
process.on("SIGTERM", () => {
  L.info("server", "SIGTERM received — shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  L.info("server", "SIGINT received — shutting down...");
  process.exit(0);
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
