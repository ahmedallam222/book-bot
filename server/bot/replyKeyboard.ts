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
  MENU:     "🏠 القائمة",
} as const;

const ALL_LABELS = new Set<string>(Object.values(RK));

export function isReplyKeyboardLabel(text: string): boolean {
  return ALL_LABELS.has(text.trim());
}

/** لوحة ثابتة أسفل الشات (محادثة خاصة) */
export function replyKeyboardMain(): TelegramBot.ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: RK.SEARCH }, { text: RK.RANDOM }],
      [{ text: RK.CHECKIN }, { text: RK.PROFILE }],
      [{ text: RK.TODAY }, { text: RK.BALANCE }],
      [{ text: RK.MYWEEK }, { text: RK.HELP }],
      [{ text: RK.MENU }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "اكتب عنوان كتاب…",
  } as TelegramBot.ReplyKeyboardMarkup;
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
  const text = (msg.text || "").trim();
  if (!text || !isReplyKeyboardLabel(text)) return false;

  // الردود فقط في الخاص — في المجموعات الأزرار لا تُعرض عادة
  if (msg.chat.type !== "private") return false;

  const chatId = msg.chat.id;
  const userId = String(msg.from?.id || "");
  if (!userId) return true;

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
      const body = await buildBookOfDayMessage(userId);
      await bot.sendMessage(chatId, body, {
        parse_mode: "Markdown",
        reply_markup: kbBookOfDay(),
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

    case RK.MYWEEK:
      await sendPersonalWeekReport(bot, chatId, userId);
      return true;

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
