import * as fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { storage } from "../storage.js";
import { L } from "./logger.js";
import { redis } from "./redis.js";
import { TEMP_DIR, MAINTENANCE_KEY, BOT_ANNOUNCE_KEY } from "./config.js";
import { SOURCES } from "./sources.js";
import { escMd } from "./text.js";
import { blacklistStats, clearBlacklist } from "./blacklist.js";
import { bannedCount, bannedList } from "./guards.js";
import { getQueueStats, clearQueues, clearDLQ, getDLQJobs } from "./queue.js";
import { getTopBooks, getDailyStats, invalidateTodayStatsCache } from "./analytics.js";
import { activeWorkerCount } from "./worker.js";
import {
  isPremium, setPremium, listPremiumUsers, premiumCount,
  getUserDailyLimit, setUserDailyLimit, resetUserDailyLimit,
  setUserNote, clearUserNote,
} from "./userSettings.js";
import {
  sendHealthReport, sendAnalyticsPanel, sendWeeklyStats, sendSourceHealth,
} from "./health.js";
// ══════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════

export async function sendAdminPanel(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const [stats, cacheStats, bl, bCount, qStats, pCount, isMaint, today] = await Promise.all([
      storage.getStats().catch(() => ({ totalUsers: 0, totalSearches: 0, totalDownloads: 0 })),
      storage.getCacheStats().catch(() => ({ totalCached: 0, totalServed: 0 })),
      blacklistStats().catch(() => ({ total: 0, active: 0 })),
      bannedCount().catch(() => 0),
      getQueueStats(),
      premiumCount().catch(() => 0),
      redis.get(MAINTENANCE_KEY).catch(() => null),
      getDailyStats().catch(() => null),
    ]);

    const memMB      = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    const upSec      = Math.floor(process.uptime());
    const upH        = Math.floor(upSec / 3600);
    const upM        = Math.floor((upSec % 3600) / 60);
    const upStr      = upH > 0 ? `${upH}س ${upM}د` : `${upM}د`;
    const tmpCount   = await fs.promises.readdir(TEMP_DIR).then((f) => f.length).catch(() => 0);
    const maintEmoji = isMaint === "1" ? "🔴 مفعّل" : "🟢 معطّل";
    const dlqAlert   = qStats.dlqSize >= 20 ? " ⚠️" : "";

    const dailyLine = today
      ? `📈 اليوم: *${today.searches}* بحث | *${today.downloads}* تحميل | نجاح *${today.successRate}*\n` +
        `⚡ الكاش: *${today.cacheHits}* | ⏱️ متوسط: *${today.avgMs}ms* | 👤 نشطون: *${today.activeUsers}*`
      : `_لا بيانات يومية_`;

    const msg =
      `🛠️ *لوحة الإدارة — خلاصة الكتب*\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `*📅 اليوم:*\n` +
      `${dailyLine}\n\n` +
      `*📊 الإجماليات:*\n` +
      `👥 المستخدمون: *${stats.totalUsers}* | ⭐ مميزون: *${pCount}*\n` +
      `🔍 بحث كلي: *${stats.totalSearches}* | 📥 تحميل كلي: *${stats.totalDownloads}*\n\n` +
      `*⚡ الكاش:*\n` +
      `📚 *${cacheStats.totalCached}* كتاب | خُدم *${cacheStats.totalServed}* مرة\n\n` +
      `*🔄 الطابور:*\n` +
      `⚡ High: *${qStats.highQueue}* | 📋 Normal: *${qStats.normalQueue}*\n` +
      `💀 DLQ: *${qStats.dlqSize}*${dlqAlert} | ⚙️ Workers: *${activeWorkerCount()}*\n\n` +
      `*🛡️ الأمان:*\n` +
      `🚫 Blacklist: *${bl.active}/${bl.total}* | محظورون: *${bCount}*\n\n` +
      `*💻 النظام:*\n` +
      `💾 Heap: *${memMB} MB* | ⏱️ Uptime: *${upStr}*\n` +
      `📁 Temp: *${tmpCount}* ملف | 🔧 صيانة: *${maintEmoji}*`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: buildAdminKeyboard(isMaint === "1"),
    });
  } catch (e) {
    L.error("admin", `sendAdminPanel error`, { err: String(e).slice(0, 200) });
    await bot.sendMessage(chatId, "❌ خطأ في جلب الإحصائيات");
  }
}

function buildAdminKeyboard(isMaint: boolean): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🔄 تحديث",            callback_data: "admin_refresh"      },
        { text: isMaint ? "✅ إنهاء صيانة" : "🔧 وضع صيانة", callback_data: "admin_toggle_maint" },
      ],
      [
        { text: "🏥 صحة البوت",        callback_data: "admin_health"       },
        { text: "📊 Analytics",         callback_data: "admin_analytics"    },
      ],
      [
        { text: "📢 إعلان",             callback_data: "admin_announce"     },
        { text: "📡 بث جماعي",          callback_data: "admin_broadcast"    },
      ],
      [
        { text: "📋 الطابور",           callback_data: "admin_queue"        },
        { text: "💀 فاشلة (DLQ)",      callback_data: "admin_dlq"          },
      ],
      [
        { text: "⭐ المميزون",          callback_data: "admin_premium"      },
        { text: "🚫 المحظورون",        callback_data: "admin_bans"         },
      ],
      [
        { text: "🔌 المصادر",           callback_data: "admin_sources"      },
        { text: "🧹 مسح Blacklist",     callback_data: "admin_clear_bl"    },
      ],
      [
        { text: "📚 أكثر الكتب",        callback_data: "admin_top_books"   },
        { text: "📤 تصدير CSV",         callback_data: "admin_export_csv"  },
      ],
      // BUG-B FIX: كان الـ fallback يُنتج http://localhost:5000/dashboard
      // Telegram يرفض أي URL بـ localhost/IP خاص في الأزرار: "Wrong HTTP URL"
      // الحل: اعرض الزر فقط إذا DASHBOARD_URL مضبوطة بـ URL عام صحيح
      ...(process.env.DASHBOARD_URL && process.env.DASHBOARD_URL.startsWith("http")
        ? [[{ text: "🌐 لوحة الويب (Dashboard)", url: process.env.DASHBOARD_URL }]]
        : []),
    ],
  };
}

// ══════════════════════════════════════════════
// CALLBACK DISPATCHER
// ══════════════════════════════════════════════

const pendingActions = new Map<string, { action: string; ts: number; message?: string }>();

// FIX-7: pendingActions كان يتراكم للأبد — entries قديمة لا تُنظَّف إلا لو جاء admin مجدداً
// نُضيف cleanup دورياً كل 10 دقائق يحذف أي entry أعمر من 5 دقائق
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [uid, entry] of pendingActions) {
    if (entry.ts < cutoff) pendingActions.delete(uid);
  }
}, 10 * 60 * 1000).unref(); // unref: لا يمنع Node من الخروج

export async function handleAdminCallback(
  bot: TelegramBot,
  chatId: number,
  userId: string,
  data: string,
  msgId?: number,
  queryId?: string   // BUG-1 FIX: query.id كان يُستخدم داخل هذه الدالة لكنه غير موجود في scope
                     // callbacks.ts تُمرره الآن صراحةً — يُستخدم فقط لـ answerCallbackQuery
): Promise<void> {
  L.adminAction(userId, data);

  switch (data) {

    case "admin_refresh":
      // FIX-v11-4: بدون invalidate كان الـ cache يُعيد نفس القيم لـ 30 ثانية حتى عند الضغط على "تحديث"
      invalidateTodayStatsCache();
      await sendAdminPanel(bot, chatId);
      break;

    case "admin_health":
      await sendHealthReport(bot, chatId);
      break;

    case "admin_analytics":
      await sendAnalyticsPanel(bot, chatId);
      break;

    case "admin_weekly":
      await sendWeeklyStats(bot, chatId);
      break;

    case "admin_source_health":
      await sendSourceHealth(bot, chatId);
      break;

    // ── Maintenance ──────────────────────────────
    case "admin_toggle_maint": {
      const current = await redis.get(MAINTENANCE_KEY).catch(() => null);
      if (current === "1") {
        await redis.del(MAINTENANCE_KEY);
        await bot.sendMessage(chatId, `✅ *تم إنهاء وضع الصيانة.* البوت يعمل الآن.`, { parse_mode: "Markdown" });
        L.info("admin", `Maintenance OFF`, { by: userId });
      } else {
        await redis.set(MAINTENANCE_KEY, "1");
        await bot.sendMessage(chatId, `🔧 *تم تفعيل وضع الصيانة.*\nالمستخدمون لن يتمكنوا من إرسال طلبات.`, { parse_mode: "Markdown" });
        L.info("admin", `Maintenance ON`, { by: userId });
      }
      break;
    }

    // ── Announce ─────────────────────────────────
    case "admin_announce": {
      const current = await redis.get(BOT_ANNOUNCE_KEY).catch(() => null);
      const curText = current ? `\n\n_الحالي:_\n${current}` : "\n\n_لا يوجد إعلان_";
      pendingActions.set(userId, { action: "set_announce", ts: Date.now() });
      await bot.sendMessage(
        chatId,
        `📢 *إعلان*${curText}\n\n---\nأرسل نص الإعلان الجديد، أو أرسل \`clear\` لحذفه.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "admin_cancel_action" }]] } }
      );
      break;
    }

    // ── Broadcast ────────────────────────────────
    case "admin_broadcast": {
      pendingActions.set(userId, { action: "broadcast", ts: Date.now() });
      await bot.sendMessage(
        chatId,
        `📡 *البث الجماعي*\n\nأرسل الرسالة التي تريد إرسالها لكل المستخدمين.\n⚠️ _ستظهر معاينة قبل الإرسال._`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "admin_cancel_action" }]] } }
      );
      break;
    }

    // ── Broadcast Confirm ─────────────────────────
    case "admin_broadcast_confirm": {
      const pendingBroadcast = pendingActions.get(userId);
      if (!pendingBroadcast || pendingBroadcast.action !== "broadcast_preview") {
        // BUG-1 FIX: كان يستخدم query.id المجهول — الآن queryId مُمرَّر كـ parameter
        if (queryId) await bot.answerCallbackQuery(queryId, { text: "انتهت صلاحية الجلسة — أعد المحاولة" }).catch(() => {});
        break;
      }
      const msgToSend = pendingBroadcast.message ?? "";
      pendingActions.delete(userId);
      if (queryId) await bot.answerCallbackQuery(queryId, { text: "جاري البث..." }).catch(() => {});
      await runBroadcast(bot, chatId, msgToSend);
      break;
    }

    case "admin_broadcast_cancel": {
      pendingActions.delete(userId);
      if (queryId) await bot.answerCallbackQuery(queryId, { text: "تم إلغاء البث." }).catch(() => {});
      await bot.sendMessage(chatId, "❌ *تم إلغاء البث الجماعي.*", { parse_mode: "Markdown" });
      break;
    }

    // ── Queue ────────────────────────────────────
    case "admin_queue": {
      const qs = await getQueueStats();
      await bot.sendMessage(
        chatId,
        `📋 *حالة الطابور:*\n\n⚡ High: *${qs.highQueue}*\n📋 Normal: *${qs.normalQueue}*\n💀 DLQ: *${qs.dlqSize}*\n⚙️ Workers نشطون: *${activeWorkerCount()}*`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: "🗑️ مسح الطابور", callback_data: "admin_clear_queue" },
           { text: "💀 عرض DLQ",      callback_data: "admin_dlq"         }],
          [{ text: "◀️ رجوع",         callback_data: "admin_refresh"     }],
        ]}},
      );
      break;
    }

    case "admin_clear_queue":
      await clearQueues();
      await bot.sendMessage(chatId, `✅ تم مسح الطابور.`);
      L.info("admin", `Queues cleared`, { by: userId });
      break;

    case "admin_dlq": {
      const jobs = await getDLQJobs(10);
      if (jobs.length === 0) { await bot.sendMessage(chatId, `✅ Dead Letter Queue فارغ.`); break; }
      let msg = `💀 *آخر الطلبات الفاشلة:*\n\n`;
      for (const j of jobs)
        msg += `• \`${j.userId}\` — _${escMd(j.bookName)}_\n  ❌ ${j.failReason?.slice(0, 60) || "unknown"}\n`;
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🗑️ مسح DLQ", callback_data: "admin_clear_dlq" }]] } });
      break;
    }

    case "admin_clear_dlq":
      await clearDLQ();
      await bot.sendMessage(chatId, `✅ تم مسح DLQ.`);
      break;

    // ── Premium ──────────────────────────────────
    case "admin_premium": {
      const list   = await listPremiumUsers();
      const pCount = list.length;
      await bot.sendMessage(
        chatId,
        `⭐ *المميزون (${pCount}):*\n\n` +
          (pCount > 0 ? list.slice(0, 20).map((id) => `• \`${id}\``).join("\n") : "_لا يوجد_") +
          `\n\n_/premium\\_add <id> — إضافة_\n_/premium\\_remove <id> — إزالة_\n_/set\\_limit <id> <n> — حد مخصص_\n_/note <id> <text> — ملاحظة_`,
        { parse_mode: "Markdown" }
      );
      break;
    }

    // ── Bans ─────────────────────────────────────
    case "admin_bans": {
      const list   = await bannedList();
      const banStr = list.length > 0 ? list.slice(0, 30).map((id) => `• \`${id}\``).join("\n") : "_لا يوجد_";
      await bot.sendMessage(
        chatId,
        `🚫 *المحظورون (${list.length}):*\n\n${banStr}\n\n_/ban <id>_ | _/unban <id>_`,
        { parse_mode: "Markdown" }
      );
      break;
    }

    // ── Sources — FIX BUG-18: كان redis.exists في for loop (N queries) → pipeline الآن ──
    case "admin_sources": {
      const pipe = redis.pipeline();
      for (const src of SOURCES) pipe.exists(`src:off:${src.domain}`);
      const offResults = (await pipe.exec()) as [Error | null, number][];

      const rows: TelegramBot.InlineKeyboardButton[][] = [];
      for (let i = 0; i < SOURCES.length; i++) {
        const src   = SOURCES[i];
        const isOff = offResults[i]?.[1] === 1;
        rows.push([{ text: `${isOff ? "🔴" : "🟢"} ${src.emoji} ${src.name}`, callback_data: `admin_src_toggle:${src.domain}` }]);
      }
      rows.push([{ text: "◀️ رجوع", callback_data: "admin_refresh" }]);
      await bot.sendMessage(chatId, `🔌 *إدارة المصادر:*\n\nاضغط لتفعيل/تعطيل.`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
      break;
    }

    case "admin_cancel_action":
      pendingActions.delete(userId);
      await bot.sendMessage(chatId, `✅ تم الإلغاء.`);
      break;

    case "admin_clear_bl": {
      const count = await clearBlacklist();
      await bot.sendMessage(chatId, `✅ تم مسح ${count} رابط من Blacklist.`);
      L.info("admin", `Blacklist cleared`, { by: userId, count });
      break;
    }

    case "admin_top_books":
      await buildTopBooksMessage(bot, chatId);
      break;

    case "admin_export_csv":
      await exportCSV(bot, chatId);
      break;

    default:
      if (data.startsWith("admin_src_toggle:")) {
        const domain = data.slice(17);
        const rKey   = `src:off:${domain}`;
        const isOff  = (await redis.exists(rKey)) === 1;
        if (isOff) {
          await redis.del(rKey);
          await bot.sendMessage(chatId, `✅ تم تفعيل \`${domain}\``, { parse_mode: "Markdown" });
        } else {
          await redis.set(rKey, "1");
          await bot.sendMessage(chatId, `🔴 تم تعطيل \`${domain}\``, { parse_mode: "Markdown" });
        }
        L.adminAction(userId, `src_toggle:${domain} → ${isOff ? "ON" : "OFF"}`);
        await handleAdminCallback(bot, chatId, userId, "admin_sources");
      }
  }
}

