// ══════════════════════════════════════════════
// REPLY KEYBOARD — لوحة ثابتة أسفل الشات
//
// أزرار واضحة بالعربية الفصحى. تُعرض دائماً في الخاص،
// وتُعالَج قبل تفسير النص كعنوان كتاب.
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { BOT_NAME } from "./brand.js";
import { buildHelpMessage, kbHelp, kbAfterDaily, kbAfterProfile } from "./copy.js";
import { claimDaily } from "./retention.js";
import { buildProfileMessage, buildWelcome } from "./admin.js";
import { kbMain } from "./keyboards.js";
import { SOURCES } from "./sources.js";
import { isPremium, getUserDailyLimit } from "./userSettings.js";
import { storage } from "../storage.js";
import { handleRandomCommand } from "./random.js";
import {
  buildBookOfDayMessage,
  kbBookOfDay,
  getBookOfDay,
} from "./bookOfDay.js";
import { sendPersonalWeekReport } from "./personalWeek.js";
import { sendPersonalMonthReport } from "./personalMonth.js";
import { buildMicroMessage } from "./microHabit.js";
import { buildLibraryMessage, kbLibrary, buildContinueMessage, kbContinue } from "./library.js";
import { buildCuratedMenuMessage, kbCuratedMenu } from "./curated.js";
import { buildPrefsMessage, kbPrefs, getAllPrefs } from "./notifPrefs.js";
import { buildResetTime } from "./text.js";

/** نصوص الأزرار — تطابق تام مع ضغط المستخدم */
export const RK = {
  SEARCH:   "🔍 ابحث عن كتاب",
  RANDOM:   "🎲 كتاب مفاجأة",
  CHECKIN:  "✅ سجّل حضورك",
  PROFILE:  "👤 ملفي",
  TODAY:    "📖 كتاب اليوم",
  BALANCE:  "📊 رصيدي اليوم",
  HELP:     "❓ كيف أستخدم رفيق؟",
  MYWEEK:   "📊 أسبوعي",
  LIBRARY:  "📚 مكتبتي",
  LISTS:    "📖 قوائم",
  CONTINUE: "▶️ أكمل رحلتي",
  PREFS:    "🔔 إشعارات",
  PULSE:    "🕊 لحظة",
  MYMONTH:  "📅 شهري",
  HISTORY:  "📜 سجلّي",
  MENU:     "🏠 القائمة",
} as const;

const ALL_LABELS = new Set<string>(Object.values(RK));

export function isReplyKeyboardLabel(text: string): boolean {
  return ALL_LABELS.has(text.trim());
}

/**
 * لوحة مدمجة للخاص فقط (3 صفوف) — لا تملأ نصف الشاشة.
 * بقية الأوامر عبر «القائمة» (inline) أو /commands.
 */
export function replyKeyboardMain(): TelegramBot.ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: RK.SEARCH }, { text: RK.RANDOM }],
      [{ text: RK.CHECKIN }, { text: RK.LIBRARY }],
      [{ text: RK.MENU }, { text: RK.HELP }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "اكتب عنوان كتاب…",
  } as TelegramBot.ReplyKeyboardMarkup;
}

/** إخفاء لوحة الرد — للجروبات وأي سياق لا نريد فيه أزرار ثابتة */
export function replyKeyboardRemove(): TelegramBot.ReplyKeyboardRemove {
  return { remove_keyboard: true, selective: false } as TelegramBot.ReplyKeyboardRemove;
}

/**
 * هل النص من «واجهة» البوت (أزرار / اختصارات) وليس عنوان كتاب؟
 * يمنع: ضغط «مفاجأة» → بحث عن رواية اسمها مفاجأة.
 */
