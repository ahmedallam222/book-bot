import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { PREMIUM_STARS_PRICE, DAILY_LIMIT, PREMIUM_LIMIT } from "./config.js";
import { isAdmin } from "./guards.js";
import { getSession, deleteSession, storeRetryKey } from "./session.js";
import { blacklistUrlDirect } from "./blacklist.js";
import { storage } from "../storage.js";
import {
  buildWelcome, handleAdminCallback, buildHistoryMessage,
  buildTopBooksMessage, buildProfileMessage,
} from "./admin.js";
import { buildInviteMessage } from "./referral.js";
import { kbAfterFail, kbMain, kbNoResults } from "./keyboards.js";
import { buildPaidBookMessage } from "./ui.js";
import { handleBookRequest } from "./bookRequest.js";
import { invalidateRecentSearchesCache } from "./engine.js";
import { SOURCES } from "./sources.js";
import { cancelUserJobs, getQueueStats, getUserPendingCount } from "./queue.js";
import { isPremium, getUserDailyLimit, getPremiumExpiry } from "./userSettings.js";
import { handleWeeklyCommand } from "./weekly.js";
import { handleRandomGenreCallback } from "./random.js";
import { redis } from "./redis.js";
import { normalizeArabic, buildResetTime } from "./text.js";
// FIX: استيراد wishlist من module مستقل — لا global، لا dynamic import زائد
import {
  getWishlist, saveWishlist, buildWishlistMsg, buildWishlistKb, getWishlistMax,
} from "./wishlist.js";
import { handleSummaryCallback } from "./summaryHandler.js";
import { handleImageCallback } from "./imageGen.js";
import { claimDaily, RETENTION_TIPS } from "./retention.js";
import { getBookOfDay, buildBookOfDayMessage, kbBookOfDayAsync } from "./bookOfDay.js";
import { replyKeyboardMain } from "./replyKeyboard.js";
import { completeOnboarding } from "./onboarding.js";
import { sendPersonalWeekReport } from "./personalWeek.js";
import { buildLibraryMessage, kbLibrary, buildContinueMessage, kbContinue, libraryTitleAt, cycleLibStatus, statusBadge, exportLibraryText } from "./library.js";
import { togglePref, isPrefKey, buildPrefsMessage, kbPrefs, getAllPrefs } from "./notifPrefs.js";
import { answerMicro, skipMicro, buildMicroMessage } from "./microHabit.js";
import { voteClubBook } from "./groupClub.js";
import { buildShareCardMessage, buildShareCardHtml, kbShareCard } from "./shareCard.js";
import { sendPersonalMonthReport } from "./personalMonth.js";
import { buildCuratedMenuMessage, kbCuratedMenu, getCuratedList, buildCuratedListMessage, kbCuratedList, seriesAfter, buildSeriesMessage, kbSeries, buildCuratedMenuForUser, kbCuratedMenuForUser } from "./curated.js";
import { cycleStatus, statusLabel, getJourneyMap, journeySummary } from "./journey.js";
import { buildHelpMessage, kbHelp, kbAfterDaily, kbAfterProfile, buildSearchPrompt, buildImgPrompt } from "./copy.js";
import { pickFresh } from "./uiVariants.js";

// ══════════════════════════════════════════════
// CALLBACK HANDLER
// ══════════════════════════════════════════════

// dedup TTL: لو الـ callback handler crashed أو العملية اتعلّقت بأي سبب،
// الـ dedup key تيتمسح أوتوماتيكياً. فيا أغلب callbacks بتخلص في < 5واني،
// 30 ثانية غطاء أمان واسع. السابق (Set في الذاكرة) كان لو crashed
// وسط المعالجة الـ entry تفضل عالقة للأبد وتعمل dedup غلط للنقرات اللاحقة.
const CB_DEDUP_TTL_SEC = 30;
const cbDedupKey = (userId: string, data: string): string =>
  `cb:dedup:${userId}:${data.slice(0, 100)}`;