// ══════════════════════════════════════════════
// PENDING ACTION HANDLER (multi-step)
// ══════════════════════════════════════════════

export async function handleAdminPendingAction(
  bot: TelegramBot,
  chatId: number,
  userId: string,
  text: string
): Promise<boolean> {
  const pending = pendingActions.get(userId);
  if (!pending) return false;
  if (Date.now() - pending.ts > 5 * 60 * 1000) { pendingActions.delete(userId); return false; }

  pendingActions.delete(userId);

  if (pending.action === "set_announce") {
    if (text.toLowerCase() === "clear") {
      await redis.del(BOT_ANNOUNCE_KEY);
      await bot.sendMessage(chatId, `✅ تم حذف الإعلان.`);
      L.adminAction(userId, "announce:clear");
    } else {
      await redis.set(BOT_ANNOUNCE_KEY, text);
      await bot.sendMessage(chatId, `✅ تم تعيين الإعلان.\n\n📢 ${text}`);
      L.adminAction(userId, `announce:set (${text.slice(0, 40)})`);
    }
    return true;
  }

  if (pending.action === "broadcast") {
    // IMP-5 FIX: إضافة خطوة تأكيد قبل البث — لمنع الإرسال بالخطأ لكل المستخدمين
    // قبل: الرسالة تُرسَل فوراً بعد كتابتها → خطأ إملائي واحد = بث لآلاف المستخدمين
    // الآن: نعرض معاينة + أزرار تأكيد/إلغاء → Admin يراجع قبل الإرسال
    pendingActions.set(userId, { action: "broadcast_preview", message: text, ts: Date.now() });
    const userCount = await storage.getAllUserIds().then(ids => ids.length).catch(() => 0);
    await bot.sendMessage(
      chatId,
      `📋 *معاينة البث الجماعي*

` +
      `👥 سيُرسَل لـ *${userCount}* مستخدم

` +
      `─────────────────────
${text}
─────────────────────

` +
      `هل تريد إرسال هذه الرسالة؟`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[
          { text: "✅ تأكيد الإرسال",  callback_data: "admin_broadcast_confirm" },
          { text: "❌ إلغاء",            callback_data: "admin_broadcast_cancel"  },
        ]] },
      }
    );
    return true;
  }

  return false;
}

