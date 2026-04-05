import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { BLACKLIST_THRESHOLD } from "./config.js";
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
import { cancelUserJobs, getQueueStats } from "./queue.js";
import { isPremium, getUserDailyLimit } from "./userSettings.js";
import { handleWeeklyCommand } from "./weekly.js";

// ══════════════════════════════════════════════
// CALLBACK HANDLER
// ══════════════════════════════════════════════

export function registerCallbackHandler(bot: TelegramBot, token: string): void {
  // FIX-1: منع double-tap — نقر مرتين سريعاً كان يُطلق طلبَين متزامنَين
  // نستخدم Set<string> بمفتاح userId:data — يُحذف بعد 3 ثوانٍ تلقائياً
  const processingCallbacks = new Set<string>();

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    if (!chatId) return;
    const userId = String(query.from.id);
    const data   = query.data || "";

    // Step 3 FIX: dedup key + cleanup في finally يضمن عدم التعلّق حتى لو رمى handler
    const dedupKey = `${userId}:${data}`;
    if (processingCallbacks.has(dedupKey)) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }
    const needsDedup = data.startsWith("retry:")        ||
                       data === "cancel_my_jobs"         ||
                       data === "main_menu"              ||
                       data === "my_stats"               ||
                       data === "my_queue"               ||
                       data.startsWith("wrong_file:")    ||
                       data.startsWith("bad_file:")      ||   // BUG FIX: منع double-report للرابط نفسه
                       data.startsWith("feedback:")      ||
                       // BUG-4 FIX: أزرار البث الجماعي لم تكن محمية من double-tap
                       // نقر مرتين على "تأكيد الإرسال" → بثّان متزامنان لكل المستخدمين
                       data === "admin_broadcast_confirm" ||
                       data === "admin_broadcast_cancel";
    if (needsDedup) processingCallbacks.add(dedupKey);

    L.debug("bot", `Callback`, { userId, data: data.slice(0, 50) });
    try {

    // FIX BUG-14: كان answerCallbackQuery يُستدعى مسبقاً بشكل عام (سطر 33)
    // ثم يُستدعى مرة ثانية بـ show_alert للـ admin/cancel/queue — الثانية دائماً تفشل
    // الحل: نُجيب على كل نوع callback بالطريقة المناسبة له فقط

    // ── Admin callbacks ───────────────────────────
    if (data.startsWith("admin_") || data.startsWith("admin_src_toggle:")) {
      if (!isAdmin(userId)) {
        // نُجيب بـ alert مباشرة — لم نُجب مسبقاً
        await bot.answerCallbackQuery(query.id, { text: "🚫 للمشرفين فقط.", show_alert: true }).catch(() => {});
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await handleAdminCallback(bot, chatId, userId, data, query.message?.message_id, query.id);
      return;
    }

    // ── cancel_my_jobs — نحتاج alert يُظهر النتيجة ────
    if (data === "cancel_my_jobs") {
      const cancelled = await cancelUserJobs(userId);
      // نُجيب بـ alert مباشرة (لم نُجب بعد)
      await bot.answerCallbackQuery(query.id, {
        text: cancelled > 0 ? `✅ تم إلغاء ${cancelled} طلب` : "لا طلبات معلّقة",
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // ── queue_status — نحتاج alert أيضاً ─────────────
    if (data === "queue_status") {
      const qs = await getQueueStats();
      await bot.answerCallbackQuery(query.id, {
        text: `⚡ High: ${qs.highQueue} | Normal: ${qs.normalQueue} | DLQ: ${qs.dlqSize}`,
        show_alert: true,
      }).catch(() => {});
      return;
    }

    // ── noop — زر للعرض فقط (مثل رقم الصفحة) ─────────────
    // FIX: كان يرجع بدون answerCallbackQuery → Telegram يُظهر spinner على الزر للأبد
    if (data === "noop") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    // ── weekly_refresh — يحتاج answerCallbackQuery قبل عملية ثقيلة ─────────
    // FIX: كان يُجاب مرتين — المرة الأولى بدون نص (السطر العام أعلاه)
    // ثم محاولة ثانية بالنص "جاري التحديث..." — الثانية تفشل دائماً صمتاً
    // الحل: نُعالجه قبل answerCallbackQuery العام ونُجيب بالنص الصحيح مرة واحدة
    if (data === "weekly_refresh") {
      await bot.answerCallbackQuery(query.id, { text: "⏳ جاري التحديث..." }).catch(() => {});
      await handleWeeklyCommand(bot, chatId, userId, isAdmin(userId));
      return;
    }

    // ── weekly_export — يحتاج show_alert → يجب معالجته قبل answerCallbackQuery العام ──
    // BUG-35 FIX: كان بعد السطر العام → query مُجاب مسبقاً → show_alert لا يظهر للمستخدم
    if (data === "weekly_export") {
      if (!isAdmin(userId)) {
        await bot.answerCallbackQuery(query.id, { text: "🚫 للمشرفين فقط.", show_alert: true }).catch(() => {});
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await handleAdminCallback(bot, chatId, userId, "admin_export_csv", query.message?.message_id, query.id);
      return;
    }

    // ── باقي الـ callbacks: نُجيب فوراً بدون alert ────
    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ── retry ─────────────────────────────────────
    if (data.startsWith("retry:")) {
      const sessionKey = data.slice(6).trim();
      const entry      = getSession(sessionKey);
      // BUG-11 FIX: لو الجلسة انتهت، كان يمرر الـ UUID كـ bookName → بحث بلا معنى
      // الحل: نُخبر المستخدم أن الزر انتهى ونطلب منه إعادة الكتابة
      if (!entry?.bookName) {
        await bot.sendMessage(chatId,
          `⏰ *انتهت صلاحية هذا الزر*

اكتب اسم الكتاب من جديد وسأبحث عنه.`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
        return;
      }
      await handleBookRequest(bot, chatId, userId, entry.bookName, token, query.from.username);
      return;
    }

    // ── pagination ────────────────────────────────
    // FIX BUG-15: data.split(":") ينكسر إذا كانت session key تحتوي على ":"
    // Format: "fp:<sessionKey>:<page>" — نستخدم lastIndexOf لفصل الـ page
    if (data.startsWith("fp:")) {
      const withoutPrefix = data.slice(3);                         // "<sessionKey>:<page>"
      const lastColon     = withoutPrefix.lastIndexOf(":");
      const sessionKey    = withoutPrefix.slice(0, lastColon);     // كل شيء قبل آخر ":"
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
            ]]}}
        ).catch(() => {});
      }
      return;
    }

    // ── bad_file ──────────────────────────────────
    if (data.startsWith("bad_file:")) {
      const sessionKey = data.slice(9).trim();
      const entry      = getSession(sessionKey);
      if (entry?.url) {
        // FIX BUG-16: كان يستدعي recordUrlFailure في loop بشكل متسلسل N مرة
        // الآن نستخدم blacklistUrlDirect لإضافة القيمة مباشرة في Redis بـ INCRBY
        await blacklistUrlDirect(entry.url, BLACKLIST_THRESHOLD);
        deleteSession(sessionKey);
        L.warn("system", `Bad file reported`, { url: entry.url.slice(0, 80), userId });
        await bot.sendMessage(chatId, `✅ شكراً! تم تجاهل هذا الرابط.`).catch(() => {});
      } else {
        await bot.sendMessage(chatId, `⏰ انتهت صلاحية هذا الزر.`).catch(() => {});
      }
      return;
    }

    // ── switch ────────────────────────────────────
    switch (data) {
      case "main_menu": {
        const name = query.from.first_name || "صديقي";
        // FIX-4: كانت 3 await متسلسلة — الآن بالتوازي
        const [prem, limit, dlRaw] = await Promise.all([
          isPremium(userId),
          getUserDailyLimit(userId),
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
        // FIX-4: كانت 3 await متسلسلة — الآن بالتوازي
        const [prem, limit, dlCount] = await Promise.all([
          isPremium(userId),
          getUserDailyLimit(userId),
          storage.getDailyDownloadCount(userId).catch(() => 0),
        ]);
        const remaining   = Math.max(0, limit - dlCount);
        const premBadge   = prem ? " ⭐ *مميّز*" : "";
        const indicator   = limit <= 0 ? "♾️" : remaining === 0 ? "⛔" : remaining <= 2 ? "🟡" : "🟢";
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
        break;
      }

      case "my_history":   await buildHistoryMessage(bot, chatId, userId);    break;
      case "top_books":    await buildTopBooksMessage(bot, chatId);            break;
      case "help":
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
          `/stats · /history · /top · /queue · /cancel`,
          { parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🏠  القائمة", callback_data: "main_menu" }]] } }
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