export function registerCallbackHandler(
  bot:             TelegramBot,
  token:           string,
  /**
   * اختياري للـ back-compat: لو ما اتمررت، الـ invite callback هـ يُظهر
   * رسالة fallback بدل رابط الإحالة. التمرير من index.ts.
   */
  getBotUsername?: () => string,
): void {
  // منع double-tap — نقر مرتين سريعاً. dedup بـ Redis (SET NX EX)
  // بدل in-memory Set — (أ) yields auto-cleanup عبر TTL لو الـ handler crashed
  // أو وسط معالجة، (ب) بيشتغل صح لو تشغيل عدة instances للبوت (لو حدث
  // لاحقاً)، (ج) ثابتة عبر restarts.

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    if (!chatId) return;
    const userId = String(query.from.id);
    const data   = query.data || "";

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
                       data.startsWith("sum:") || data.startsWith("sumd:")             ||
                       data.startsWith("img:");

    let acquiredDedup = false;
    if (needsDedup) {
      try {
        // SET key value NX EX ttl: يرجّع OK لو اتوضع، null لو في key موجود بالفعل
        const result = await redis.set(cbDedupKey(userId, data), "1", "EX", CB_DEDUP_TTL_SEC, "NX");
        acquiredDedup = result === "OK";
      } catch {
        // لو Redis باظ، نسمح بالمعالجة (fail-open) — أفضل من حجب كل callbacks
        acquiredDedup = true;
      }
      if (!acquiredDedup) {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        return;
      }
    }

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
      const entry = await getSession(sessionKey);
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
          await bot.editMessageText(buildWishlistMsg(list, false, 50, await getJourneyMap(userId), await journeySummary(userId, list)), {
            chat_id: chatId, message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: await buildWishlistKb(list, userId), // FIX-4: token محذوف — لم يكن مستخدماً
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
        await bot.editMessageText(buildWishlistMsg([], false, 50), {
          chat_id: chatId, message_id: query.message.message_id,
          parse_mode: "Markdown",
          reply_markup: await buildWishlistKb([], userId), // FIX-4: token محذوف
        }).catch(() => {});
      }
      return;
    }

    // ══════════════════════════════════════════════
    // BUG FIX: premium_buy و fp: محتاجين يعالَجوا قبل الـ general
    // answerCallbackQuery — وإلا فإن toast notifications الخاصة بيهم
    // ("⭐ أنت بالفعل مشترك" / "⏰ انتهت الجلسة") لن تظهر للمستخدم
    // لأن Telegram يرفض تكرار answerCallbackQuery على نفس query.
    // (نفس مبرر الـ wishlist callbacks فوق.)
    // ══════════════════════════════════════════════

    // ── premium_buy — Telegram Stars invoice ─────
    if (data === "premium_buy") {
      const prem = await isPremium(userId);
      if (prem) {
        await bot.answerCallbackQuery(query.id, { text: "⭐ أنت بالفعل مشترك في Premium!", show_alert: true }).catch(() => {});
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        await (bot as any).sendInvoice(
          chatId,
          "رفيق Premium ⭐",
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

    // ── legacy pagination on stale fail messages ──────────────
    // FIX-PAID-BOOK-MSG: السلوك القديم كان يعرض قائمة معاينة من كتب خطأ.
    // الـ handler الجديد يستبدل الرسالة القديمة بالرسالة القاطعة الموحَّدة
    // عشان المستخدم اللي رسالة فشل قديمة لسه ظاهرة على شاشته يحصل على
    // نفس الـ UX الجديد لما يضغط على زر التنقل.
    if (data.startsWith("fp:")) {
      const withoutPrefix = data.slice(3);
      const lastColon     = withoutPrefix.lastIndexOf(":");
      const sessionKey    = withoutPrefix.slice(0, lastColon);
      const entry         = await getSession(sessionKey);
      const bookName      = entry?.bookName || "";
      if (!bookName) {
        await bot.answerCallbackQuery(query.id, { text: "⏰ انتهت الجلسة." }).catch(() => {});
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      if (!query.message) return;
      await bot.editMessageText(buildPaidBookMessage(bookName), {
        chat_id: chatId, message_id: query.message.message_id,
        parse_mode: "Markdown", disable_web_page_preview: true,
        reply_markup: kbNoResults(bookName),
      }).catch(() => {});
      return;
    }

    // ── باقي الـ callbacks: General answer ────────
    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ── summary ───────────────────────────────────
    // The "📘 ملخص الكتاب" button under a delivered file. Heavy
    // path (Wikipedia + AI providers + Redis cache) lives in
    // summaryHandler.ts to keep this dispatcher slim.
    if (data.startsWith("sum:") || data.startsWith("sumd:")) {
      await handleSummaryCallback(bot, chatId, userId, data, query.id);
      return;
    }

    // ── image generation buttons (regenerate / variation / HD) ──
    if (data.startsWith("img:")) {
      await handleImageCallback(bot, chatId, userId, data, query.id);
      return;
    }

    // ── retry ─────────────────────────────────────
    if (data.startsWith("retry:")) {
      const sessionKey = data.slice(6).trim();
      const entry      = await getSession(sessionKey);
      if (!entry?.bookName) {
        await bot.sendMessage(chatId,
          `⏰ *انتهت صلاحية هذا الزر*\n\nاكتب اسم الكتاب من جديد وسأبحث عنه.`,
          { parse_mode: "Markdown" }).catch(() => {});
        return;
      }
      await handleBookRequest(bot, chatId, userId, entry.bookName, token, query.from.username);
      return;
    }

    // ── bad_file ──────────────────────────────────
    if (data.startsWith("bad_file:")) {
      const sessionKey = data.slice(9).trim();
      const entry      = await getSession(sessionKey);
      if (entry?.url) {
        await blacklistUrlDirect(entry.url);
        if (entry.bookName) {
          const cachedBook = await storage.getCachedBook(entry.bookName).catch(() => null);
          if (cachedBook) await storage.deleteCachedBook(cachedBook.id).catch(() => {});
          // الـ engine يكتب الـ search cache بـ canonicalizeForCache (sc:)؛
          // الـ del المباشر اللي كان هنا بيستخدم normalizeForCache ومش
          // بيطابق المفتاح لو الاستعلام الأصلي فيه كلمات حشو ("تحميل ...").
          // النداء على invalidateRecentSearchesCache يعتمد searchCacheKey
          // اللي يولّد المفتاح بنفس الطريقة فيمسحه فعلاً.
          invalidateRecentSearchesCache(entry.bookName);
          L.info("system", `Cache cleared for bad file`, { book: entry.bookName.slice(0, 50) });
        }
        await deleteSession(sessionKey);
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
      await bot.sendMessage(chatId, buildWishlistMsg(list, false, 50, await getJourneyMap(userId), await journeySummary(userId, list)), {
        parse_mode: "Markdown",
        reply_markup: await buildWishlistKb(list, userId), // FIX-4: token محذوف — لم يكن مستخدماً
      }).catch(() => {});
      return;
    }

    // ── switch ────────────────────────────────────

    // ── onboarding genre pick ──
    if (data === "onb_restart") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const { buildOnboardingMessage, kbOnboarding, buildTasteResetMessage } = await import("./onboarding.js");
        const name = query.from.first_name || "صديقي";
        await bot.sendMessage(
          chatId,
          buildTasteResetMessage() + "\n\nاختر مجالاً:",
          { parse_mode: "Markdown", reply_markup: kbOnboarding() },
        ).catch(() => {});
      } catch (e) {
        L.error("cb", "onb_restart failed", { err: String(e).slice(0, 80) });
      }
      return;
    }

    if (data.startsWith("onb:")) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      const genre = data.slice(4) || "skip";
      try {
        const res = await completeOnboarding(userId, genre === "skip" ? "skip" : genre);
        const text = res.text;
        const kb = res.kb;
        if (query.message?.message_id) {
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
            reply_markup: kb,
          }).catch(async () => {
            await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
          });
        } else {
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
        }
      } catch (e) {
        L.error("cb", "onb failed", { err: String(e).slice(0, 100) });
      }
      return;
    }

    // ── wishlist journey cycle ──
    if (data.startsWith("wlj:")) {
      const idx = parseInt(data.slice(4), 10);
      try {
        const list = await getWishlist(userId);
        if (!isNaN(idx) && idx >= 0 && idx < list.length) {
          const title = list[idx];
          const st = await cycleStatus(userId, title);
          await bot.answerCallbackQuery(query.id, {
            text: `${statusLabel(st)} — ${title.slice(0, 40)}`,
            show_alert: false,
          }).catch(() => {});
          // refresh wishlist view
          const prem = await isPremium(userId).catch(() => false);
          const maxSlots = await getWishlistMax(userId, prem);
          const journey = await getJourneyMap(userId);
          const summary = await journeySummary(userId, list);
          if (query.message?.message_id) {
            await bot.editMessageText(buildWishlistMsg(list, prem, maxSlots, journey, summary), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "Markdown",
              reply_markup: await buildWishlistKb(list, userId),
            }).catch(() => {});
          }
        }
      } catch (e) {
        L.error("cb", "wlj failed", { err: String(e).slice(0, 100) });
      }
      return;
    }



    // ── micro habit (كان import بلا handler — إصلاح) ──
    if (data === "micro_open") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const { text, kb } = buildMicroMessage();
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
      } catch (e) {
        L.error("cb", "micro_open failed", { err: String(e).slice(0, 80) });
      }
      return;
    }
    if (data === "micro:skip" || data.startsWith("micro:")) {
      try {
        if (data === "micro:skip" || data === "micro:skip:x") {
          const msg = await skipMicro(userId);
          await bot.answerCallbackQuery(query.id, { text: "حسناً" }).catch(() => {});
          if (query.message?.message_id) {
            await bot.editMessageText(msg, {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "Markdown",
            }).catch(async () => {
              await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(() => {});
            });
          }
          return;
        }
        const parts = data.split(":");
        const qid = parts[1] || "";
        const oid = parts[2] || "";
        const msg = await answerMicro(userId, qid, oid);
        await bot.answerCallbackQuery(query.id, { text: "+5" }).catch(() => {});
        if (query.message?.message_id) {
          await bot.editMessageText(msg, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
          }).catch(async () => {
            await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(() => {});
          });
        }
      } catch (e) {
        L.error("cb", "micro failed", { err: String(e).slice(0, 80) });
        await bot.answerCallbackQuery(query.id, { text: "تعذّر" }).catch(() => {});
      }
      return;
    }
    if (data === "lib_export") {
      try {
        const body = await exportLibraryText(userId, 30);
        await bot.sendMessage(chatId, body).catch(() => {});
        await bot.answerCallbackQuery(query.id, { text: "📋 أُرسلت القائمة" }).catch(() => {});
      } catch (e) {
        L.error("cb", "lib_export failed", { err: String(e).slice(0, 80) });
        await bot.answerCallbackQuery(query.id, { text: "تعذّر" }).catch(() => {});
      }
      return;
    }

    // ── library / curated ──
    if (data.startsWith("share:")) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const key = data.slice(6);
        const entry = await getSession(key);
        const title = entry?.bookName || "";
        if (!title) {
          await bot.sendMessage(chatId, "⏰ انتهت الجلسة.").catch(() => {});
          return;
        }
        const uname = getBotUsername?.() || "";
        const kb = kbShareCard(title);
        // Prefer HTML (robust); fall back to plain text if entity parse fails
        try {
          await bot.sendMessage(chatId, buildShareCardHtml(title, uname), {
            parse_mode: "HTML",
            reply_markup: kb,
            disable_web_page_preview: true,
          });
        } catch {
          await bot.sendMessage(chatId, buildShareCardMessage(title, uname), {
            reply_markup: kb,
            disable_web_page_preview: true,
          });
        }
      } catch (e) {
        L.error("cb", "share failed", { err: String(e).slice(0, 80) });
      }
      return;
    }
    if (data === "my_month") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try { await sendPersonalMonthReport(bot, chatId, userId); } catch { /* */ }
      return;
    }
    if (data === "prefs_menu") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const text = await buildPrefsMessage(userId);
        const prefs = await getAllPrefs(userId);
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kbPrefs(prefs) });
      } catch (e) {
        L.error("cb", "prefs_menu failed", { err: String(e).slice(0, 80) });
      }
      return;
    }
    
    
    if (data.startsWith("lib_done:")) {
      await bot.answerCallbackQuery(query.id, { text: "✅ أنهيتُه" }).catch(() => {});
      try {
        const key = data.slice("lib_done:".length);
        const entry = await getSession(key);
        const title = entry?.bookName || "";
        if (!title) {
          await bot.sendMessage(chatId, "⏰ انتهت الجلسة.").catch(() => {});
          return;
        }
        const { setLibStatus } = await import("./library.js");
        await setLibStatus(userId, title, "done");
        await bot.sendMessage(
          chatId,
          `✅ *أحسنت — سُجّل أنهيتُه*\n«${title.slice(0, 60)}»\n\n_مكتبتك: /library_`,
          { parse_mode: "Markdown" },
        ).catch(() => {});
      } catch (e) {
        L.error("cb", "lib_done failed", { err: String(e).slice(0, 80) });
      }
      return;
    }