// FIX BUG-17: broadcast — زيادة الـ delay وإضافة معالجة خطأ 429 (rate limit)
// كان 50ms = ~20 رسالة/ثانية بدون أي retry على 429
async function runBroadcast(bot: TelegramBot, chatId: number, message: string): Promise<void> {
  L.info("admin", `Broadcast started`);
  try {
    const allUsers = await storage.getAllUserIds();
    let sent = 0, failed = 0;
    const statusMsg = await bot.sendMessage(chatId, `📡 *جاري البث...*\n\n0 / ${allUsers.length}`, { parse_mode: "Markdown" });

    for (let i = 0; i < allUsers.length; i++) {
      let retries = 0;
      while (retries < 3) {
        try {
          await bot.sendMessage(Number(allUsers[i]), `📢 *رسالة من الإدارة:*\n\n${message}`, { parse_mode: "Markdown" });
          sent++;
          break;
        } catch (err: any) {
          // 429: Too Many Requests — انتظر وأعد المحاولة
          if (err?.response?.statusCode === 429) {
            const retryAfter = (err.response?.body?.parameters?.retry_after ?? 5) * 1000;
            await sleep(retryAfter + 500);
            retries++;
          } else {
            // blocked / deactivated / other — لا فائدة من retry
            failed++;
            break;
          }
        }
      }
      if (retries >= 3) failed++;

      // تأخير 40ms بين كل رسالة (~25/ثانية — تحت حد Telegram البالغ 30/ثانية)
      await sleep(40);

      if ((i + 1) % 20 === 0) {
        await bot.editMessageText(`📡 *جاري البث...*\n\n✅ ${sent} | ❌ ${failed} / ${allUsers.length}`, {
          chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
        }).catch(() => {});
      }
    }

    await bot.editMessageText(
      `✅ *اكتمل البث!*\n\n✅ ${sent} | ❌ ${failed} | 📊 ${allUsers.length}`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
    ).catch(() => {});

    L.info("admin", `Broadcast done`, { sent, failed, total: allUsers.length });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ خطأ في البث: ${String(e).slice(0, 200)}`);
  }
}

// ══════════════════════════════════════════════
// SHARED HELPERS
// ══════════════════════════════════════════════

export async function buildTopBooksMessage(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const top    = await getTopBooks(10, new Date().toISOString().slice(0, 10));
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    let msg = `🏆 *أكثر الكتب طلباً اليوم*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n`;
    if (top.length === 0) {
      msg += `_لا طلبات بعد اليوم_\n\n_ابحث عن أي كتاب لتبدأ القائمة_`;
    } else {
      const maxCount = top[0]?.count || 1;
      top.forEach((b, i) => {
        const pct  = Math.round((b.count / maxCount) * 10);
        const bar  = "▰".repeat(Math.max(1, pct)) + "▱".repeat(Math.max(0, 10 - pct));
        msg += `${medals[i]} *${escMd(b.title.slice(0, 38))}*\n`;
        msg += `\`${bar}\` _${b.count} طلب_\n\n`;
      });
    }
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
  } catch {
    await bot.sendMessage(chatId, "❌ خطأ في جلب البيانات");
  }
}

