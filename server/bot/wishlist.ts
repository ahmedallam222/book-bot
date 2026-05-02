import TelegramBot from "node-telegram-bot-api";
import { redis }   from "./redis.js";
import { escMd }   from "./text.js";
import { storeRetryKey } from "./session.js";
import { isPremium } from "./userSettings.js";

// ══════════════════════════════════════════════
// WISHLIST MODULE — قائمة أمنيات القراءة
//
// مُستقل تماماً — لا global، لا circular imports
//
// الحد الأقصى:
//   مجاني:  20 كتاب
//   Premium: 50 كتاب ⭐
//
// التخزين: wishlist:{userId} → JSON string[] في Redis
// TTL: 90 يوم، يُجدَّد عند كل تعديل
//
// parse_mode: "Markdown" (v1) — NOT MarkdownV2
// ══════════════════════════════════════════════

export const WISHLIST_MAX         = 20;  // مجاني
export const WISHLIST_MAX_PREMIUM = 50;  // Premium ⭐

const WISHLIST_KEY = (uid: string) => `wishlist:${uid}`;
const CB_MAX_BYTES = 64;

/** تقليص callback_data لـ ≤64 بايت (حد Telegram) */
export function safeCbWl(data: string): string {
  if (Buffer.byteLength(data, "utf8") <= CB_MAX_BYTES) return data;
  let t = data;
  while (Buffer.byteLength(t, "utf8") > CB_MAX_BYTES) t = t.slice(0, -1);
  return t;
}

/** الحد الأقصى بناءً على نوع الحساب */
export async function getWishlistMax(userId: string): Promise<number> {
  const prem = await isPremium(userId).catch(() => false);
  return prem ? WISHLIST_MAX_PREMIUM : WISHLIST_MAX;
}

// ── Storage helpers ───────────────────────────

export async function getWishlist(userId: string): Promise<string[]> {
  try {
    const raw = await redis.get(WISHLIST_KEY(userId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

export async function saveWishlist(userId: string, list: string[]): Promise<void> {
  await redis.setex(WISHLIST_KEY(userId), 90 * 24 * 3600, JSON.stringify(list));
}

// ── UI builders ───────────────────────────────

export function buildWishlistMsg(list: string[], isPrem = false, maxSlots = WISHLIST_MAX): string {
  const premLine = isPrem ? ` ⭐ _(${maxSlots} كتاب)_` : "";

  if (list.length === 0) {
    return (
      `🔖 *قائمة أمنياتك فارغة*${premLine}\n\n` +
      `_بعد تحميل أي كتاب، اضغط "احفظ للاحقاً" لإضافته_\n` +
      `_أو أرسل:_ /wishlist أضف اسم الكتاب`
    );
  }

  const items = list
    .map((b, i) => `${i + 1}. _${escMd(b.slice(0, 60))}_`)
    .join("\n");

  return (
    `🔖 *قائمة أمنياتك* (${list.length}/${maxSlots})${premLine}\n\n` +
    `${items}\n\n` +
    `_اضغط 📥 لتحميل كتاب أو 🗑 لحذفه_`
  );
}

export function buildWishlistKb(list: string[]): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  list.slice(0, WISHLIST_MAX_PREMIUM).forEach((b, i) => {
    const retryK = storeRetryKey(b);
    rows.push([
      { text: `📥 ${b.slice(0, 35)}`, callback_data: safeCbWl(`retry:${retryK}`) },
      { text: "🗑",                    callback_data: safeCbWl(`wishlist_del:${i}`) },
    ]);
  });

  const bottomRow: TelegramBot.InlineKeyboardButton[] = [
    { text: "🏠 القائمة", callback_data: "main_menu" },
  ];
  if (list.length > 0) {
    bottomRow.unshift({ text: "🗑️ مسح الكل", callback_data: "wishlist_clear" });
  }
  rows.push(bottomRow);

  return { inline_keyboard: rows };
}

/** إرسال رسالة Wishlist كاملة مع دعم Premium */
export async function sendWishlist(
  bot:    TelegramBot,
  chatId: number,
  userId: string,
): Promise<void> {
  const [list, prem, maxSlots] = await Promise.all([
    getWishlist(userId),
    isPremium(userId).catch(() => false),
    getWishlistMax(userId),
  ]);
  await bot.sendMessage(chatId, buildWishlistMsg(list, prem, maxSlots), {
    parse_mode:   "Markdown",
    reply_markup: buildWishlistKb(list),
  }).catch(() => {});
}
