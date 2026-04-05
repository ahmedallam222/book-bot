import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { isAdmin, getLastBook, banUser, unbanUser } from "./guards.js";
import { handleBookRequest } from "./bookRequest.js";
import { handleRandomCommand } from "./random.js";
import { handleWeeklyCommand } from "./weekly.js";
import { sendAdminPanel, handleAdminPendingAction } from "./admin.js";
import { cancelUserJobs, getQueueStats } from "./queue.js";
import { kbMain } from "./keyboards.js";
import { buildWelcome } from "./admin.js";
import { SOURCES } from "./sources.js";
import { isPremium, getUserDailyLimit, setPremium, setUserDailyLimit, resetUserDailyLimit, setUserNote, clearUserNote } from "./userSettings.js";
import { storage } from "../storage.js";
import { escMd, normalizeArabic } from "./text.js";
import { parseBookName } from "./bookNameParser.js";
import {
  MAX_BOOK_NAME_LEN, GROUP_TRIGGER_WORDS, MAINTENANCE_KEY,
} from "./config.js";
import { redis } from "./redis.js";

// ══════════════════════════════════════════════
// COMMANDS — تسجيل كل الأوامر والرسائل
// ══════════════════════════════════════════════

export function registerCommands(
  bot:            TelegramBot,
  token:          string,
  getBotUsername: () => string,
  getBotId:       () => number
): void {

  // ── /start ─────────────────────────────────────
  bot.onText(/^\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    const name   = msg.from?.first_name || "صديقي";
    if (!userId) return;

    try {
      const [prem, limit, dlRaw] = await Promise.all([
        isPremium(userId),
        getUserDailyLimit(userId),
        storage.getDailyDownloadCount(userId).catch(() => 0),
      ]);
      const remaining = Math.max(0, limit - dlRaw);
      await bot.sendMessage(
        chatId,
        buildWelcome(name, remaining, limit, SOURCES.length, prem),
        { parse_mode: "Markdown", reply_markup: kbMain() }
      );
    } catch (e) {
      L.error("cmd", "/start error", { err: String(e).slice(0, 100) });
    }
  });

  // ── /search ────────────────────────────────────
  bot.onText(/^\/search(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId   = msg.chat.id;
    const userId   = String(msg.from?.id || "");
    const username = msg.from?.username;
    if (!userId) return;

    const query = (match?.[1] || "").trim();
    if (!query) {
      await bot.sendMessage(chatId,
        `🔍 *بحث عن كتاب*\n\nاكتب: \`/search اسم الكتاب\`\nمثال: \`/search الأمير الصغير\``,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    const bookName = sanitizeBookName(query);
    if (!bookName) return;

    // BUG-F FIX: كانت parseBookName() (تستدعي Mistral محتملاً) تُطلَق قبل فحص الصيانة.
    // نفس مشكلة BUG-2 في message handler — تم إصلاحها هناك لكن نُسي هنا.
    // خلال وضع الصيانة، كل /search يُبدد Mistral API credit بلا فائدة.
    // handleBookRequest ستمنع البحث فعلاً، لكن parseBookName ستُشغَّل أولاً.
    // الحل: فحص الصيانة من Redis أولاً — أرخص بكثير من Mistral call.
    if (!isAdmin(userId)) {
      const maintenance = await redis.get(MAINTENANCE_KEY).catch(() => null);
      if (maintenance === "1") {
        await bot.sendMessage(chatId,
          `🔧 *البوت في وضع الصيانة حالياً*\n\nسنعود قريباً! ⏳`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
        return;
      }
    }

    const parsedName = await parseBookName(bookName);
    await handleBookRequest(bot, chatId, userId, parsedName, token, username);
  });

  // ── /random ────────────────────────────────────
  bot.onText(/^\/random(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId   = msg.chat.id;
    const userId   = String(msg.from?.id || "");
    const username = msg.from?.username;
    if (!userId) return;

    const genreInput = (match?.[1] || "").trim();
    const lastBook   = getLastBook(userId);
    await handleRandomCommand(bot, chatId, userId, token, username, genreInput, lastBook);
  });

  // ── /stats ─────────────────────────────────────
  bot.onText(/^\/stats$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;

    try {
      const [prem, limit, dlCount] = await Promise.all([
        isPremium(userId),
        getUserDailyLimit(userId),
        storage.getDailyDownloadCount(userId).catch(() => 0),
      ]);
      const remaining = Math.max(0, limit - dlCount);
      const premBadge = prem ? " ⭐ *مميّز*" : "";
      const indicator = limit <= 0 ? "♾️" : remaining === 0 ? "⛔" : remaining <= 2 ? "🟡" : "🟢";
      let statBar: string;
      if (limit <= 0) {
        statBar = "`▰▰▰▰▰▰▰▰▰▰` ♾️";
      } else {
        const filled = Math.round((dlCount / Math.max(limit, 1)) * 10);
        statBar = "`" + "▰".repeat(Math.min(filled, 10)) + "▱".repeat(Math.max(0, 10 - filled)) + "`";
      }
      await bot.sendMessage(chatId,
        `📊 *إحصائياتك*${premBadge}\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
        `${statBar}\n\n` +
        `📥 حمّلت اليوم:  *${dlCount}* كتاب\n` +
        `${indicator} المتبقّي:  *${limit <= 0 ? "∞" : remaining}*\n\n` +
        `_يتجدد رصيدك كل منتصف ليل_ 🌙`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      L.error("cmd", "/stats error", { err: String(e).slice(0, 100) });
    }
  });

  // ── /history ───────────────────────────────────
  bot.onText(/^\/history$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      const { buildHistoryMessage } = await import("./admin.js");
      await buildHistoryMessage(bot, chatId, userId);
    } catch (e) {
      L.error("cmd", "/history error", { err: String(e).slice(0, 100) });
    }
  });

  // ── /top ───────────────────────────────────────
  bot.onText(/^\/top$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      const { buildTopBooksMessage } = await import("./admin.js");
      await buildTopBooksMessage(bot, chatId);
    } catch (e) {
      L.error("cmd", "/top error", { err: String(e).slice(0, 100) });
    }
  });

  // ── /weekly ────────────────────────────────────
  bot.onText(/^\/weekly$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    await handleWeeklyCommand(bot, chatId, userId, isAdmin(userId));
  });

  // ── /cancel ────────────────────────────────────
  bot.onText(/^\/cancel$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;

    const cancelled = await cancelUserJobs(userId).catch(() => 0);
    await bot.sendMessage(chatId,
      cancelled > 0
        ? `✅ تم إلغاء *${cancelled}* طلب معلّق.`
        : `ℹ️ لا يوجد طلبات معلّقة حالياً.`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  // ── /queue ─────────────────────────────────────
  bot.onText(/^\/queue$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;

    const qs = await getQueueStats().catch(() => ({ highQueue: 0, normalQueue: 0, dlqSize: 0, totalActiveJobs: 0 }));
    await bot.sendMessage(chatId,
      `📋 *حالة الطابور*\n\n` +
      `⚡ High: *${qs.highQueue}*\n` +
      `📋 Normal: *${qs.normalQueue}*\n` +
      `💀 DLQ: *${qs.dlqSize}*`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "❌ إلغاء طلبي", callback_data: "cancel_my_jobs" },
          ]],
        },
      }
    ).catch(() => {});
  });

  // ── /last ──────────────────────────────────────
  bot.onText(/^\/last$/, async (msg) => {
    const chatId   = msg.chat.id;
    const userId   = String(msg.from?.id || "");
    const username = msg.from?.username;
    if (!userId) return;

    const lastBook = getLastBook(userId);
    if (!lastBook) {
      await bot.sendMessage(chatId, `ℹ️ لم تطلب أي كتاب بعد.`).catch(() => {});
      return;
    }
    await handleBookRequest(bot, chatId, userId, lastBook, token, username);
  });

  // ── /help ──────────────────────────────────────
  bot.onText(/^\/help$/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId,
      `❓ *كيف تستخدم البوت؟*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      `*في المحادثة الخاصة:*\n` +
      `◦ اكتب اسم أي كتاب مباشرةً\n` +
      `◦ /search اسم الكتاب\n\n` +
      `*في المجموعات — ٣ طرق:*\n` +
      `◦ بوت اسم الكتاب\n` +
      `◦ bot اسم الكتاب\n` +
      `◦ @اسم_البوت اسم الكتاب\n\n` +
      `*أوامر مفيدة:*\n` +
      `/stats · /history · /top · /queue · /cancel · /last · /random`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🏠  القائمة", callback_data: "main_menu" }]] },
      }
    ).catch(() => {});
  });

  // ── /admin ─────────────────────────────────────
  bot.onText(/^\/admin$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, "🚫 للمشرفين فقط.").catch(() => {});
      return;
    }
    await sendAdminPanel(bot, chatId);
  });

  // ══════════════════════════════════════════════
  // ADMIN TEXT COMMANDS — أوامر الإدارة النصية
  // BUG-5 FIX: هذه الأوامر كانت تظهر في واجهة الأدمن لكنها لم تُسجَّل أبداً
  // → كل هذه الأوامر كانت تُتجاهل صمتاً عند الكتابة
  // ══════════════════════════════════════════════

  // مُساعد: يتحقق من أن الـ userId صالح رقمياً (Telegram IDs)
  function isValidId(id: string): boolean {
    return /^\d{5,12}$/.test(id);
  }

  // ── /ban <id> ──────────────────────────────────
  bot.onText(/^\/ban\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) {
      await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\`\n_يجب أن يكون رقماً بين 5-12 خانة_`, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    await banUser(targetId);
    L.adminAction(userId, `ban ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم حظر \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
  });

  // ── /unban <id> ────────────────────────────────
  bot.onText(/^\/unban\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) {
      await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    await unbanUser(targetId);
    L.adminAction(userId, `unban ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم رفع حظر \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
  });

  // ── /premium_add <id> ──────────────────────────
  bot.onText(/^\/premium_add\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) {
      await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    await setPremium(targetId, true);
    L.adminAction(userId, `grant premium ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم منح الـ Premium لـ \`${targetId}\` ⭐`, { parse_mode: "Markdown" }).catch(() => {});
  });

  // ── /premium_remove <id> ───────────────────────
  bot.onText(/^\/premium_remove\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) {
      await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    await setPremium(targetId, false);
    L.adminAction(userId, `revoke premium ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم إلغاء الـ Premium من \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
  });

  // ── /set_limit <id> <n> ────────────────────────
  bot.onText(/^\/set_limit\s+(\S+)\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    const limitStr = (match?.[2] || "").trim();
    if (!isValidId(targetId)) {
      await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    const limitN = parseInt(limitStr, 10);
    if (isNaN(limitN) || limitN < 0 || limitN > 10000) {
      await bot.sendMessage(chatId, `❌ حد غير صالح: \`${escMd(limitStr)}\`\n_يجب أن يكون رقماً بين 0 و 10000_`, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    await setUserDailyLimit(targetId, limitN);
    L.adminAction(userId, `set_limit ${targetId} → ${limitN}`);
    await bot.sendMessage(chatId, `✅ تم ضبط حد \`${targetId}\` على *${limitN}* كتاب/يوم`, { parse_mode: "Markdown" }).catch(() => {});
  });

  // ── /reset_limit <id> ──────────────────────────
  bot.onText(/^\/reset_limit\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) {
      await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    await resetUserDailyLimit(targetId);
    L.adminAction(userId, `reset_limit ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم إعادة الحد الافتراضي لـ \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
  });

  // ── /note <id> <text> ──────────────────────────
  bot.onText(/^\/note\s+(\S+)\s+(.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId  = (match?.[1] || "").trim();
    const noteText  = (match?.[2] || "").trim();
    if (!isValidId(targetId)) {
      await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    if (noteText.toLowerCase() === "clear") {
      await clearUserNote(targetId);
      L.adminAction(userId, `clear note ${targetId}`);
      await bot.sendMessage(chatId, `✅ تم حذف ملاحظة \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
    } else {
      await setUserNote(targetId, noteText);
      L.adminAction(userId, `set note ${targetId}: ${noteText.slice(0, 40)}`);
      await bot.sendMessage(chatId, `✅ تم حفظ ملاحظة \`${targetId}\`:\n_${escMd(noteText)}_`, { parse_mode: "Markdown" }).catch(() => {});
    }
  });

} // ← إغلاق registerCommands — BUG-7 FIX

