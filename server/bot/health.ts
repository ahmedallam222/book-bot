import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { getQueueStats } from "./queue.js";
import { activeWorkerCount } from "./worker.js";
import { getTempStats } from "./tempFiles.js";
import { getDailyStats, getTotalStats, getTopBooks, getSourceStats, getWeeklyStats, getFunnelStats } from "./analytics.js";
import { escMd } from "./text.js";
import * as path from "path";
import * as fs from "fs";

// ══════════════════════════════════════════════
// HEALTH CHECK — /health + /stats
// ══════════════════════════════════════════════

function bar(value: number, max: number, len = 10): string {
  const filled = Math.round((Math.min(Math.max(value, 0), max) / Math.max(max, 1)) * len);
  return "▰".repeat(filled) + "▱".repeat(len - filled);
}

function statusEmoji(ok: boolean): string {
  return ok ? "🟢" : "🔴";
}

export async function sendHealthReport(bot: TelegramBot, chatId: number): Promise<void> {
  const t0 = Date.now();

  // جمع كل البيانات بالتوازي
  const [redisOk, qStats, workerCount, tempStats, dailyStats, totalStats] =
    await Promise.all([
      redis.ping().then(() => true).catch(() => false),
      getQueueStats().catch(() => ({ highQueue: 0, normalQueue: 0, dlqSize: 0, totalActiveJobs: 0 })),
      Promise.resolve(activeWorkerCount()),
      Promise.resolve(getTempStats()),
      getDailyStats().catch(() => null),
      getTotalStats().catch(() => null),
    ]);

  const memUsage  = process.memoryUsage();
  const memMB     = (memUsage.heapUsed  / 1024 / 1024).toFixed(1);
  const totalMB   = (memUsage.heapTotal / 1024 / 1024).toFixed(1);
  const rsseMB    = (memUsage.rss       / 1024 / 1024).toFixed(1);
  const upSec     = Math.floor(process.uptime());
  const upH       = Math.floor(upSec / 3600);
  const upM       = Math.floor((upSec % 3600) / 60);
  const checkMs   = Date.now() - t0;
  const tempMB    = (tempStats.totalBytes / 1024 / 1024).toFixed(1);

  const qTotal    = qStats.highQueue + qStats.normalQueue;
  const qHealth   = qTotal < 20 ? "🟢" : qTotal < 50 ? "🟡" : "🔴";
  const memHealth = parseFloat(memMB) < 300 ? "🟢" : parseFloat(memMB) < 500 ? "🟡" : "🔴";

  const successLine = dailyStats
    ? `نجاح اليوم: *${dailyStats.success}* / ${dailyStats.downloads} (${dailyStats.successRate})`
    : "_لا بيانات_";

  const msg =
    `🏥 *تقرير صحة البوت*\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +

    `*🔗 الاتصالات:*\n` +
    `${statusEmoji(redisOk)} Redis: *${redisOk ? "متصل" : "⚠️ منفصل!"}*\n\n` +

    `*⚙️ العمال (Workers):*\n` +
    `🟢 نشطون: *${workerCount}* عامل\n\n` +

    `*📋 الطابور:*\n` +
    `${qHealth} إجمالي: *${qTotal}* طلب\n` +
    `⚡ High: *${qStats.highQueue}*  📋 Normal: *${qStats.normalQueue}*\n` +
    `💀 DLQ: *${qStats.dlqSize}* طلب فاشل\n\n` +

    `*💾 الذاكرة:*\n` +
    `${memHealth} Heap: *${memMB} / ${totalMB} MB*\n` +
    `📊 \`${bar(parseFloat(memMB), 512)}\`\n` +
    `🖥️ RSS: *${rsseMB} MB*\n\n` +

    `*📁 Temp Files:*\n` +
    `📄 الملفات: *${tempStats.totalFiles}* (${tempMB} MB)\n\n` +

    `*📊 إحصائيات اليوم:*\n` +
    `🔍 بحثات: *${dailyStats?.searches ?? "—"}*\n` +
    `${successLine}\n` +
    `⚡ Cache hits: *${dailyStats?.cacheHits ?? "—"}*\n` +
    `👥 مستخدمون نشطون: *${dailyStats?.activeUsers ?? "—"}*\n\n` +

    `*🌍 الكلي (مدى الحياة):*\n` +
    `🔍 *${totalStats?.totalSearches ?? "—"}* بحث | 📥 *${totalStats?.totalDownloads ?? "—"}* تحميل\n\n` +

    `*⚡ الأداء:*\n` +
    `⏱️ Uptime: *${upH}س ${upM}د*\n` +
    `🏓 Response: *${checkMs}ms*`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📊 Analytics مفصّلة", callback_data: "admin_analytics"      },
          { text: "📈 آخر 7 أيام",       callback_data: "admin_weekly"         },
        ],
        [
          { text: "🔌 حالة المصادر",    callback_data: "admin_source_health"  },
          { text: "🔄 تحديث",           callback_data: "admin_health"         },
        ],
      ],
    },
  });

  L.info("admin", `/health requested`, { chatId, checkMs });
}

