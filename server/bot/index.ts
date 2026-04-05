import TelegramBot from "node-telegram-bot-api";
import { L, closeLogger } from "./logger.js";
import { ADMIN_IDS, QUEUE_WORKERS, TEMP_CLEANUP_INTERVAL } from "./config.js";
import { setAlertBot } from "./blacklist.js";
import { seedBansFromEnv } from "./guards.js";
import { ensureTempDir, cleanTempFiles } from "./tempFiles.js";
import { cleanSessionStore } from "./session.js";
import { SOURCES } from "./sources.js";
import { registerCommands, registerMessageHandler } from "./commands.js";
import { registerCallbackHandler } from "./callbacks.js";
import { initWorkers, stopWorkers, activeWorkerCount } from "./worker.js";
import { startAlertWatcher } from "./alertWatcher.js";
import { broadcastWeeklyToAdmins } from "./weekly.js";

// ══════════════════════════════════════════════
// BOT ENTRY POINT — v5
// ══════════════════════════════════════════════

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export async function startBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    L.error("bot", "TELEGRAM_BOT_TOKEN not set — aborting");
    return;
  }

  ensureTempDir();

  // Temp file cleanup
  if (cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }
  cleanupInterval = setInterval(() => {
    cleanTempFiles([]);
    cleanSessionStore();   // تنظيف session store من الـ entries القديمة (منع memory leak)
  }, TEMP_CLEANUP_INTERVAL).unref();

  await seedBansFromEnv().catch((e) =>
    L.error("system", "seedBansFromEnv failed", { err: String(e) })
  );

  // Drop pending updates بعد restart
  await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drop_pending_updates: true }),
  }).catch(() => {});

  const bot = new TelegramBot(token, {
    polling: { autoStart: true, params: { timeout: 30 } },
  });

  bot.on("polling_error", (e: any) => L.botError(String(e?.message || e)));

  // Bot info
  let botUsername = "", botId = 0;
  try {
    const me = await bot.getMe();
    botUsername = me.username || "";
    botId       = me.id;
    L.botStart(botUsername, QUEUE_WORKERS, SOURCES.length);
  } catch (e) {
    L.error("bot", "Failed to get bot info", { err: String(e) });
  }

  setAlertBot(bot);

  // ── Register bot commands list (يظهر في قائمة Telegram) ──────────
  bot.setMyCommands([
    { command: "start",   description: "القائمة الرئيسية" },
    { command: "search",  description: "بحث عن كتاب" },
    { command: "random",  description: "كتاب عشوائي (اختياري: نوع)" },
    { command: "stats",   description: "إحصائياتي اليومية" },
    { command: "history", description: "آخر كتب حمّلتها" },
    { command: "last",    description: "إعادة تحميل آخر كتاب طلبته" },
    { command: "top",     description: "أكثر الكتب طلباً" },
    { command: "weekly",  description: "تقريري الأسبوعي" },
    { command: "cancel",  description: "إلغاء الطلب الحالي" },
    { command: "queue",   description: "حالة الطابور" },
    { command: "help",    description: "دليل الاستخدام" },
  ]).catch(() => {});

  // ── Workers ──────────────────────────────────────────────────────
  initWorkers(bot);

  // ── Handlers ──────────────────────────────────────────────────────
  registerCommands(bot, token, () => botUsername, () => botId);
  registerCallbackHandler(bot, token);
  registerMessageHandler(bot, token, () => botUsername);

  // ── Group welcome ─────────────────────────────────────────────────
  bot.on("new_chat_members", async (msg) => {
    if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
    const botJoined = botId > 0 && (msg.new_chat_members ?? []).some((m) => m.id === botId);
    if (!botJoined) return;
    await bot.sendMessage(
      msg.chat.id,
      `📚 *أهلاً! أنا بوت خلاصة الكتب*\n\n` +
      `اكتب *بوت* ثم اسم أي كتاب وأُرسله PDF مجاناً!\n\n` +
      `مثال: \`بوت أرض زيكولا\``,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  // ── Alert watcher (Step 1) ────────────────────────────────────────
  // يبدأ فوراً — يقرأ ADMIN_IDS من env، لا يحتاج فتح /admin
  startAlertWatcher(bot);

  // ── Weekly broadcast scheduler ────────────────────────────────────
  // يُرسل تقريراً أسبوعياً لكل الأدمنز كل يوم جمعة مساءً (تلقائياً)
  // checkInterval: كل ساعة — فعلياً يُرسل مرة واحدة كل 7 أيام (Redis key)
  const WEEKLY_CHECK_INTERVAL = 60 * 60 * 1000; // كل ساعة
  setInterval(() => {
    const now = new Date();
    // يوم الجمعة (5) الساعة 20:00 مساءً (Riyadh UTC+3 = 17:00 UTC)
    if (now.getUTCDay() === 5 && now.getUTCHours() === 17) {
      broadcastWeeklyToAdmins(bot).catch(e =>
        L.error("bot", "Weekly broadcast error", { err: String(e).slice(0, 100) })
      );
    }
  }, WEEKLY_CHECK_INTERVAL).unref();

  // ── Graceful shutdown ─────────────────────────────────────────────
  const shutdown = (signal: string) => {
    L.info("system", `Shutdown: ${signal}`);
    if (cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }
    stopWorkers();
    cleanTempFiles([]);
    bot.stopPolling();
    L.info("system", "Bot stopped ✅");
    closeLogger();   // أغلق log file وفرّغ الـ buffer قبل الخروج
  };

  // حفظ مرجع shutdown لاستخدامه في signal handlers الخارجية
  _shutdownRef = shutdown;
}

// ── Signal handlers — مُسجَّلة مرة واحدة على مستوى الـ module ─────────────
// تمنع تراكم listeners عند إعادة استدعاء startBot (hot-reload)
let _shutdownRef: ((sig: string) => void) | null = null;

process.once("SIGTERM",           () => _shutdownRef?.("SIGTERM"));
process.once("SIGINT",            () => _shutdownRef?.("SIGINT"));
process.on("uncaughtException",   (e) => {
  L.error("system", "Uncaught exception — exiting", { err: String(e).slice(0, 300) });
  // BUG FIX: الكود القديم كان يسجّل الخطأ ويكمل — يترك البوت في حالة غير محددة
  // الصحيح: الخروج بـ code 1 فوراً بعد التسجيل — process manager (PM2/systemd) يُعيد التشغيل
  process.exit(1);
});
process.on("unhandledRejection",  (r) => L.error("system", "Unhandled rejection", { reason: String(r).slice(0, 300) }));

// Re-export for server/routes.ts
export { activeWorkerCount };
