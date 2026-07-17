// ══════════════════════════════════════════════
// SHARE CARD — بطاقة مشاركة أنيقة (نص قابل لإعادة التوجيه)
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { escMd } from "./text.js";
import { storeRetryKey } from "./session.js";
import { BOT_NAME, BOT_TAGLINE } from "./brand.js";

export function buildShareCardMessage(bookName: string, botUsername?: string): string {
  const title = bookName.trim().slice(0, 80);
  const link = botUsername
    ? `https://t.me/${botUsername}`
    : "";
  return (
    `━━━━━━━━━━━━━━━━\n` +
    `📗 *${escMd(title)}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `وجدتُ هذا الكتاب عبر *${BOT_NAME}*\n` +
    `_${escMd(BOT_TAGLINE)}_\n\n` +
    (link ? `جرّب البوت: ${link}\n\n` : "") +
    `📖 اكتب العنوان في المحادثة واستلم PDF.\n` +
    `━━━━━━━━━━━━━━━━`
  );
}

export function kbShareCard(bookName: string): TelegramBot.InlineKeyboardMarkup {
  const k = storeRetryKey(bookName);
  return {
    inline_keyboard: [
      [{ text: "📥  حمّل الكتاب", callback_data: `retry:${k}` }],
      [
        { text: "📚  مكتبتي", callback_data: "my_library" },
        { text: "🏠  الرئيسية", callback_data: "main_menu" },
      ],
    ],
  };
}
