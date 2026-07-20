// ══════════════════════════════════════════════
// SHARE CARD — بطاقة مشاركة أنيقة
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { escMd } from "./text.js";
import { storeRetryKey } from "./session.js";
import { BOT_NAME, BOT_TAGLINE } from "./brand.js";

/** Strip chars that break Telegram Markdown entities. */
function safeShareTitle(raw: string): string {
  return (raw || "")
    .replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function buildShareCardMessage(bookName: string, botUsername?: string): string {
  const title = safeShareTitle(bookName) || "كتاب";
  const link = botUsername ? `https://t.me/${botUsername}` : "";
  // Plain-friendly structure: avoid nested * and _ which Telegram often rejects
  return (
    `━━━━━━━━━━━━━━━━\n` +
    `📗 ${title}\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `وجدتُ هذا الكتاب عبر ${BOT_NAME}\n` +
    `${BOT_TAGLINE}\n\n` +
    (link ? `جرّب البوت: ${link}\n\n` : "") +
    `📖 اكتب العنوان في المحادثة واستلم PDF.\n` +
    `━━━━━━━━━━━━━━━━`
  );
}

/** HTML variant (more reliable for special titles). */
export function buildShareCardHtml(bookName: string, botUsername?: string): string {
  const title = (bookName || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 80) || "كتاب";
  const link = botUsername ? `https://t.me/${botUsername}` : "";
  return (
    `━━━━━━━━━━━━━━━━\n` +
    `📗 <b>${title}</b>\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `وجدتُ هذا الكتاب عبر <b>${BOT_NAME}</b>\n` +
    `<i>${BOT_TAGLINE.replace(/&/g, "&amp;")}</i>\n\n` +
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