if (data.startsWith("lib_reading:")) {
      await bot.answerCallbackQuery(query.id, { text: "📖 أقرؤه" }).catch(() => {});
      try {
        const key = data.slice("lib_reading:".length);
        const entry = await getSession(key);
        const title = entry?.bookName || "";
        if (!title) {
          await bot.sendMessage(chatId, "⏰ انتهت الجلسة — افتح مكتبتي.").catch(() => {});
          return;
        }
        const { setLibStatus } = await import("./library.js");
        await setLibStatus(userId, title, "reading");
        await bot.sendMessage(
          chatId,
          `📖 *سُجّل في مكتبتي: أقرؤه*\n«${title.slice(0, 60)}»\n\n_/library لعرض المكتبة_`,
          { parse_mode: "Markdown" },
        ).catch(() => {});
      } catch (e) {
        L.error("cb", "lib_reading failed", { err: String(e).slice(0, 80) });
      }
      return;
    }

    if (data === "my_history") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const { buildHistoryMessage } = await import("./admin.js");
        await buildHistoryMessage(bot, chatId, userId);
      } catch (e) {
        L.error("cb", "my_history failed", { err: String(e).slice(0, 80) });
      }
      return;
    }

if (data === "my_library") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const text = await buildLibraryMessage(userId);
        const kb = await kbLibrary(userId);
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
      } catch (e) {
        L.error("cb", "my_library failed", { err: String(e).slice(0, 100) });
      }
      return;
    }
    if (data === "lib_continue") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const { text, title } = await buildContinueMessage(userId);
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kbContinue(title) });
      } catch (e) {
        L.error("cb", "lib_continue failed", { err: String(e).slice(0, 100) });
      }
      return;
    }
    if (data.startsWith("libst:")) {
      const idx = parseInt(data.slice(6), 10);
      try {
        const title = await libraryTitleAt(userId, idx);
        if (title) {
          const st = await cycleLibStatus(userId, title);
          await bot.answerCallbackQuery(query.id, { text: statusBadge(st) }).catch(() => {});
          const text = await buildLibraryMessage(userId);
          const kb = await kbLibrary(userId);
          if (query.message?.message_id) {
            await bot.editMessageText(text, {
              chat_id: chatId, message_id: query.message.message_id,
              parse_mode: "Markdown", reply_markup: kb,
            }).catch(() => {});
          }
        } else {
          await bot.answerCallbackQuery(query.id).catch(() => {});
        }
      } catch (e) {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        L.error("cb", "libst failed", { err: String(e).slice(0, 100) });
      }
      return;
    }
    if (data === "curated_menu") {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      try {
        const { getPrimaryGenre } = await import("./interests.js");
        const g = await getPrimaryGenre(userId);
        await bot.sendMessage(chatId, buildCuratedMenuForUser(g), {
          parse_mode: "Markdown", reply_markup: kbCuratedMenuForUser(g),
        }).catch(() => {});
      } catch {
        await bot.sendMessage(chatId, buildCuratedMenuMessage(), {
          parse_mode: "Markdown", reply_markup: kbCuratedMenu(),
        }).catch(() => {});
      }
      return;
    }
    if (data.startsWith("clist:")) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      const id = data.slice(6);
      const list = getCuratedList(id);
      if (list) {
        await bot.sendMessage(chatId, buildCuratedListMessage(list), {
          parse_mode: "Markdown", reply_markup: kbCuratedList(list),
        }).catch(() => {});
      }
      return;
    }
    if (data.startsWith("series:")) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      const key = data.slice(7);
      try {
        const entry = await getSession(key);
        const bookName = entry?.bookName || "";
        const next = seriesAfter(bookName, 4);
        await bot.sendMessage(chatId, buildSeriesMessage(bookName || "كتابك", next), {
          parse_mode: "Markdown",
          reply_markup: kbSeries(next),
        }).catch(() => {});
      } catch (e) {
        L.error("cb", "series failed", { err: String(e).slice(0, 100) });
      }
      return;
    }

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
        await bot.sendMessage(chatId, `_الأزرار السفلية جاهزة._`, {
          parse_mode: "Markdown", reply_markup: replyKeyboardMain(),
        }).catch(() => {});
        break;
      }

      case "new_search":
        await bot.sendMessage(chatId, buildSearchPrompt(), {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🏠  الرئيسية", callback_data: "main_menu" }]] },
        });
        break;

      case "img_gen":
        await bot.sendMessage(chatId, buildImgPrompt(), {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🏠  الرئيسية", callback_data: "main_menu" }]] },
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
          `📊 *رصيدك اليوم*${premBadge}\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n${statBar}\n\n` +
          `📥 حمّلت اليوم:  *${dlCount}* كتاب\n${indicator} يتبقّى لك:  *${limit <= 0 ? "∞" : remaining}*${expiryLine}\n\n` +
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

      case "daily_quest": {
        const res = await claimDaily(userId);
        await bot.sendMessage(chatId, res.message, {
          parse_mode: "Markdown",
          reply_markup: kbAfterDaily(),
        }).catch(() => {});
        break;
      }

      case "my_profile": {
        const name = query.from.first_name || "صديقي";
        try {
          const text = await buildProfileMessage(userId, name);
          await bot.sendMessage(chatId, text, {
            parse_mode: "Markdown",
            reply_markup: kbAfterProfile(),
          });
        } catch (e) {
          L.error("cb", "my_profile error", { err: String(e).slice(0, 100) });
        }
        break;
      }

      case "invite_view": {
        // رابط الإحالة + تقدّم نحو المكافأة التالية
        const botUser = getBotUsername?.() || "";
        if (!botUser) {
          await bot.sendMessage(chatId, `⚠️ خطأ مؤقت في النظام، حاول بعد قليل.`, {
            reply_markup: { inline_keyboard: [[{ text: "🏠  القائمة", callback_data: "main_menu" }]] },
          }).catch(() => {});
          break;
        }
        try {
          const { text } = await buildInviteMessage(userId, botUser);
          await bot.sendMessage(chatId, text, {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [
                [{
                  text: "📤  مشاركة الرابط",
                  switch_inline_query: `🌿 جرّب رفيق — رفيقك لكتب عربية مجّانية\nhttps://t.me/${botUser}?start=ref_${userId}`,
                }],
                [{ text: "🏠  القائمة الرئيسية", callback_data: "main_menu" }],
              ],
            },
          });
        } catch (e) {
          L.error("cb", "invite_view error", { err: String(e).slice(0, 100) });
        }
        break;
      }

      case "my_week": {
        try {
          await sendPersonalWeekReport(bot, chatId, userId);
        } catch (e) {
          L.error("cb", "my_week failed", { err: String(e).slice(0, 100) });
        }
        break;
      }

      case "botd:go": {
        try {
          const { title } = await getBookOfDay();
          await bot.sendMessage(chatId,
            `📖 *كتاب اليوم:* «${title.slice(0, 80)}»\n_جارٍ البحث…_`,
            { parse_mode: "Markdown" }).catch(() => {});
          await handleBookRequest(bot, chatId, userId, title, token, query.from?.username);
        } catch (e) {
          L.error("cb", "botd:go failed", { err: String(e).slice(0, 100) });
        }
        break;
      }

      case "botd:show": {
        try {
          const body = await buildBookOfDayMessage();
          const kb = await kbBookOfDayAsync();
          await bot.sendMessage(chatId, body, { parse_mode: "Markdown", reply_markup: kb });
        } catch (e) {
          L.error("cb", "botd:show failed", { err: String(e).slice(0, 100) });
        }
        break;
      }

      case "help":
        await bot.sendMessage(chatId, buildHelpMessage(), {
          parse_mode: "Markdown",
          reply_markup: kbHelp(),
        }).catch(() => {});
        break;
    }

    } catch (e: any) {
      L.error("bot", "Unhandled error in callback handler", {
        userId, data: data.slice(0, 50),
        err: String(e?.message || e).slice(0, 200),
      });
      try { await bot.answerCallbackQuery(query.id, { text: "⚠️ خطأ مؤقت، حاول مرة أخرى" }).catch(() => {}); } catch {}
    } finally {
      if (acquiredDedup) {
        await redis.del(cbDedupKey(userId, data)).catch(() => {});
      }
    }
  });
}