// ══════════════════════════════════════════════
// MESSAGE HANDLER — رسائل نصية عادية
// ══════════════════════════════════════════════

export function registerMessageHandler(
  bot:            TelegramBot,
  token:          string,
  getBotUsername: () => string
): void {
  bot.on("message", async (msg) => {
    if (!msg.text) return;
    const text   = msg.text.trim();
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    if (!userId) return;

    // تجاهل الأوامر (تُعالَج بـ onText أعلاه)
    if (text.startsWith("/")) return;

    let bookName = "";

    if (isGroup) {
      // ── منطق المجموعة — يُنشَّط بكلمة تنبيه ──────
      const botUsername = getBotUsername().toLowerCase();
      const mention     = `@${botUsername}`;

      // نمط 1: @BotName اسم_الكتاب
      if (text.toLowerCase().startsWith(mention)) {
        bookName = text.slice(mention.length).trim();
      } else {
        // نمط 2: "بوت اسم_الكتاب" أو "bot اسم_الكتاب"
        const lower = text.toLowerCase();
        const trigger = GROUP_TRIGGER_WORDS.find((w) => lower.startsWith(w.toLowerCase()));
        if (trigger) {
          bookName = text.slice(trigger.length).trim();
        }
      }

      if (!bookName) return; // لا ذِكر للبوت في المجموعة → تجاهل
    } else {
      // ── محادثة خاصة — أي نص هو طلب بحث ──────────
      bookName = text;
    }

    bookName = sanitizeBookName(bookName);
    if (!bookName) return;

    // BUG-1 FIX: handleAdminPendingAction لم تكن مُستدعاة أبداً من message handler.
    // نتيجة: أوامر الأدمن متعددة الخطوات (إعلان/بث جماعي) كانت تُعامَل كطلبات بحث كتب!
    // الآن: لو الأدمن ينتظر إدخالاً متعدد الخطوات (broadcast/announce) → نعالجه ونُوقف.
    if (isAdmin(userId)) {
      const handled = await handleAdminPendingAction(bot, chatId, userId, bookName).catch(() => false);
      if (handled) return;
    }

    // BUG-2 FIX: كانت parseBookName() تُستدعى قبل فحص الصيانة.
    // نتيجة: كل رسالة خلال الصيانة تُطلق Mistral API call (هدر quota/تكلفة).
    // الحل: فحص الصيانة أولاً — لو نشط، نُوقف قبل أي API call خارجي.
    const maintenance = await redis.get(MAINTENANCE_KEY).catch(() => null);
    if (maintenance === "1" && !isAdmin(userId)) {
      await bot.sendMessage(chatId,
        `🔧 *البوت في وضع الصيانة حالياً*\n\nسنعود قريباً! ⏳`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    const parsedBookName = await parseBookName(bookName);

    await handleBookRequest(bot, chatId, userId, parsedBookName, token, msg.from?.username);
  });
}

// ── Helpers ───────────────────────────────────

function sanitizeBookName(input: string): string {
  const cleaned = input
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BOOK_NAME_LEN);
  // رفض النصوص القصيرة جداً (حرف أو حرفان فقط)
  if (cleaned.length < 2) return "";
  return cleaned;
}
