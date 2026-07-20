import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { isAdmin, getLastBook, banUser, unbanUser } from "./guards.js";
import { handleBookRequest } from "./bookRequest.js";
import { react, reactRandom } from "./reactions.js";
import { REACTION_RECEIVED } from "./uiVariants.js";
import { handleRandomCommand } from "./random.js";
import { handleWeeklyCommand } from "./weekly.js";
import { handleImageCommand } from "./imageGen.js";
import { sendAdminPanel, handleAdminPendingAction } from "./admin.js";
import { runRetryPass, listPendingFailures } from "./failureRetry.js";
import { cancelUserJobs, getQueueStats } from "./queue.js";
import { kbMain } from "./keyboards.js";
import { buildWelcome } from "./admin.js";
import { SOURCES } from "./sources.js";
import { isPremium, getUserDailyLimit, setPremium, setUserDailyLimit, resetUserDailyLimit, setUserNote, clearUserNote, getPremiumExpiry } from "./userSettings.js";
import { storage } from "../storage.js";
import { escMd, normalizeArabic, buildResetTime } from "./text.js";
import { parseBookName, detectSummaryIntent } from "./bookNameParser.js";
import { parseChatIntent } from "./aiProviders/aiChatProvider.js";
import { claimDaily, getDailyQuest, getXpState, buildDailyStatusMessage, RETENTION_TIPS } from "./retention.js";
import { buildHelpMessage, kbHelp, kbAfterDaily } from "./copy.js";
import { tryHandleReplyKeyboard, replyKeyboardMain, withReplyKeyboard, replyKeyboardRemove, isUiChromeText, matchReplyKeyboardAction } from "./replyKeyboard.js";
import { shouldShowOnboarding, buildOnboardingMessage, kbOnboarding } from "./onboarding.js";
import { sendPersonalWeekReport } from "./personalWeek.js";
import { sendPersonalMonthReport } from "./personalMonth.js";
import { buildShareCardMessage, buildShareCardHtml, kbShareCard } from "./shareCard.js";
import { tryGroupSocialReply, sendGroupPlaybook } from "./groupInteract.js";
import { buildLibraryMessage, kbLibrary, buildContinueMessage, kbContinue } from "./library.js";
import { buildPrefsMessage, kbPrefs, getAllPrefs } from "./notifPrefs.js";
import { buildMicroMessage, hasAnsweredMicro } from "./microHabit.js";
import { buildCuratedMenuMessage, kbCuratedMenu, getCuratedList, buildCuratedListMessage, kbCuratedList } from "./curated.js";
import { buildGroupClubMessage, kbGroupClub, getGroupClubBook, maybePostWeeklyClub, kbClubWithVotes } from "./groupClub.js";
import { buildBookOfDayMessage, kbBookOfDayAsync } from "./bookOfDay.js";
import { pickFresh } from "./uiVariants.js";
import {
  allowGroupBookRequest, maybeSoftNotBookReply, maybeSendGroupWelcome,
  isFreeTextGroup,
  isFreeTextGroupLive,
} from "./groupPolicy.js";
import { lightNormalizeQuery } from "./queryNormalize.js";
import { applyLocalSpellingFixes } from "./aiProviders/smartBookQuery.js";
import { getDeliveryStats, formatDeliveryStatsArabic } from "./deliveryMetrics.js";
import { storeRetryKey } from "./session.js";
import {
  MAX_BOOK_NAME_LEN, GROUP_TRIGGER_WORDS, GROUP_FREE_TEXT_CHAT_IDS, MAINTENANCE_KEY, PREMIUM_STARS_PRICE, DAILY_LIMIT, PREMIUM_LIMIT,
} from "./config.js";
import { redis } from "./redis.js";
import { recordGroup } from "./groupTracker.js";
// FIX: wishlist module مستقل بدل global.__kholasaWishlist anti-pattern
import {
  getWishlist, saveWishlist,
  sendWishlist, getWishlistMax,
} from "./wishlist.js";
import { trackReferralOnStart, buildInviteMessage } from "./referral.js";
import { buildProfileMessage } from "./admin.js";

// ── safeCb ────────────────────────────────────
const CB_MAX_BYTES = 64;
function safeCb(data: string): string {
  if (Buffer.byteLength(data, "utf8") <= CB_MAX_BYTES) return data;
  let t = data;
  while (Buffer.byteLength(t, "utf8") > CB_MAX_BYTES) t = t.slice(0, -1);
  return t;
}

// ══════════════════════════════════════════════
// COMMANDS
// ══════════════════════════════════════════════

