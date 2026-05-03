import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { BLACKLIST_THRESHOLD, PREMIUM_STARS_PRICE, DAILY_LIMIT, PREMIUM_LIMIT } from "./config.js";
import { isAdmin } from "./guards.js";
import { getSession, deleteSession, storeRetryKey } from "./session.js";
import { blacklistUrlDirect } from "./blacklist.js";
import { getSearchCacheResults } from "./engine.js";
import { storage } from "../storage.js";
import {
  buildWelcome, handleAdminCallback, buildHistoryMessage,
  buildTopBooksMessage,
} from "./admin.js";
import { kbAfterFail, kbMain, buildFailMessage } from "./keyboards.js";
import { handleBookRequest } from "./bookRequest.js";
import { SOURCES } from "./sources.js";
import { cancelUserJobs, getQueueStats, getUserPendingCount } from "./queue.js";
import { isPremium, getUserDailyLimit, getPremiumExpiry } from "./userSettings.js";
import { handleWeeklyCommand } from "./weekly.js";
import { handleRandomGenreCallback } from "./random.js";
import { redis } from "./redis.js";
import { normalizeForCache, normalizeArabic, buildResetTime } from "./text.js";
// FIX: استيراد wishlist من module مستقل — لا global، لا dynamic import زائد
import {
  getWishlist, saveWishlist, buildWishlistMsg, buildWishlistKb, getWishlistMax,
} from "./wishlist.js";
import { handleSummaryCallback } from "./summaryHandler.js";

// ══════════════════════════════════════════════
// CALLBACK HANDLER
// ══════════════════════════════════════════════