// FIX BUG-19: كان يحمّل ALL recent searches ثم يفلتر في الذاكرة
// إذا كان للمستخدم تحميلات قديمة خارج النافذة المؤقتة لن تظهر له
// FIX-v11-3: حُذف duck-type check للـ getUserSearchHistory
// الدالة معرَّفة في interface IStorage وستُنفَّذ دائماً — التحقق الوقتي خطأ تصميم
export async function buildHistoryMessage(bot: TelegramBot, chatId: number, userId: string): Promise<void> {
  try {
    const userSearches = await storage.getUserSearchHistory(userId, 7).catch(() => [] as { query: string }[]);

    if (userSearches.length === 0) {
      await bot.sendMessage(chatId,
        `📚 *لم تحمّل أي كتاب بعد*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n_اكتب اسم أي كتاب تريده وسأبحث عنه فوراً_`,
        { parse_mode: "Markdown" });
      return;
    }
    const nums = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣"];
    let msg = `📚 *آخر كتبك*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n`;
    userSearches.forEach((s, i) => { msg += `${nums[i] ?? `${i+1}.`} ${escMd(s.query)}\n`; });
    msg += `\n_اكتب اسم أي كتاب لإعادة تحميله_`;
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
  } catch {
    await bot.sendMessage(chatId, "❌ خطأ في جلب السجل");
  }
}