export function registerCommands(
  bot:            TelegramBot,
  token:          string,
  getBotUsername: () => string,
  getBotId:       () => number
): void {

  // ── /start ─────────────────────────────────────
  // يدعم deep-link payload للإحالة: /start ref_<userId>
  // الـ Telegram client بيمرّر الـ payload في text بعد مسافة (مش query string).
  bot.onText(/^\/start(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    const name   = msg.from?.first_name || "صديقي";
    if (!userId) return;

    // ── Referral tracking — قبل فحص الصيانة ──
    // ده عشان نسجّل الإحالة حتى لو البوت في صيانة (ما نخسرش الـ attribution).
    // الـ activation الفعلي بيحصل بس بعد أول تحميل ناجح في bookRequest.ts.
    const startPayload = match?.[1];
    if (startPayload) {
      const refMatch = startPayload.match(/^ref_(\d{5,15})$/);
      if (refMatch) {
        await trackReferralOnStart(userId, refMatch[1]).catch(() => {});
      }
    }

    // FIX v29: /start لم يكن يتحقق من وضع الصيانة — المستخدم يرى رسالة الترحيب
    // بينما البوت في صيانة → يبدأ يبحث عن كتب ويحصل على رسالة خطأ مربكة
    if (!isAdmin(userId)) {
      const maintenance = await redis.get(MAINTENANCE_KEY).catch(() => null);
      if (maintenance === "1") {
        await bot.sendMessage(chatId,
          `🔧 *رفيق في صيانة خفيفة حالياً*\n\nسنعود قريباً… شكراً لصبرك.`,
          { parse_mode: "Markdown" }).catch(() => {});
        return;
      }
    }
    // FIX (PR #103): تحديث user:lastSeen في /start كمان — الـ dashboard
    // broadcast targeting الـ active7 كان يفقد المستخدمين اللي يعملوا
    // /start من غير ما يكتبوا اسم كتاب أو يستخدموا /last.
    redis.zadd("user:lastSeen", Date.now(), userId).catch(() => {});
    try {
      // BUG-FIX: getUserDailyLimit بتنده isPremium جواها → كان بيتعمل مرتين. دلوقتي نمرّر prem.
      const prem  = await isPremium(userId);
      // أول ترحيب: redis flag NX — لو لسه ما اتعمل، نعرض الترحيب الموسّع
      // EXPIRE 90 يوم: لو رجع المستخدم بعد فترة طويلة يتعامل معاه كأنه جديد تاني
      const setRes = await redis.set(`welcomed:${userId}`, "1", "EX", 90 * 86400, "NX").catch(() => null);
      const isFirstTime = setRes === "OK";
      const [limit, dlRaw] = await Promise.all([
        getUserDailyLimit(userId, prem),
        storage.getDailyDownloadCount(userId).catch(() => 0),
      ]);
      const remaining = Math.max(0, limit - dlRaw);
      await bot.sendMessage(chatId, buildWelcome(name, remaining, limit, SOURCES.length, prem, isFirstTime),
        { parse_mode: "Markdown", reply_markup: replyKeyboardMain() });
      // قائمة inline إضافية للأفعال المتقدمة
      await bot.sendMessage(chatId,
        isFirstTime
          ? `👇 *اختصارات سريعة* — والأزرار السفلية دائماً معك.`
          : `👇 *القائمة السريعة*`,
        { parse_mode: "Markdown", reply_markup: kbMain() }).catch(() => {});
      if (isFirstTime) {
        react(bot, chatId, msg.message_id, "🎉").catch(() => {});
        // ترحيب ذوق — مرّة واحدة
        try {
          if (await shouldShowOnboarding(userId)) {
            await bot.sendMessage(
              chatId,
              buildOnboardingMessage(name),
              { parse_mode: "Markdown", reply_markup: kbOnboarding() },
            );
          }
        } catch { /* */ }
      } else {
        // مستخدم قديم لم يكمل onboarding
        try {
          if (await shouldShowOnboarding(userId)) {
            const shown = await redis.set(`ret:onb_nudge:${userId}`, "1", "EX", 14 * 86400, "NX");
            if (shown === "OK") {
              await bot.sendMessage(
                chatId,
                buildOnboardingMessage(name),
                { parse_mode: "Markdown", reply_markup: kbOnboarding() },
              ).catch(() => {});
            }
          }
        } catch { /* */ }
      }
    } catch (e) {
      L.error("cmd", "/start error", { err: String(e).slice(0, 100) });
      await bot.sendMessage(chatId,
        `🌿 *أهلاً! أنا رفيق*\n\nاكتب عنوان أي كتاب… وأبحث عنه بهدوء.`,
        { parse_mode: "Markdown", reply_markup: replyKeyboardMain() }).catch(() => {});
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
        { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    const bookName = sanitizeBookName(query);
    if (!bookName) return;
    if (!isAdmin(userId)) {
      const maintenance = await redis.get(MAINTENANCE_KEY).catch(() => null);
      if (maintenance === "1") {
        await bot.sendMessage(chatId, `🔧 *رفيق في صيانة خفيفة حالياً*\n\nسنعود قريباً… شكراً لصبرك.`,
          { parse_mode: "Markdown" }).catch(() => {});
        return;
      }
    }
    reactRandom(bot, chatId, msg.message_id, REACTION_RECEIVED).catch(() => {});
    redis.zadd("user:lastSeen", Date.now(), userId).catch(() => {});
    const wantsSummary = detectSummaryIntent(bookName);
    const parsedName = await parseBookName(bookName);
    await handleBookRequest(bot, chatId, userId, parsedName, token, username, msg.message_id, wantsSummary);
  });

  // ── /random ────────────────────────────────────
  bot.onText(/^\/random(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId   = msg.chat.id;
    const userId   = String(msg.from?.id || "");
    const username = msg.from?.username;
    if (!userId) return;
    const genreInput = (match?.[1] || "").trim();
    await handleRandomCommand(bot, chatId, userId, token, username, genreInput);
  });

  // ── /img ───────────────────────────────────────
  // توليد صورة عبر nano-banana endpoint. التفاصيل في imageGen.ts.
  bot.onText(/^\/img(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    const prompt = (match?.[1] || "").trim();
    await handleImageCommand(bot, chatId, userId, prompt, msg.message_id);
  });


  // ── /stats ─────────────────────────────────────
  bot.onText(/^\/stats$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      // BUG-FIX: getUserDailyLimit بتنده isPremium جواها. نمرّر prem تجنباً للتكرار.
      const prem  = await isPremium(userId);
      const [limit, dlCount] = await Promise.all([
        getUserDailyLimit(userId, prem),
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
      const statsKb: TelegramBot.InlineKeyboardMarkup = prem
        ? kbMain()
        : {
            inline_keyboard: [
              [{ text: "⭐  ترقية للـ Premium", callback_data: "premium_buy" }],
              [
                { text: "🔍  ابحث عن كتاب", callback_data: "new_search" },
                { text: "🏠  القائمة",       callback_data: "main_menu"  },
              ],
            ],
          };
      await bot.sendMessage(chatId,
        `📊 *رصيدك اليوم*${premBadge}\n━━━━━━━━━━━━━━━━\n\n${statBar}\n\n` +
        `📥 حمّلت اليوم: *${dlCount}*\n` +
        `${indicator} يتبقّى لك: *${limit <= 0 ? "∞" : remaining}* تحميل\n\n` +
        `_الرصيد يتجدد بعد ${buildResetTime()} (بتوقيت القاهرة)_`,
        { parse_mode: "Markdown", reply_markup: statsKb });
    } catch (e) {
      L.error("cmd", "/stats error", { err: String(e).slice(0, 100) });
      await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
    }
  });


  // ── /daily  /quest — retention daily loop ─────
  bot.onText(/^\/(?:daily|quest|مهمة|يومي|حضور)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      const res = await claimDaily(userId);
      await bot.sendMessage(chatId, res.message, {
        parse_mode: "Markdown",
        reply_markup: kbAfterDaily(),
      });
    } catch (e) {
      L.error("cmd", "/daily error", { err: String(e).slice(0, 100) });
    }
  });

  
  // ── /today — كتاب اليوم ─────────────────────
  bot.onText(/^\/(?:today|كتاب_اليوم|كتاب اليوم)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    try {
      const body = await buildBookOfDayMessage(userId || undefined);
      const kb = await kbBookOfDayAsync();
      await bot.sendMessage(chatId, body, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
    } catch (e) {
      L.error("cmd", "/today error", { err: String(e).slice(0, 100) });
    }
  });


  // ── /myweek — تقرير أسبوعي شخصي ────────────
  
  bot.onText(/^\/(?:mymonth|month|شهري|شهري)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      await sendPersonalMonthReport(bot, chatId, userId);
    } catch (e) {
      L.error("cmd", "/mymonth error", { err: String(e).slice(0, 80) });
    }
  });

  bot.onText(/^\/(?:share|مشاركة)(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    const q = (match?.[1] || "").trim();
    try {
      let title = q;
      if (!title) {
        const { getLastBook } = await import("./library.js");
        title = (await getLastBook(userId)) || "";
      }
      if (!title) {
        await bot.sendMessage(chatId, `📤 اكتب: \`/share عنوان الكتاب\` أو حمّل كتاباً أولاً.`, { parse_mode: "Markdown" });
        return;
      }
      const uname = getBotUsername();
      try {
        await bot.sendMessage(chatId, buildShareCardHtml(title, uname), {
          parse_mode: "HTML",
          reply_markup: kbShareCard(title),
          disable_web_page_preview: true,
        });
      } catch {
        await bot.sendMessage(chatId, buildShareCardMessage(title, uname), {
          reply_markup: kbShareCard(title),
          disable_web_page_preview: true,
        });
      }
    } catch (e) {
      L.error("cmd", "/share error", { err: String(e).slice(0, 80) });
    }
  });

  bot.onText(/^\/(?:myweek|weekme|أسبوعي|تقريري)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      await sendPersonalWeekReport(bot, chatId, userId);
    } catch (e) {
      L.error("cmd", "/myweek error", { err: String(e).slice(0, 100) });
    }
  });

  // ── /club — نادي المجموعة / كتاب النادي ─────
  
  bot.onText(/^\/(?:group|جروب|تفاعل)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await sendGroupPlaybook(bot, chatId);
    } catch (e) {
      L.error("cmd", "/group error", { err: String(e).slice(0, 80) });
    }
  });

  bot.onText(/^\/(?:club|نادي)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const text = await buildGroupClubMessage(chatId);
      const { title } = await getGroupClubBook(chatId);
      const alts = ["العادات الذرية", "الأمير الصغير", "فن اللامبالاة", "الرحيق المختوم"].filter((t) => t !== title);
      await bot.sendMessage(chatId, text + "\n\n_صوّت 👍 لكتاب النادي إن أحببت._", {
        parse_mode: "Markdown",
        reply_markup: kbClubWithVotes(title, alts),
      });
    } catch (e) {
      L.error("cmd", "/club error", { err: String(e).slice(0, 100) });
    }
  });

  // ── /profile ───────────────────────────────────
  // ملف المستخدم: streak + badges + إجمالي تحميلات + Premium status.
  // مكمّل لـ /stats (اللي بيركّز على الـ daily limit) — مش بديل.
  bot.onText(/^\/profile$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    const name   = msg.from?.first_name || "صديقي";
    if (!userId) return;
    try {
      const text = await buildProfileMessage(userId, name);
      await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: kbMain(),
      });
    } catch (e) {
      L.error("cmd", "/profile error", { err: String(e).slice(0, 100) });
      await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
    }
  });

  // ── /invite ────────────────────────────────────
  // رابط الإحالة + تقدّم نحو المكافأة التالية.
  bot.onText(/^\/invite$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      const botUser = getBotUsername() || "";
      if (!botUser) {
        await bot.sendMessage(chatId, `⚠️ خطأ مؤقت في النظام، حاول بعد قليل.`).catch(() => {});
        return;
      }
      const { text } = await buildInviteMessage(userId, botUser);
      await bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗  مشاركة الرابط", switch_inline_query: `🌿 جرّب رفيق — رفيقك لكتب عربية مجّانية\nhttps://t.me/${botUser}?start=ref_${userId}` }],
            [{ text: "🏠  القائمة الرئيسية", callback_data: "main_menu" }],
          ],
        },
      });
    } catch (e) {
      L.error("cmd", "/invite error", { err: String(e).slice(0, 100) });
      await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
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
      await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
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
      await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
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
      cancelled > 0 ? `✅ تم إلغاء *${cancelled}* طلب معلّق.` : `ℹ️ لا يوجد طلبات معلّقة حالياً.`,
      { parse_mode: "Markdown" }).catch(() => {});
  });

  // ── /queue ─────────────────────────────────────
  bot.onText(/^\/queue$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    const qs = await getQueueStats().catch(() => ({ highQueue: 0, normalQueue: 0, dlqSize: 0, totalActiveJobs: 0 }));
    await bot.sendMessage(chatId,
      `📋 *حالة الطابور*\n\n⚡ High: *${qs.highQueue}*\n📋 Normal: *${qs.normalQueue}*\n💀 DLQ: *${qs.dlqSize}*`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[
        { text: "❌ إلغاء طلبي", callback_data: "cancel_my_jobs" },
      ]]}}).catch(() => {});
  });

  // ── /last ──────────────────────────────────────
  bot.onText(/^\/last$/, async (msg) => {
    const chatId   = msg.chat.id;
    const userId   = String(msg.from?.id || "");
    const username = msg.from?.username;
    if (!userId) return;
    const lastBook = await getLastBook(userId);
    if (!lastBook) {
      await bot.sendMessage(chatId,
        `ℹ️ *لم تطلب أي كتاب بعد*\n\n_ابحث عن كتاب أولاً ثم استخدم /last لإعادة تحميله_ 📚`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[
          { text: "🔍 ابحث عن كتاب", callback_data: "new_search" },
          { text: "🎲 كتاب مفاجأة",  callback_data: "rg:any"    },
        ]]}}).catch(() => {});
      return;
    }
    await bot.sendMessage(chatId,
      `🔄 *إعادة تحميل:*\n_"${escMd(lastBook.slice(0,50))}"_`,
      { parse_mode: "Markdown" }).catch(() => {});
    reactRandom(bot, chatId, msg.message_id, REACTION_RECEIVED).catch(() => {});
    redis.zadd("user:lastSeen", Date.now(), userId).catch(() => {});
    await handleBookRequest(bot, chatId, userId, lastBook, token, username, msg.message_id);
  });

  // ── /wishlist ──────────────────────────────────
  // التخزين والعرض في wishlist.ts — لا global، لا circular imports
  bot.onText(/^\/wishlist(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;

    const input    = (match?.[1] || "").trim();
    const addMatch = input.match(/^(أضف|add|save)\s+(.+)/i);

    if (addMatch) {
      const bookToAdd          = addMatch[2].trim().slice(0, MAX_BOOK_NAME_LEN);
      const [list, maxSlots]   = await Promise.all([
        getWishlist(userId),
        getWishlistMax(userId),
      ]);
      if (list.some(b => normalizeArabic(b) === normalizeArabic(bookToAdd))) {
        await bot.sendMessage(chatId,
          `ℹ️ *"${escMd(bookToAdd.slice(0,50))}"* موجود بالفعل في قائمتك.`,
          { parse_mode: "Markdown" }).catch(() => {});
        return;
      }
      if (list.length >= maxSlots) {
        await bot.sendMessage(chatId,
          `⚠️ وصلت للحد الأقصى (${maxSlots} كتاب). احذف بعض الكتب أولاً.`,
          { parse_mode: "Markdown" }).catch(() => {});
        return;
      }
      list.push(bookToAdd);
      await saveWishlist(userId, list);
      await bot.sendMessage(chatId,
        `✅ تمت الإضافة: _"${escMd(bookToAdd.slice(0,50))}"_\n\nقائمتك تحتوي الآن على *${list.length}/${maxSlots}* كتاب.`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[
          { text: "📥 حمّله الآن", callback_data: safeCb(`retry:${storeRetryKey(bookToAdd)}`) },
          { text: "🔖 قائمتي",    callback_data: "wishlist_view" },
        ]]}}).catch(() => {});
      return;
    }

    await sendWishlist(bot, chatId, userId); // FIX-4: token محذوف
  });


  // ── /library /continue /lists /prefs /pulse ───
  bot.onText(/^\/(?:library|مكتبتي|lib)(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      const q = (match?.[1] || "").trim();
      const text = await buildLibraryMessage(userId, q || undefined);
      const kb = await kbLibrary(userId);
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
    } catch (e) {
      L.error("cmd", "/library error", { err: String(e).slice(0, 80) });
      await bot.sendMessage(chatId, "⚠️ تعذّر فتح المكتبة.").catch(() => {});
    }
  });

  bot.onText(/^\/(?:continue|أكمل|اكمل|resume)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      const { text, title } = await buildContinueMessage(userId);
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kbContinue(title) });
    } catch (e) {
      L.error("cmd", "/continue error", { err: String(e).slice(0, 80) });
    }
  });

  bot.onText(/^\/(?:lists|list|قوائم)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    try {
      const { getPrimaryGenre } = await import("./interests.js");
      const { buildCuratedMenuForUser, kbCuratedMenuForUser } = await import("./curated.js");
      const g = userId ? await getPrimaryGenre(userId) : null;
      await bot.sendMessage(chatId, buildCuratedMenuForUser(g), {
        parse_mode: "Markdown",
        reply_markup: kbCuratedMenuForUser(g),
      });
    } catch (e) {
      L.error("cmd", "/lists error", { err: String(e).slice(0, 80) });
      try {
        await bot.sendMessage(chatId, buildCuratedMenuMessage(), {
          parse_mode: "Markdown",
          reply_markup: kbCuratedMenu(),
        });
      } catch { /* */ }
    }
  });

  bot.onText(/^\/(?:prefs|notifications|إشعارات|اشعارات)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      const text = await buildPrefsMessage(userId);
      const prefs = await getAllPrefs(userId);
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kbPrefs(prefs) });
    } catch (e) {
      L.error("cmd", "/prefs error", { err: String(e).slice(0, 80) });
    }
  });

  bot.onText(/^\/(?:pulse|moment|لحظة|لحظتي|micro)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.from?.id) return;
    try {
      const { text, kb } = buildMicroMessage();
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
    } catch (e) {
      L.error("cmd", "/pulse error", { err: String(e).slice(0, 80) });
    }
  });



  bot.onText(/^\/(?:taste|ذوق|اهتمام|onboard)(?:@\w+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from?.first_name || "صديقي";
    try {
      const { buildTasteResetMessage, kbOnboarding } = await import("./onboarding.js");
      await bot.sendMessage(chatId, buildTasteResetMessage(), {
        parse_mode: "Markdown",
        reply_markup: kbOnboarding(),
      });
    } catch (e) {
      L.error("cmd", "/taste error", { err: String(e).slice(0, 80) });
    }
  });


  bot.onText(/^\/lang(?:@\w+)?(?:\s+(\w+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;
    try {
      const { setUserLocale, getUserLocale, isLocale, t, localeFromTelegram } = await import("./i18n.js");
      const arg = (match?.[1] || "").toLowerCase();
      if (arg && isLocale(arg)) {
        await setUserLocale(userId, arg);
        await bot.sendMessage(chatId, t(arg, arg === "en" ? "locale.set.en" : "locale.set.ar"));
        return;
      }
      // auto from telegram
      if (!arg && msg.from?.language_code) {
        const auto = localeFromTelegram(msg.from.language_code);
        await setUserLocale(userId, auto);
        await bot.sendMessage(chatId, t(auto, auto === "en" ? "locale.set.en" : "locale.set.ar") + "\n" + t(auto, "locale.hint"));
        return;
      }
      const cur = await getUserLocale(userId);
      await bot.sendMessage(chatId, t(cur, "locale.hint") + `\n(current: ${cur})`);
    } catch (e) {
      L.error("cmd", "/lang error", { err: String(e).slice(0, 80) });
    }
  });

  // ── /help ──────────────────────────────────────
  bot.onText(/^\/help$/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, buildHelpMessage(), {
      parse_mode: "Markdown",
      reply_markup: kbHelp(),
    }).catch(() => {});
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

  // ── /retry_failures ───────────────────────────
  // إدمن trigger يدوي لعامل auto-retry. يعرض عدد الفشل
  // المخزّن ثم يشغل pass جديد ويبعث counters للإدمن.
  bot.onText(/^\/retry_failures$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) {
      await bot.sendMessage(chatId, "🚫 للمشرفين فقط.").catch(() => {});
      return;
    }
    try {
      const pending = await listPendingFailures(100);
      const ack = await bot.sendMessage(
        chatId,
        `🔄 *إعادة محاولة الفشل...*\n\n` +
        `داخل الطابور: ${pending.length} فشل مخزّن\n` +
        `جارٍ تشغيل pass — ستعرف النتيجة خلال دقيقة أو اثنتين.`,
        { parse_mode: "Markdown" },
      );
      L.adminAction(userId, "trigger /retry_failures");
      const result = await runRetryPass(bot, token, { triggeredBy: "admin", limit: 50 });
      await bot.editMessageText(
        `🔄 *نتيجة إعادة المحاولة*\n\n` +
        `📊 المفحوص: *${result.scanned}*\n` +
        `✅ التسليم الناجح: *${result.delivered}*\n` +
        `🔁 المحاولة: *${result.attempted}*\n` +
        `⏳ في cooldown: *${result.cooldown}*\n` +
        `🗑 منتهٍ/محظور: *${result.expired}*\n` +
        `⚠️ أخطاء: *${result.errors}*`,
        {
          chat_id:    chatId,
          message_id: ack.message_id,
          parse_mode: "Markdown",
        },
      );
    } catch (e) {
      await bot.sendMessage(chatId, `❌ خطأ: \`${escMd(String(e).slice(0, 200))}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
  });

  // ══════════════════════════════════════════════
  // ADMIN TEXT COMMANDS
  // ══════════════════════════════════════════════

  function isValidId(id: string): boolean { return /^\d{5,15}$/.test(id); }

  bot.onText(/^\/ban\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id; const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) { await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {}); return; }
    await banUser(targetId); L.adminAction(userId, `ban ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم حظر \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
  });

  bot.onText(/^\/unban\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id; const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) { await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {}); return; }
    await unbanUser(targetId); L.adminAction(userId, `unban ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم رفع حظر \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
  });

  bot.onText(/^\/premium_add\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id; const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) { await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {}); return; }
    await setPremium(targetId, true, 0, { by: userId, source: "telegram-cmd" }); L.adminAction(userId, `grant premium ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم منح الـ Premium لـ \`${targetId}\` ⭐`, { parse_mode: "Markdown" }).catch(() => {});
  });

  bot.onText(/^\/premium_remove\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id; const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) { await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {}); return; }
    await setPremium(targetId, false, 0, { by: userId, source: "telegram-cmd" }); L.adminAction(userId, `revoke premium ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم إلغاء الـ Premium من \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
  });

  bot.onText(/^\/set_limit\s+(\S+)\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id; const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim(); const limitStr = (match?.[2] || "").trim();
    if (!isValidId(targetId)) { await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {}); return; }
    const limitN = parseInt(limitStr, 10);
    if (isNaN(limitN) || limitN < 0 || limitN > 10000) { await bot.sendMessage(chatId, `❌ حد غير صالح: \`${escMd(limitStr)}\``, { parse_mode: "Markdown" }).catch(() => {}); return; }
    await setUserDailyLimit(targetId, limitN); L.adminAction(userId, `set_limit ${targetId} → ${limitN}`);
    await bot.sendMessage(chatId, `✅ تم ضبط حد \`${targetId}\` على *${limitN}* كتاب/يوم`, { parse_mode: "Markdown" }).catch(() => {});
  });

  bot.onText(/^\/reset_limit\s+(\S+)/, async (msg, match) => {
    const chatId = msg.chat.id; const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim();
    if (!isValidId(targetId)) { await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {}); return; }
    await resetUserDailyLimit(targetId); L.adminAction(userId, `reset_limit ${targetId}`);
    await bot.sendMessage(chatId, `✅ تم إعادة الحد الافتراضي لـ \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
  });

  // FIX-WRONG-FILE (BUG-9): admin tool to remove a poisoned cache entry.
  // Usage: /purge_cache <book query>
  // The query is canonicalized the same way the cache write did, so any
  // wording variant the user reported as wrong will match the stored row.
  bot.onText(/^\/purge_cache\s+(.+)$/i, async (msg, match) => {
    const chatId = msg.chat.id; const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const query = (match?.[1] || "").trim();
    if (!query) {
      await bot.sendMessage(chatId, `❌ مثال: \`/purge_cache أرض زيكولا\``, { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    try {
      const removed = await storage.purgeCachedBookByQuery(query);
      L.adminAction(userId, `purge_cache "${query.slice(0, 50)}" → ${removed} row(s)`);
      const reply = removed > 0
        ? `🧹 تم حذف *${removed}* إدخال من الكاش لاستعلام:\n_${escMd(query)}_`
        : `ℹ️ لا توجد إدخالات في الكاش لاستعلام:\n_${escMd(query)}_`;
      await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" }).catch(() => {});
    } catch (e) {
      L.error("cmd", "/purge_cache failed", { err: String(e).slice(0, 120) });
      await bot.sendMessage(chatId, `❌ فشل: \`${escMd(String(e).slice(0, 60))}\``, { parse_mode: "Markdown" }).catch(() => {});
    }
  });

  bot.onText(/^\/note\s+(\S+)\s+(.+)$/, async (msg, match) => {
    const chatId = msg.chat.id; const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const targetId = (match?.[1] || "").trim(); const noteText = (match?.[2] || "").trim();
    if (!isValidId(targetId)) { await bot.sendMessage(chatId, `❌ ID غير صالح: \`${escMd(targetId)}\``, { parse_mode: "Markdown" }).catch(() => {}); return; }
    if (noteText.toLowerCase() === "clear") {
      await clearUserNote(targetId); L.adminAction(userId, `clear note ${targetId}`);
      await bot.sendMessage(chatId, `✅ تم حذف ملاحظة \`${targetId}\``, { parse_mode: "Markdown" }).catch(() => {});
    } else {
      await setUserNote(targetId, noteText); L.adminAction(userId, `set note ${targetId}: ${noteText.slice(0, 40)}`);
      await bot.sendMessage(chatId, `✅ تم حفظ ملاحظة \`${targetId}\`:\n_${escMd(noteText)}_`, { parse_mode: "Markdown" }).catch(() => {});
    }
  });


  // ── /premium ───────────────────────────────────
  bot.onText(/^\/premium$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id || "");
    if (!userId) return;

    const prem = await isPremium(userId);
    if (prem) {
      // BUG-FIX: نمرّر prem لـ getUserDailyLimit عشان ما يستدعي isPremium تاني.
      const [expiry, limit] = await Promise.all([
        getPremiumExpiry(userId),
        getUserDailyLimit(userId, prem),
      ]);
      let expiryLine: string;
      if (expiry) {
        const daysLeft = Math.max(0, Math.ceil((expiry.getTime() - Date.now()) / 86400000));
        const dateStr  = expiry.toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: "numeric" });
        const urgency  = daysLeft <= 3 ? "🟡" : daysLeft <= 7 ? "🟠" : "🟢";
        expiryLine = `${urgency} _ينتهي خلال *${daysLeft}* يوم_\n📅 _${dateStr}_`;
      } else {
        expiryLine = `♾️ _اشتراك دائم — ممنوح من الإدارة_`;
      }
      await bot.sendMessage(chatId,
        `⭐ *أنت مشترك في Premium!*\n` +
        `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n` +
        `📥 *${limit}* تحميل يومياً\n` +
        `⚡ أولوية قصوى في الطابور\n\n` +
        expiryLine,
        { parse_mode: "Markdown", reply_markup: kbMain() }
      ).catch(() => {});
      return;
    }

    await bot.sendMessage(chatId,
      `⭐ *رفيق Premium*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      `📥 *${DAILY_LIMIT} تحميل/يوم* مجاناً ← *${PREMIUM_LIMIT} تحميل/يوم*\n` +
      `⚡ أولوية في الطابور\n` +
      `🔄 تجديد تلقائي كل منتصف ليل\n\n` +
      `💫 *السعر: ${PREMIUM_STARS_PRICE} Stars شهرياً*\n\n` +
      `_اضغط الزرّ للدفع عبر Telegram Stars_ 👇`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: `⭐ اشترك بـ ${PREMIUM_STARS_PRICE} Stars`, callback_data: "premium_buy" }],
            [{ text: "🏠 القائمة", callback_data: "main_menu" }],
          ],
        },
      }
    ).catch(() => {});
  });

  // ── pre_checkout_query — يجب الرد خلال 10 ثوانٍ ─
  // Validate payload + currency + amount before approving. Without this
  // gate, a stale invoice from an older price tier (or a forged one with
  // a different `total_amount`) would be approved and downstream
  // `successful_payment` would still grant 30 days of Premium because the
  // grant code only checks `payload.startsWith("premium:")`. Reject upfront
  // so Telegram surfaces a clear error to the buyer instead.
  bot.on("pre_checkout_query", async (query) => {
    const userId  = String(query.from?.id || "");
    const payload = query.invoice_payload || "";
    const amount  = query.total_amount;
    const currency = query.currency;

    let approved = false;
    let reason   = "";

    if (!payload.startsWith("premium:")) {
      reason = `bad_payload=${payload.slice(0, 30)}`;
    } else if (currency !== "XTR") {
      reason = `bad_currency=${currency}`;
    } else if (amount !== PREMIUM_STARS_PRICE) {
      // expected exact match — Stars are integers, no fractional concerns
      reason = `bad_amount=${amount}|expected=${PREMIUM_STARS_PRICE}`;
    } else {
      approved = true;
    }

    try {
      await (bot as any).answerPreCheckoutQuery(query.id, approved, !approved ? {
        error_message: "هذه الفاتورة غير صالحة، أعد المحاولة من /premium",
      } : undefined);
      if (approved) {
        L.info("payment", "pre_checkout approved", {
          userId,
          amount,
          currency,
          payload: payload.slice(0, 40),
        });
      } else {
        L.warn("payment", "pre_checkout rejected", {
          userId,
          amount,
          currency,
          payload: payload.slice(0, 40),
          reason,
        });
        redis.incr("tel:payment:precheckout_rejected").catch(() => {});
      }
    } catch (e) {
      L.error("payment", "pre_checkout error", { err: String(e).slice(0, 100), userId });
    }
  });


  // Ops: delivery latency p50/p95
  bot.onText(/^\/ops_delivery(?:@\w+)?$/, async (msg) => {
    const userId = String(msg.from?.id || "");
    if (!isAdmin(userId)) return;
    const stats = await getDeliveryStats();
    await bot.sendMessage(msg.chat.id, formatDeliveryStatsArabic(stats), { parse_mode: "Markdown" }).catch(() => {});
  });


  // Welcome when bot is added to free-text groups
  bot.on("my_chat_member", async (upd) => {
    try {
      const chat = upd.chat;
      if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
      const ns = upd.new_chat_member?.status;
      if (ns === "member" || ns === "administrator") {
        await maybeSendGroupWelcome(bot, chat.id, true);
      }
    } catch (e) {
      L.warn("commands", "my_chat_member welcome failed", { err: String(e).slice(0, 80) });
    }
  });

} // ← إغلاق registerCommands

// ══════════════════════════════════════════════
// MESSAGE HANDLER
// ══════════════════════════════════════════════

export function registerMessageHandler(
  bot:            TelegramBot,
  token:          string,
  getBotUsername: () => string
): void {
  bot.on("message", async (msg) => {
    // ── Successful payment — يجب معالجته قبل فحص msg.text ──
    if (msg.successful_payment) {
      const userId   = String(msg.from?.id || "");
      const chatId   = msg.chat.id;
      const payload  = msg.successful_payment.invoice_payload || "";
      const chargeId = msg.successful_payment.telegram_payment_charge_id || "";
      if (payload.startsWith("premium:") && userId) {
        // Idempotency: NTBA polling offset is in-memory only — a bot
        // crash between handling a successful_payment and the next
        // poll round, a multi-instance race, or a Telegram-side retry
        // can redeliver the same update. Without dedup, setPremium
        // runs twice and grants 60 days for a single payment (TTL
        // extension semantics). Use Redis SET NX on the unique
        // telegram_payment_charge_id to grant only once. We still
        // send the success message in both cases so the user gets
        // confirmation if the original reply was lost.
        let alreadyProcessed = false;
        if (chargeId) {
          const dedupKey  = `payment:processed:${chargeId}`;
          // 90-day window — far longer than any reasonable retry. After
          // that the dedup key naturally expires; the chance of a real
          // 90-day-old replay is effectively zero.
          const acquired = await redis.set(
            dedupKey, String(Date.now()), "EX", 90 * 24 * 3600, "NX",
          ).catch(() => null);
          alreadyProcessed = acquired !== "OK";
        }

        if (!alreadyProcessed) {
          // 30 يوم اشتراك مدفوع — by نفس المستخدم لأن الدفع منه
          await setPremium(userId, true, 30, {
            by:     userId,
            source: "stars-payment",
            reason: `stars=${msg.successful_payment.total_amount} payload=${payload.slice(0, 40)} charge=${chargeId.slice(0, 24)}`,
          });
          L.info("payment", "Premium activated via Stars", {
            userId,
            stars:    msg.successful_payment.total_amount,
            chargeId: chargeId.slice(0, 24),
          });
        } else {
          L.warn("payment", "Duplicate successful_payment redelivered — premium NOT re-granted", {
            userId,
            chargeId: chargeId.slice(0, 24),
            stars:    msg.successful_payment.total_amount,
          });
          redis.incr("tel:payment:duplicate_redelivery").catch(() => {});
        }

        await bot.sendMessage(chatId,
          `🎉 *تم تفعيل Premium بنجاح!*\n\n` +
          `⭐ الآن لديك *${PREMIUM_LIMIT} تحميل يومياً*\n` +
          `⚡ وأولوية في الطابور\n\n` +
          `_شكراً لثقتك في رفيق_ 🙏`,
          { parse_mode: "Markdown", reply_markup: kbMain() }
        ).catch(() => {});
      }
      return;
    }

    if (!msg.text) return;
    const text    = msg.text.trim();
    const chatId  = msg.chat.id;
    const userId  = String(msg.from?.id || "");
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    if (!userId) return;

    // FIX: نسجّل المجموعة في الـ tracker لما نشوف رسالة فيه — بنستخدمه لإعلان
    // انتهاء الصيانة. fire-and-forget عشان ما يأخّرش الـ message handling.
    if (isGroup) {
      recordGroup(chatId, msg.chat.title || "").catch(() => {});
    }

    if (text.startsWith("/")) return;

    // أزرار الواجهة / اختصارات — في الخاص والجروب (لا تُفسَّر كعنوان كتاب)
    {
      const handledRk = await tryHandleReplyKeyboard(bot, msg, token, getBotUsername).catch(() => false);
      if (handledRk) return;
      if (isUiChromeText(text) || matchReplyKeyboardAction(text)) {
        // دفاع إضافي إن لم تُطابق لوحة الرد
        if (isGroup) {
          await bot.sendMessage(chatId, "🌿 _في الجروب اكتب عنوان الكتاب فقط._", {
            parse_mode: "Markdown",
            reply_markup: replyKeyboardRemove(),
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true,
          } as any).catch(() => {});
        }
        return;
      }
    }

    let bookName = "";
    if (isGroup) {
      const botUsername = getBotUsername().toLowerCase();
      const mention     = `@${botUsername}`;
      const lower       = text.toLowerCase();
      if (lower.startsWith(mention)) {
        bookName = text.slice(mention.length).trim();
      } else {
        const trigger = GROUP_TRIGGER_WORDS.find((w) => lower.startsWith(w.toLowerCase()));
        if (trigger) {
          bookName = text.slice(trigger.length).trim();
        } else if ((await isFreeTextGroupLive(chatId)) && looksLikeBookRequest(text) && !isUiChromeText(text)) {
          // Free-text: عنوان كتاب فقط — ليس دردشة ولا زر واجهة
          bookName = text;
          redis.incr("tel:group:free_text_hit").catch(() => {});
        }
      }
      // بعد الاستخراج: ارفض إن كان الناتج واجهة/دردشة
      if (bookName && (isUiChromeText(bookName) || !looksLikeBookRequest(bookName))) {
        bookName = "";
      }
      if (!bookName) {
        const social = await tryGroupSocialReply(bot, msg).catch(() => false);
        if (social) {
          // أزل لوحة عالقة إن وُجدت
          await bot.sendMessage(chatId, "\u200c", { reply_markup: replyKeyboardRemove() }).catch(() => {});
          return;
        }
        // Soft tip (rate-limited) so members learn free-text mode
        if (isFreeTextGroup(chatId) && text.length >= 2) {
          maybeSoftNotBookReply(bot, chatId, userId, msg.message_id).catch(() => {});
        }
        return;
      }
      const gate = await allowGroupBookRequest(chatId, userId);
      if (!gate.ok) {
        await bot.sendMessage(
          chatId,
          `⏳ *تمهل قليلاً* — وصلتَ لحد الطلبات في المجموعة.\nجرّب بعد ${Math.ceil(gate.retryAfterSec / 60)} دقائق.`,
          { parse_mode: "Markdown", reply_to_message_id: msg.message_id, allow_sending_without_reply: true } as any,
        ).catch(() => {});
        return;
      }
    } else {
      bookName = text;
    }

    bookName = sanitizeBookName(bookName);
    if (!bookName) return;

    if (isAdmin(userId)) {
      const handled = await handleAdminPendingAction(bot, chatId, userId, bookName).catch(() => false);
      if (handled) return;
    }

    const maintenance = await redis.get(MAINTENANCE_KEY).catch(() => null);
    if (maintenance === "1" && !isAdmin(userId)) {
      await bot.sendMessage(chatId, `🔧 *رفيق في صيانة خفيفة حالياً*\n\nسنعود قريباً… شكراً لصبرك.`,
        { parse_mode: "Markdown" }).catch(() => {});
      return;
    }

    // 👀 reaction فوري على رسالة المستخدم — يحس أن البوت "شاف" الطلب
    reactRandom(bot, chatId, msg.message_id, REACTION_RECEIVED).catch(() => {});

    // user:lastSeen — يستخدمها dashboard broadcast (target=active7)
    redis.zadd("user:lastSeen", Date.now(), userId).catch(() => {});

    // FIX-SPEED: skip AI chat-intent when the text already looks like a book
    // title. parseChatIntent was adding 1–8s (and Bynara timeouts) before
    // search even started on every request.
    let finalBookName: string;
    let finalWantsSummary: boolean;
    const summaryHint = detectSummaryIntent(bookName);
    const likelyBook =
      looksLikeBookRequest(bookName) &&
      bookName.split(/\s+/).length <= 12 &&
      !/^(?:ازيك|عامل|مرحبا|السلام)/i.test(bookName);

    if (likelyBook) {
      finalWantsSummary = summaryHint;
      finalBookName = await parseBookName(bookName);
      redis.incr("tel:intent:fast_path").catch(() => {});
    } else {
      const intent = await parseChatIntent(bookName);
      if (intent.isChat && intent.response) {
        await bot.sendMessage(chatId, intent.response, { parse_mode: "Markdown" }).catch(() => {});
        return;
      }
      finalBookName = intent.bookName || "";
      finalWantsSummary = !!intent.wantsSummary || summaryHint;
      if (!finalBookName || finalBookName.trim().length < 2) {
        finalBookName = await parseBookName(bookName);
      }
    }

    if (!finalBookName || finalBookName.trim().length < 2) return;
    finalBookName = lightNormalizeQuery(finalBookName) || finalBookName;
    finalBookName = applyLocalSpellingFixes(finalBookName) || finalBookName;

    bot.sendChatAction(chatId, "typing").catch(() => {});
    await handleBookRequest(bot, chatId, userId, finalBookName, token, msg.from?.username, msg.message_id, finalWantsSummary);
  });
}

// ── Helpers ───────────────────────────────────


/** True when free text in a group is likely a book title, not chat. */
function looksLikeBookRequest(input: string): boolean {
  const t = input.replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > 90) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/@\w+/.test(t) && t.startsWith("@")) return false;
  if (!/[\u0600-\u06FFa-zA-Z0-9]/.test(t)) return false;
  const letters = (t.match(/[\u0600-\u06FFa-zA-Z]/g) || []).length;
  if (letters < 2) return false;
  // UI chrome / keyboard labels — never a book title
  if (isUiChromeText(t)) return false;
  // chatty / social
  const chatty =
    /^(?:مرحبا|مرحباً|السلام\s*عليكم|سلام|هلا|أهلا|اهلا|صباح|مساء|شكرا|شكراً|يسلمو|تمام|اوك|أوك|طيب|هه+|هههه|لول|lol|ok|hi|hello|hey|bye|كيفك|عامل\s*ايه|اخبارك|مين|ايه|إيه|يعني|بجد|والله|يا\s*جماعة|جروب|القناة|ادمن|أدمن|البوت|بوت\??|help|مساعدة|تمام|ماشي|حاضر|يلا|يلاه|صباح\s*الخير|مساء\s*الخير|تصبحون|رمضان\s*كريم)(?:\s|[!?.…]*)$/i;
  if (chatty.test(t)) return false;
  // short conversational (1 word that is not a known book-like token)
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    // single word UI / slang
    if (/^(?:مفاجأة|مفاجاه|حضور|ملفي|قوائم|أسبوعي|شهري|سجل|مساعدة|ابحث|لحظة|المزيد|نعم|لا|اوك|أوك)$/i.test(words[0])) {
      return false;
    }
    // very short single tokens (< 3 letters) unlikely as book title alone
    if (letters < 3) return false;
  }
  const instructionStart =
    /^(?:ارسل|ابعت|ابعث|ود[يّ]|ارسال|ابعثلي|ارسلي|ابعتلي|اريد\s*منك|ممكن\s*تبعت|لو\s*سمحت\s*ابعت|هو\s*فين|فين\s*ال|مش\s*عارف|يعني\s*ايه)/i;
  if (instructionStart.test(t) && words.length >= 3) return false;
  if (/(?:وليس\s*رابط|مش\s*رابط|ملف\s*وليس|ابعت\s*لي|ارسل\s*لي)/i.test(t)) return false;
  // chatty multi-word without bookish structure
  if (words.length >= 4 && /(?:يعني|اصلا|أصلا|برضه|كمان|طيب|والله|بس|يعني\s*هو)/i.test(t) && !/(?:كتاب|رواية|تأليف|لـ|للكاتب)/i.test(t)) {
    return false;
  }
  if (words.length > 14) return false;
  if (/[؟?]{1}/.test(t) && words.length > 6) return false;
  return true;
}

function sanitizeBookName(input: string): string {
  const cleaned = input.replace(/\s+/g, " ").trim().slice(0, MAX_BOOK_NAME_LEN);
  if (cleaned.length < 2) return "";
  return cleaned;
}