export function registerCallbackHandler(bot: TelegramBot, token: string): void {
  // منع double-tap — نقر مرتين سريعاً
  const processingCallbacks = new Set<string>();

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    if (!chatId) return;
    const userId = String(query.from.id);
    const data   = query.data || "";

    const dedupKey = `${userId}:${data}`;
    if (processingCallbacks.has(dedupKey)) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }
    const needsDedup = data.startsWith("retry:")         ||
                       data === "cancel_my_jobs"          ||
                       data === "main_menu"               ||
                       data === "my_stats"                ||
                       data === "my_queue"                ||
                       data.startsWith("bad_file:")       ||
                       data === "admin_broadcast_confirm" ||
                       data === "admin_broadcast_cancel"  ||
                       data.startsWith("rg:")             ||
                       data === "premium_buy"             ||
                       data === "wishlist_view"           ||
                       data === "wishlist_clear"          ||
                       data.startsWith("wishlist_add:")   ||
                       data.startsWith("wishlist_del:")   ||
                       data.startsWith("sum:");
    if (needsDedup) processingCallbacks.add(dedupKey);

    L.debug("bot", `Callback`, { userId, data: data.slice(0, 50) });
    try {

    // ── Admin callbacks ───────────────────────────
    if (data.startsWith("admin_") || data.startsWith("admin_src_toggle:")) {
      if (!isAdmin(userId)) {
        await bot.answerCallbackQuery(query.id, { text: "🚫 للمشرفين فقط.", show_alert: true }).catch(() => {});
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await handleAdminCallback(bot, chatId, userId, data, query.message?.message_id, query.id);
      return;
    }

    // ── cancel_my_jobs ────────────────────────────
    if (data === "cancel_my_jobs") {
      const cancelled = await cancelUserJobs(userId);
      await bot.answerCallbackQuery(query.id, {
        text: cancelled > 0 ? `✅ تم إلغاء ${cancelled} طلب` : "لا طلبات معلّقة",
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // ── queue_status ──────────────────────────────
    if (data === "queue_status") {
      const qs = await getQueueStats();
      await bot.answerCallbackQuery(query.id, {
        text: `⚡ High: ${qs.highQueue} | Normal: ${qs.normalQueue} | DLQ: ${qs.dlqSize}`,
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // ── noop ──────────────────────────────────────
    if (data === "noop") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    // ── weekly_refresh ────────────────────────────
    if (data === "weekly_refresh") {
      await bot.answerCallbackQuery(query.id, { text: "⏳ جاري التحديث..." }).catch(() => {});
      await handleWeeklyCommand(bot, chatId, userId, isAdmin(userId));
      return;
    }

    // ── weekly_export ─────────────────────────────
    if (data === "weekly_export") {
      if (!isAdmin(userId)) {
        await bot.answerCallbackQuery(query.id, { text: "🚫 للمشرفين فقط.", show_alert: true }).catch(() => {});
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await handleAdminCallback(bot, chatId, userId, "admin_export_csv", query.message?.message_id, query.id);
      return;
    }

    // ══════════════════════════════════════════════
    // BUG FIX: wishlist callbacks يجب معالجتها قبل
    // الـ general answerCallbackQuery — وإلا فإن
    // toast notifications (✅ تم الحفظ / 🗑️ حُذف)
    // لن تظهر للمستخدم لأن Telegram يرفض الـ second call
    // ══════════════════════════════════════════════

    // ── wishlist_add: ─────────────────────────────
    if (data.startsWith("wishlist_add:")) {
      const sessionKey = data.slice(13).trim();
      // FIX: getSession مستورد مباشرة أعلاه — لا dynamic import زائد
      const entry = getSession(sessionKey);
      if (!entry?.bookName) {
        await bot.answerCallbackQuery(query.id, { text: "⏰ انتهت صلاحية هذا الزر", show_alert: true }).catch(() => {});
        return;
      }
      const bookToAdd  = entry.bookName;
      const [list, maxSlots] = await Promise.all([
        getWishlist(userId),
        getWishlistMax(userId),
      ]);
      if (list.some((b: string) => normalizeArabic(b) === normalizeArabic(bookToAdd))) {
        await bot.answerCallbackQuery(query.id, { text: "✅ الكتاب موجود في قائمتك بالفعل" }).catch(() => {});
        return;
      }
      if (list.length >= maxSlots) {
        await bot.answerCallbackQuery(query.id, { text: `⚠️ القائمة ممتلئة (${maxSlots} كتاب)`, show_alert: true }).catch(() => {});
        return;
      }
      list.push(bookToAdd);
      await saveWishlist(userId, list);
      await bot.answerCallbackQuery(query.id, { text: `🔖 تم الحفظ! لديك ${list.length}/${maxSlots} كتاب` }).catch(() => {});
      return;
    }

    // ── wishlist_del: ─────────────────────────────
    if (data.startsWith("wishlist_del:")) {
      const idx  = parseInt(data.slice(13), 10);
      const list = await getWishlist(userId);
      if (!isNaN(idx) && idx >= 0 && idx < list.length) {
        const removed = list.splice(idx, 1)[0];
        await saveWishlist(userId, list);
        // Toast يؤكد الحذف — يظهر الآن بعد إصلاح الترتيب
        await bot.answerCallbackQuery(query.id, { text: `🗑️ حُذف: ${removed.slice(0, 30)}` }).catch(() => {});
        if (query.message?.message_id) {
          await bot.editMessageText(buildWishlistMsg(list), {
            chat_id: chatId, message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: buildWishlistKb(list), // FIX-4: token محذوف — لم يكن مستخدماً
          }).catch(() => {});
        }
      } else {
        await bot.answerCallbackQuery(query.id).catch(() => {});
      }
      return;
    }

    // ── wishlist_clear ────────────────────────────
    if (data === "wishlist_clear") {
      await saveWishlist(userId, []);
      // Toast يؤكد المسح — يظهر الآن بعد إصلاح الترتيب
      await bot.answerCallbackQuery(query.id, { text: "🗑️ تم مسح القائمة" }).catch(() => {});
      if (query.message?.message_id) {
        await bot.editMessageText(buildWishlistMsg([]), {
          chat_id: chatId, message_id: query.message.message_id,
          parse_mode: "Markdown",
          reply_markup: buildWishlistKb([]), // FIX-4: token محذوف
        }).catch(() => {});
      }
      return;
    }

    // ── باقي الـ callbacks: General answer ────────
    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ── premium_buy — Telegram Stars invoice ─────
    if (data === "premium_buy") {
      const prem = await isPremium(userId);
      if (prem) {
        await bot.answerCallbackQuery(query.id, { text: "⭐ أنت بالفعل مشترك في Premium!" }).catch(() => {});
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        await (bot as any).sendInvoice(
          chatId,
          "خلاصة الكتب Premium ⭐",
          `احصل على ${PREMIUM_LIMIT} تحميل يومياً بدلاً من ${DAILY_LIMIT} — لمدة 30 يوماً`,
          `premium:${userId}`,  // payload — يُستخدم عند successful_payment
          "",                   // provider_token — فارغ لـ Telegram Stars
          "XTR",                // عملة Stars
          [{ label: "اشتراك شهري", amount: PREMIUM_STARS_PRICE }]
        );
      } catch (e) {
        L.error("payment", "sendInvoice error", { err: String(e).slice(0, 100) });
        await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
      }
      return;
    }

    // ── summary ───────────────────────────────────
    // The "📘 ملخص الكتاب" button under a delivered file. Heavy
    // path (Wikipedia + AI providers + Redis cache) lives in
    // summaryHandler.ts to keep this dispatcher slim.
    if (data.startsWith("sum:")) {
      await handleSummaryCallback(bot, chatId, userId, data, query.id);
      return;
    }

    // ── retry ─────────────────────────────────────
    if (data.startsWith("retry:")) {
      const sessionKey = data.slice(6).trim();
      const entry      = getSession(sessionKey);
      if (!entry?.bookName) {
        await bot.sendMessage(chatId,
          `⏰ *انتهت صلاحية هذا الزر*\n\nاكتب اسم الكتاب من جديد وسأبحث عنه.`,
          { parse_mode: "Markdown" }).catch(() => {});
        return;
      }
      await handleBookRequest(bot, chatId, userId, entry.bookName, token, query.from.username);
      return;
    }

    // ── pagination ────────────────────────────────
    if (data.startsWith("fp:")) {
      const withoutPrefix = data.slice(3);
      const lastColon     = withoutPrefix.lastIndexOf(":");
      const sessionKey    = withoutPrefix.slice(0, lastColon);
      const page          = parseInt(withoutPrefix.slice(lastColon + 1) || "0", 10);
      const entry         = getSession(sessionKey);
      const bookName      = entry?.bookName || "";
      if (!bookName) {
        await bot.answerCallbackQuery(query.id, { text: "⏰ انتهت الجلسة." }).catch(() => {});
        return;
      }
      const results = await getSearchCacheResults(bookName);
      if (!query.message) return;
      if (results.length > 0) {
        await bot.editMessageText(buildFailMessage(bookName, results, page), {
          chat_id: chatId, message_id: query.message.message_id,
          parse_mode: "Markdown", disable_web_page_preview: true,
          reply_markup: kbAfterFail(bookName, results, page),
        }).catch(() => {});
      } else {
        await bot.editMessageText(
          `⏰ انتهت النتائج. اكتب اسم الكتاب مجدداً.`,
          { chat_id: chatId, message_id: query.message.message_id,
            reply_markup: { inline_keyboard: [[
              { text: "🔍 بحث جديد",  callback_data: "new_search" },
              { text: "🔄 أعد البحث", callback_data: `retry:${storeRetryKey(bookName)}` },
            ]]}}).catch(() => {});
      }
      return;
    }

    // ── bad_file ──────────────────────────────────
    if (data.startsWith("bad_file:")) {
      const sessionKey = data.slice(9).trim();
      const entry      = getSession(sessionKey);
      if (entry?.url) {
        await blacklistUrlDirect(entry.url, BLACKLIST_THRESHOLD);
        if (entry.bookName) {
          const cachedBook = await storage.getCachedBook(entry.bookName).catch(() => null);
          if (cachedBook) await storage.deleteCachedBook(cachedBook.id).catch(() => {});
          await redis.del(`sc:${normalizeForCache(entry.bookName)}`).catch(() => {});
          L.info("system", `Cache cleared for bad file`, { book: entry.bookName.slice(0, 50) });
        }
        deleteSession(sessionKey);
        L.warn("system", `Bad file reported`, { url: entry.url.slice(0, 80), userId });
        const badFileKb = entry.bookName ? {
          inline_keyboard: [[
            { text: "🔄 ابحث عن نسخة أخرى", callback_data: `retry:${storeRetryKey(entry.bookName)}` },
            { text: "🔍 كتاب جديد",          callback_data: "new_search" },
          ]],
        } : undefined;
        await bot.sendMessage(chatId,
          `✅ *شكراً على الإبلاغ!*\n_تم تجاهل هذا الرابط وحذفه من الأرشيف_\n\n_سيبحث البوت عن نسخة أفضل عند طلبه مجدداً_ 🔍`,
          { parse_mode: "Markdown", ...(badFileKb ? { reply_markup: badFileKb } : {}) }
        ).catch(() => {});
      } else {
        await bot.sendMessage(chatId, `⏰ انتهت صلاحية هذا الزر.`).catch(() => {});
      }
      return;
    }

    // ── random genre ──────────────────────────────
    if (data.startsWith("rg:")) {
      await handleRandomGenreCallback(bot, chatId, userId, token, query.from.username, data.slice(3));
      return;
    }

    // ── wishlist_view ─────────────────────────────
    // بعد الـ general answer — لا تحتاج toast خاص
    if (data === "wishlist_view") {
      const list = await getWishlist(userId);
      await bot.sendMessage(chatId, buildWishlistMsg(list), {
        parse_mode: "Markdown",
        reply_markup: buildWishlistKb(list), // FIX-4: token محذوف — لم يكن مستخدماً
      }).catch(() => {});
      return;
    }

    // ── switch ────────────────────────────────────
    switch (data) {
      case "main_menu": {
        const name = query.from.first_name || "صديقي";
        // BUG-FIX: getUserDailyLimit بتنده isPremium جواها. نمرّر prem.
        const prem  = await isPremium(userId);
        const [limit, dlRaw] = await Promise.all([
          getUserDailyLimit(userId, prem),
          storage.getDailyDownloadCount(userId).catch(() => 0),
        ]);
        const remaining = Math.max(0, limit - dlRaw);
        await bot.sendMessage(chatId, buildWelcome(name, remaining, limit, SOURCES.length, prem), {
          parse_mode: "Markdown", reply_markup: kbMain(),
        });
        break;
      }

      case "new_search":
        await bot.sendMessage(chatId,
          `🔍 *ابحث عن أي كتاب*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\nاكتب اسم الكتاب — أو اسم الكتاب + المؤلف لنتائج أدق`, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🏠  القائمة", callback_data: "main_menu" }]] },
        });
        break;

      case "my_stats": {
        // BUG-FIX: getUserDailyLimit و getPremiumExpiry تنادي Redis لـ manual flag → نجيب prem أولاً.
        const prem  = await isPremium(userId);
        const [limit, dlCount, expiry] = await Promise.all([
          getUserDailyLimit(userId, prem),
          storage.getDailyDownloadCount(userId).catch(() => 0),
          getPremiumExpiry(userId),
        ]);
        const remaining = Math.max(0, limit - dlCount);
        const premBadge = prem ? " ⭐ *مميّز*" : "";
        const expiryLine = prem
          ? expiry
            ? `\n📅 _ينتهي: ${expiry.toLocaleDateString("ar-EG", { day: "numeric", month: "long" })}_`
            : `\n♾️ _اشتراك دائم_`
          : "";
        const indicator = limit <= 0 ? "♾️" : remaining === 0 ? "⛔" : remaining <= 2 ? "🟡" : "🟢";
        let statBar: string;
        if (limit <= 0) {
          statBar = "`▰▰▰▰▰▰▰▰▰▰` ♾️";
        } else {
          const filled = Math.round((dlCount / Math.max(limit, 1)) * 10);
          statBar = "`" + "▰".repeat(Math.min(filled, 10)) + "▱".repeat(Math.max(0, 10 - filled)) + "`";
        }
        const statsKb: TelegramBot.InlineKeyboardMarkup = prem
          ? { inline_keyboard: [[{ text: "🏠  القائمة", callback_data: "main_menu" }]] }
          : {
              inline_keyboard: [
                [{ text: "⭐  ترقية للـ Premium", callback_data: "premium_buy" }],
                [{ text: "🏠  القائمة",            callback_data: "main_menu"   }],
              ],
            };
        await bot.sendMessage(chatId,
          `📊 *إحصائياتك*${premBadge}\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n${statBar}\n\n` +
          `📥 حمّلت اليوم:  *${dlCount}* كتاب\n${indicator} المتبقّي:  *${limit <= 0 ? "∞" : remaining}*${expiryLine}\n\n` +
          `_يتجدد بعد ${buildResetTime()}_ 🕐`,
          { parse_mode: "Markdown", reply_markup: statsKb }
        );
        break;
      }

      case "my_queue": {
        // FIX v29: يُظهر طلبات المستخدم الشخصية لا إحصاءات الطابور الكلية
        // سابقاً: getQueueStats() → المستخدم يرى أعداد الطابور الكامل (مُضلِّل!)
        // الآن: getUserPendingCount → عدد طلباته المعلقة تحديداً
        const userPending = await getUserPendingCount(userId);
        const qs          = await getQueueStats();
        const pendingText = userPending === 0
          ? "✅ لا طلبات معلقة لديك"
          : userPending === 1
          ? "📋 لديك طلب واحد قيد المعالجة"
          : `📋 لديك *${userPending}* طلبات قيد المعالجة`;
        await bot.sendMessage(chatId,
          `📋 *حالة طلباتك*\n\n${pendingText}\n\n_إجمالي الطابور: High ${qs.highQueue} · Normal ${qs.normalQueue}_`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[
            { text: "❌ إلغاء طلبي", callback_data: "cancel_my_jobs" },
            { text: "🏠 القائمة",    callback_data: "main_menu"       },
          ]]}}).catch(() => {});
        break;
      }

      case "my_history":   await buildHistoryMessage(bot, chatId, userId); break;
      case "top_books":    await buildTopBooksMessage(bot, chatId);        break;
      case "help":
        await bot.sendMessage(chatId,
          `❓ *كيف تستخدم البوت؟*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
          `*في المحادثة الخاصة:*\n◦ اكتب اسم أي كتاب مباشرةً\n◦ /search اسم الكتاب\n\n` +
          `*في المجموعات — ٣ طرق:*\n◦ بوت اسم الكتاب\n◦ bot اسم الكتاب\n◦ @اسم\\_البوت اسم الكتاب\n\n` +
          `*أوامر مفيدة:*\n/stats · /history · /top · /queue · /cancel · /last · /random · /weekly · /wishlist · /premium`,
          { parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [
              [{ text: "⭐  ترقية للـ Premium", callback_data: "premium_buy" }],
              [{ text: "🏠  القائمة",           callback_data: "main_menu"   }],
            ]},
          }
        );
        break;
    }

    } catch (e: any) {
      L.error("bot", "Unhandled error in callback handler", {
        userId, data: data.slice(0, 50),
        err: String(e?.message || e).slice(0, 200),
      });
      try { await bot.answerCallbackQuery(query.id, { text: "⚠️ خطأ مؤقت، حاول مرة أخرى" }).catch(() => {}); } catch {}
    } finally {
      if (needsDedup) processingCallbacks.delete(dedupKey);
    }
  });
}
