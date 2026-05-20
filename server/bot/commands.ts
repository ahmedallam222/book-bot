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
import { storeRetryKey } from "./session.js";
import {
  MAX_BOOK_NAME_LEN, GROUP_TRIGGER_WORDS, MAINTENANCE_KEY, PREMIUM_STARS_PRICE, DAILY_LIMIT, PREMIUM_LIMIT,
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
          `🔧 *البوت في وضع الصيانة حالياً*\n\nسنعود قريباً! ⏳`,
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
        { parse_mode: "Markdown", reply_markup: kbMain() });
      if (isFirstTime) {
        react(bot, chatId, msg.message_id, "🎉").catch(() => {});
      }
    } catch (e) {
      L.error("cmd", "/start error", { err: String(e).slice(0, 100) });
      await bot.sendMessage(chatId,
        `📚 *أهلاً! أنا بوت خلاصة الكتب*\n\nاكتب اسم أي كتاب وسأبحث عنه لك!`,
        { parse_mode: "Markdown", reply_markup: kbMain() }).catch(() => {});
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
        await bot.sendMessage(chatId, `🔧 *البوت في وضع الصيانة حالياً*\n\nسنعود قريباً! ⏳`,
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
        `📊 *إحصائياتك*${premBadge}\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n${statBar}\n\n` +
        `📥 حمّلت اليوم:  *${dlCount}* كتاب\n${indicator} المتبقّي:  *${limit <= 0 ? "∞" : remaining}*\n\n` +
        `_يتجدد بعد ${buildResetTime()}_ 🕐`,
        { parse_mode: "Markdown", reply_markup: statsKb });
    } catch (e) {
      L.error("cmd", "/stats error", { err: String(e).slice(0, 100) });
      await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
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
            [{ text: "🔗  مشاركة الرابط", switch_inline_query: `🎁 جرّب بوت خلاصة الكتب — كتب عربية مجانية!\nhttps://t.me/${botUser}?start=ref_${userId}` }],
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

  // ── /help ──────────────────────────────────────
  bot.onText(/^\/help$/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId,
      `❓ *دليل الاستخدام*\n` +
      `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n` +
      `📖 *البحث:*\n` +
      `◦ اكتب اسم الكتاب مباشرةً\n` +
      `◦ \`/search عنوان الكتاب\`\n` +
      `◦ \`/random\` — كتاب مفاجأة\n` +
      `◦ \`/random روايات\` — من تصنيف معيّن\n\n` +
      `📊 *حسابك:*\n` +
      `◦ \`/profile\` — ملفك الكامل + شاراتك 👤\n` +
      `◦ \`/stats\` — رصيدك اليومي\n` +
      `◦ \`/history\` — آخر بحث لك\n` +
      `◦ \`/last\` — أعِد تحميل آخر كتاب\n\n` +
      `🎨 *الإبداع:*\n` +
      `◦ \`/img <وصف>\` — ولّد صورة بالـ AI (5/يوم)\n\n` +
      `🎁 *الإحالات:*\n` +
      `◦ \`/invite\` — ادعُ صديقاً واحصل على Premium مجاني\n\n` +
      `🔖 *الإدارة:*\n` +
      `◦ \`/wishlist عنوان\` — أضف لقائمتك\n` +
      `◦ \`/wishlist\` — اعرض قائمتك\n` +
      `◦ \`/queue\` — حالة طلبك في الطابور\n` +
      `◦ \`/cancel\` — ألغِ طلبك الحالي\n\n` +
      `🌟 *الترتيبات:*\n` +
      `◦ \`/top\` — أكثر الكتب تحميلاً\n` +
      `◦ \`/weekly\` — تقرير الأسبوع\n` +
      `◦ \`/premium\` — الترقية لـ Premium\n\n` +
      `👥 *في المجموعات:* اكتب \`بوت\` ثم اسم الكتاب`,
      { parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [
          [{ text: "⭐  ترقية للـ Premium", callback_data: "premium_buy" }],
          [{ text: "🏠  القائمة",           callback_data: "main_menu"   }],
        ]},
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
      `⭐ *خلاصة الكتب Premium*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      `📥 *${DAILY_LIMIT} تحميل/يوم* مجاناً ← *${PREMIUM_LIMIT} تحميل/يوم*\n` +
      `⚡ أولوية في الطابور\n` +
      `🔄 تجديد تلقائي كل منتصف ليل\n\n` +
      `💫 *السعر: ${PREMIUM_STARS_PRICE} Stars شهرياً*\n\n` +
      `_اضغط الزر للدفع عبر Telegram Stars_ 👇`,
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
          `_شكراً لدعمك خلاصة الكتب_ 🙏`,
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

    // FIX: نسجّل الجروب في الـ tracker لما نشوف رسالة فيه — بنستخدمه لإعلان
    // انتهاء الصيانة. fire-and-forget عشان ما يأخّرش الـ message handling.
    if (isGroup) {
      recordGroup(chatId, msg.chat.title || "").catch(() => {});
    }

    if (text.startsWith("/")) return;

    let bookName = "";
    if (isGroup) {
      const botUsername = getBotUsername().toLowerCase();
      const mention     = `@${botUsername}`;
      if (text.toLowerCase().startsWith(mention)) {
        bookName = text.slice(mention.length).trim();
      } else {
        const lower   = text.toLowerCase();
        const trigger = GROUP_TRIGGER_WORDS.find((w) => lower.startsWith(w.toLowerCase()));
        if (trigger) bookName = text.slice(trigger.length).trim();
      }
      if (!bookName) return;
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
      await bot.sendMessage(chatId, `🔧 *البوت في وضع الصيانة حالياً*\n\nسنعود قريباً! ⏳`,
        { parse_mode: "Markdown" }).catch(() => {});
      return;
    }

    // 👀 reaction فوري على رسالة المستخدم — يحس أن البوت "شاف" الطلب
    reactRandom(bot, chatId, msg.message_id, REACTION_RECEIVED).catch(() => {});

    // user:lastSeen — يستخدمها dashboard broadcast (target=active7)
    redis.zadd("user:lastSeen", Date.now(), userId).catch(() => {});

    const wantsSummary = detectSummaryIntent(bookName);
    const parsedBookName = await parseBookName(bookName);
    await handleBookRequest(bot, chatId, userId, parsedBookName, token, msg.from?.username, msg.message_id, wantsSummary);
  });
}

// ── Helpers ───────────────────────────────────

function sanitizeBookName(input: string): string {
  const cleaned = input.replace(/\s+/g, " ").trim().slice(0, MAX_BOOK_NAME_LEN);
  if (cleaned.length < 2) return "";
  return cleaned;
}