export function isUiChromeText(raw: string): boolean {
  const t = (raw || "").trim();
  if (!t) return false;
  if (ALL_LABELS.has(t)) return true;
  // بدون إيموجي
  const bare = t.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "").trim();
  const bareLabels = new Set(
    [...ALL_LABELS].map((s) => s.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "").trim()),
  );
  if (bareLabels.has(bare) || bareLabels.has(t)) return true;
  // كلمات واجهة شائعة (حتى لو كتبها المستخدم بدون الزر)
  const uiWord =
    /^(?:مفاجأة|مفاجاه|كتاب\s*مفاجأة|سج[ّل]\s*حضورك|حضور|ملفي|ملفي\s*الشخصي|رصيدي|رصيدي\s*اليوم|كتاب\s*اليوم|مكتبتي|قوائم|قائمه|أسبوعي|شهري|إشعارات|اشعارات|سجل[ّي]|القائمة|القائمه|كيف\s*أستخدم|مساعدة|ابحث|بحث|أكمل\s*رحلتي|لحظة|المزيد)$/i;
  if (uiWord.test(bare) || uiWord.test(t)) return true;
  return false;
}

/** معالجة أزرار الواجهة أيضاً في الجروب (بدون إظهار لوحة) */
export function matchReplyKeyboardAction(text: string): string | null {
  const t = (text || "").trim();
  if (!t) return null;
  if (ALL_LABELS.has(t)) return t;
  // map bare words → canonical RK label
  const map: Record<string, string> = {
    "مفاجأة": RK.RANDOM,
    "مفاجاه": RK.RANDOM,
    "كتاب مفاجأة": RK.RANDOM,
    "كتاب مفاجاه": RK.RANDOM,
    "سجّل حضورك": RK.CHECKIN,
    "سجل حضورك": RK.CHECKIN,
    "حضور": RK.CHECKIN,
    "ملفي": RK.PROFILE,
    "رصيدي": RK.BALANCE,
    "رصيدي اليوم": RK.BALANCE,
    "كتاب اليوم": RK.TODAY,
    "مكتبتي": RK.LIBRARY,
    "قوائم": RK.LISTS,
    "أسبوعي": RK.MYWEEK,
    "شهري": RK.MYMONTH,
    "إشعارات": RK.PREFS,
    "اشعارات": RK.PREFS,
    "سجلّي": RK.HISTORY,
    "سجلي": RK.HISTORY,
    "القائمة": RK.MENU,
    "القائمه": RK.MENU,
    "ابحث": RK.SEARCH,
    "ابحث عن كتاب": RK.SEARCH,
    "مساعدة": RK.HELP,
    "لحظة": RK.PULSE,
    "أكمل رحلتي": RK.CONTINUE,
  };
  const bare = t.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "").trim();
  return map[bare] || map[t] || (isUiChromeText(t) ? t : null);
}