// ── Analytics Panel ───────────────────────────

export async function sendAnalyticsPanel(bot: TelegramBot, chatId: number): Promise<void> {
  const [daily, total, topBooks, funnel] = await Promise.all([
    getDailyStats(),
    getTotalStats(),
    getTopBooks(5),
    getFunnelStats(),
  ]);

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
  let topStr = "_لا بيانات بعد_";
  if (topBooks.length > 0) {
    topStr = topBooks.map((b, i) =>
      `${medals[i] || `${i + 1}.`} ${escMd(b.title.slice(0, 45))} *(${b.count})*`
    ).join("\n");
  }

  // ── قسم Funnel — يشخّص سبب انخفاض نسبة النجاح ───────────────
  let funnelStr = "_لا بيانات funnel بعد_";
  if (funnel) {
    const searchTotal = funnel.searchFound + funnel.searchMiss;
    // BUG-8 FIX: كان \\n (escaped) بدل \n (newline) → الـ funnel يظهر على سطر واحد
    // في template literals: \\n = حرفان backslash+n, \n = newline حقيقي
    funnelStr =
      `🔍 بحث ناجح: *${funnel.searchFound}* / ${searchTotal} _(${funnel.searchRate})_\n` +
      `✔️ تحقق URLs: *${funnel.verifyValid}* / ${funnel.verifyChecked} _(${funnel.verifyRate})_\n` +
      `✅ إرسال ناجح: *${funnel.sendSuccess}* / ${funnel.searchFound} _(${funnel.sendRate})_\n` +
      `⚡ Direct: *${funnel.sendDirect}* | 💾 Local: *${funnel.sendLocal}*`;
  }

  const msg =
    `📊 *Analytics — ${daily.date}*\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +

    `*📈 اليوم:*\n` +
    `🔍 بحثات: *${daily.searches}*\n` +
    `📥 تحميلات: *${daily.downloads}*\n` +
    `✅ ناجحة: *${daily.success}* (${daily.successRate})\n` +
    `❌ فاشلة: *${daily.fail}*\n` +
    `⚡ Cache hits: *${daily.cacheHits}* (${daily.cacheRate})\n` +
    `⏱️ متوسط الوقت: *${daily.avgMs}ms*\n` +
    `👥 مستخدمون نشطون: *${daily.activeUsers}*\n\n` +

    `*🔬 Pipeline (تشخيص المشاكل):*\n` +
    `${funnelStr}\n\n` +

    `*🌍 الكلي:*\n` +
    `🔍 *${total.totalSearches.toLocaleString()}* بحث\n` +
    `📥 *${total.totalDownloads.toLocaleString()}* تحميل\n\n` +

    `*📚 أكثر 5 كتب طلباً اليوم:*\n${topStr}`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📈 آخر 7 أيام",     callback_data: "admin_weekly"        },
          { text: "🔌 المصادر",        callback_data: "admin_source_health" },
        ],
        [{ text: "◀️ رجوع",           callback_data: "admin_refresh"       }],
      ],
    },
  });
}

// ── Weekly Chart ──────────────────────────────

export async function sendWeeklyStats(bot: TelegramBot, chatId: number): Promise<void> {
  const week = await getWeeklyStats();

  let msg = `📈 *آخر 7 أيام*\n━━━━━━━━━━━━━━━━━\n\n`;

  for (const d of week) {
    const isToday = d.date === new Date().toISOString().slice(0, 10);
    const label   = isToday ? `*${d.date} (اليوم)*` : d.date;
    const b       = bar(d.success, Math.max(d.downloads, 1), 8);
    msg += `${label}\n🔍 ${d.searches} | 📥 ${d.downloads} | ✅ ${d.success} | \`${b}\` ${d.successRate}\n\n`;
  }

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "◀️ رجوع", callback_data: "admin_analytics" }]] },
  });
}

// ── Source Health ─────────────────────────────

export async function sendSourceHealth(bot: TelegramBot, chatId: number): Promise<void> {
  const sources = await getSourceStats();

  let msg = `🔌 *حالة المصادر اليوم*\n━━━━━━━━━━━━━━━━━\n\n`;

  if (sources.length === 0) {
    msg += "_لا بيانات بعد — ابدأ البحث لتُجمَع الإحصائيات_";
  } else {
    for (const s of sources) {
      const health = s.autoDisabled ? "⛔" : s.ok > s.fail ? "🟢" : s.ok === 0 ? "🔴" : "🟡";
      const status = s.autoDisabled ? " — معطّل تلقائياً" : "";
      msg += `${health} \`${s.domain}\`${status}\n✅ ${s.ok} | ❌ ${s.fail} | معدل: *${s.rate}*\n\n`;
    }
  }

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "◀️ رجوع", callback_data: "admin_analytics" }]] },
  });
}