// FIX BUG-20: CSV injection — أسماء الكتب التي تبدأ بـ = + - @ قد تُفعّل صيغ Excel
// الحل: نُحيط كل خلية بعلامات اقتباس مزدوجة ونُهرّب الاقتباسات الداخلية
function csvCell(value: string): string {
  // إذا كانت القيمة تبدأ بحرف يُفعّل Formula Injection في Excel — نُضيف مسافة
  const dangerous = /^[=+\-@\t\r]/.test(value);
  const sanitized = dangerous ? ` ${value}` : value;
  // نُحيط بعلامات اقتباس ونُضاعف أي اقتباسات داخلية
  return `"${sanitized.replace(/"/g, '""').replace(/\n/g, " ")}"`;
}

async function exportCSV(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const recent = await storage.getRecentSearches(1000);
    const counts = new Map<string, { sent: number; found: number }>();
    for (const s of recent) {
      const e = counts.get(s.query) || { sent: 0, found: 0 };
      if (s.pdfSent)   e.sent++;
      if (s.bookFound) e.found++;
      counts.set(s.query, e);
    }
    // FIX BUG-20: استخدام csvCell لتأمين كل خلية
    let csv = "الكتاب,مرات_الإرسال,مرات_الوجود\n";
    [...counts.entries()].sort((a, b) => b[1].sent - a[1].sent).forEach(([q, d]) => {
      csv += `${csvCell(q)},${d.sent},${d.found}\n`;
    });
    const buf = Buffer.from("\uFEFF" + csv, "utf8");
    await bot.sendDocument(
      chatId, buf,
      { caption: `📊 *إحصائيات الكتب* — ${counts.size} كتاب`, parse_mode: "Markdown" },
      { filename: `stats_${new Date().toISOString().slice(0, 10)}.csv`, contentType: "text/csv" }
    );
    L.adminAction(chatId.toString(), `CSV exported (${counts.size} books)`);
  } catch (e) {
    await bot.sendMessage(chatId, `❌ خطأ في التصدير: ${String(e).slice(0, 200)}`);
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { buildWelcome } from "./ui.js";