export function searchPromptText(): string {
  return (
    `🔍 *ابحث عن كتاب*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `اكتب *عنوان الكتاب* في المحادثة الآن.\n\n` +
    `*أمثلة:*\n` +
    `◦ الأمير الصغير\n` +
    `◦ فنّ اللامبالاة\n` +
    `◦ مقدّمة ابن خلدون\n\n` +
    `💡 إن تشابه العنوان، أضف اسم المؤلّف.\n\n` +
    `_${BOT_NAME} يبحث ويرسل ملف PDF._`
  );
}

/**
 * يعالج ضغط زر من لوحة الرد.
 * @returns true إن عُولج الزر (لا يُفسَّر النص ككتاب)
 */
export async function tryHandleReplyKeyboard(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  token: string,
  getBotUsername: () => string,
): Promise<boolean> {
  const raw = (msg.text || "").trim();
  const matched = matchReplyKeyboardAction(raw);
  if (!matched && !isReplyKeyboardLabel(raw)) return false;
  const text = isReplyKeyboardLabel(raw) ? raw : (matched || raw);

  const isPrivate = msg.chat.type === "private";
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id || "");
  if (!userId) return true;

  // في الجروب: لا نعرض لوحة — وننفّذ فقط الأوامر الآمنة المختصرة أو نتجاهل كدردشة
  const kb = isPrivate ? replyKeyboardMain() : replyKeyboardRemove();

  // أزرار «خاصة» في الجروب → لا نبحث؛ نوجّه بلطف أو نتجاهل
  if (!isPrivate) {
    // معالجة محدودة في الجروب: random / club-like tips فقط
    if (text === RK.RANDOM || matchReplyKeyboardAction(raw) === RK.RANDOM) {
      await handleRandomCommand(bot, chatId, userId, token, msg.from?.username);
      // hide any sticky keyboard some clients show in group
      await bot.sendMessage(chatId, "_في الجروب: اكتب عنوان الكتاب مباشرةً — الأزرار للخاص فقط._", {
        parse_mode: "Markdown",
        reply_markup: replyKeyboardRemove(),
      }).catch(() => {});
      return true;
    }
    // أي زر واجهة آخر في الجروب = دردشة/واجهة — لا تبحث عن كتاب
    await bot.sendMessage(
      chatId,
      `🌿 هذا زرّ واجهة — في *الجروب* اكتب *عنوان الكتاب* فقط.\n` +
      `_للأزرار الكاملة راسلني في الخاص._`,
      { parse_mode: "Markdown", reply_markup: replyKeyboardRemove(),
        reply_to_message_id: msg.message_id, allow_sending_without_reply: true } as any,
    ).catch(() => {});
    return true;
  }

  switch (text) {
    case RK.SEARCH:
      await bot.sendMessage(chatId, searchPromptText(), {
        parse_mode: "Markdown",
        reply_markup: replyKeyboardMain(),
      }).catch(() => {});
      return true;

    case RK.RANDOM:
      await handleRandomCommand(bot, chatId, userId, token, msg.from?.username);
      return true;

    case RK.CHECKIN: {
      const res = await claimDaily(userId);
      await bot.sendMessage(chatId, res.message, {
        parse_mode: "Markdown",
        reply_markup: kbAfterDaily(),
      }).catch(() => {});
      try {
        const { redis } = await import("./redis.js");
        const nudged = await redis.set(`ret:pulse_nudge:${userId}`, "1", "EX", 3 * 86400, "NX");
        if (nudged === "OK" && res.message && !/سبق|مسجّل|سجّلت|Already/.test(res.message)) {
          const { text, kb } = buildMicroMessage();
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
        }
      } catch { /* non-fatal */ }
      return true;
    }

    case RK.PROFILE: {
      const name = msg.from?.first_name || "صديقي";
      try {
        const body = await buildProfileMessage(userId, name);
        await bot.sendMessage(chatId, body, {
          parse_mode: "Markdown",
          reply_markup: kbAfterProfile(),
        });
      } catch {
        await bot.sendMessage(chatId, "⚠️ تعذّر عرض الملف مؤقتاً.").catch(() => {});
      }
      return true;
    }

    case RK.TODAY: {
      const { getBookOfDayForUser } = await import("./bookOfDay.js");
      const { title } = await getBookOfDayForUser(userId);
      const body = await buildBookOfDayMessage(userId);
      await bot.sendMessage(chatId, body, {
        parse_mode: "Markdown",
        reply_markup: kbBookOfDay(title),
      }).catch(() => {});
      return true;
    }

    case RK.BALANCE: {
      const prem = await isPremium(userId);
      const [limit, dlCount] = await Promise.all([
        getUserDailyLimit(userId, prem),
        storage.getDailyDownloadCount(userId).catch(() => 0),
      ]);
      const remaining = Math.max(0, limit - dlCount);
      const premBadge = prem ? " ⭐" : "";
      const indicator = limit <= 0 ? "♾️" : remaining === 0 ? "⛔" : remaining <= 2 ? "🟡" : "🟢";
      await bot.sendMessage(
        chatId,
        `📊 *رصيدك اليوم*${premBadge}\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `📥 حمّلت اليوم: *${dlCount}*\n` +
        `${indicator} يتبقّى لك: *${limit <= 0 ? "∞" : remaining}* تحميل\n\n` +
        `_يتجدّد الرصيد بعد ${buildResetTime()} (بتوقيت القاهرة)_`,
        {
          parse_mode: "Markdown",
          reply_markup: replyKeyboardMain(),
        },
      ).catch(() => {});
      return true;
    }

    case RK.LIBRARY: {
      const text = await buildLibraryMessage(userId);
      const kb = await kbLibrary(userId);
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
      return true;
    }
    case RK.CONTINUE: {
      const { text, title } = await buildContinueMessage(userId);
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kbContinue(title) });
      return true;
    }
    case RK.LISTS: {
      try {
        const { getPrimaryGenre } = await import("./interests.js");
        const { buildCuratedMenuForUser, kbCuratedMenuForUser } = await import("./curated.js");
        const g = await getPrimaryGenre(userId);
        await bot.sendMessage(chatId, buildCuratedMenuForUser(g), {
          parse_mode: "Markdown", reply_markup: kbCuratedMenuForUser(g),
        });
      } catch {
        await bot.sendMessage(chatId, buildCuratedMenuMessage(), {
          parse_mode: "Markdown", reply_markup: kbCuratedMenu(),
        });
      }
      return true;
    }

    case RK.MYWEEK:
      await sendPersonalWeekReport(bot, chatId, userId);
      return true;

    case RK.PREFS: {
      const text = await buildPrefsMessage(userId);
      const prefs = await getAllPrefs(userId);
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kbPrefs(prefs) });
      return true;
    }

    case RK.MYMONTH:
      await sendPersonalMonthReport(bot, chatId, userId);
      return true;

    case RK.PULSE: {
      const { text, kb } = buildMicroMessage();
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
      return true;
    }

    case RK.HISTORY: {
      try {
        const { buildHistoryMessage } = await import("./admin.js");
        await buildHistoryMessage(bot, chatId, userId);
      } catch {
        await bot.sendMessage(chatId, "⚠️ تعذّر فتح السجل.").catch(() => {});
      }
      return true;
    }

    case RK.HELP:
      await bot.sendMessage(chatId, buildHelpMessage(), {
        parse_mode: "Markdown",
        reply_markup: kbHelp(),
      }).catch(() => {});
      return true;

    case RK.MENU: {
      const name = msg.from?.first_name || "صديقي";
      const prem = await isPremium(userId);
      const [limit, dlRaw] = await Promise.all([
        getUserDailyLimit(userId, prem),
        storage.getDailyDownloadCount(userId).catch(() => 0),
      ]);
      const remaining = Math.max(0, limit - dlRaw);
      await bot.sendMessage(
        chatId,
        buildWelcome(name, remaining, limit, SOURCES.length, prem, false),
        { parse_mode: "Markdown", reply_markup: kbMain() },
      ).catch(() => {});
      // ثبّت لوحة الرد أيضاً برسالة خفيفة
      await bot.sendMessage(
        chatId,
        `_الأزرار السفلية جاهزة — أو استخدم الأزرار أعلاه._`,
        { parse_mode: "Markdown", reply_markup: replyKeyboardMain() },
      ).catch(() => {});
      return true;
    }

    default:
      return false;
  }
}

/** يُرفق لوحة الرد مع أي رسالة ترحيب/بدء */
export function withReplyKeyboard(
  extra?: TelegramBot.SendMessageOptions,
): TelegramBot.SendMessageOptions {
  return {
    ...extra,
    reply_markup: replyKeyboardMain(),
  };
}

/** للرسائل في الجروبات: أزل أي لوحة عالقة */
export function withKeyboardRemoved(
  extra?: TelegramBot.SendMessageOptions,
): TelegramBot.SendMessageOptions {
  return {
    ...extra,
    reply_markup: replyKeyboardRemove(),
  };
}
