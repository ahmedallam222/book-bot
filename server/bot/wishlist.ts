import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { escMd } from "./text.js";
import { storeRetryKey } from "./session.js";
import { isPremium } from "./userSettings.js";
import {
  getJourneyMap,
  formatWishlistLine,
  journeySummary,
  type JourneyStatus,
} from "./journey.js";

// ══════════════════════════════════════════════
// WISHLIST — قائمة أمنيات + رحلة قراءة
// ══════════════════════════════════════════════

export const WISHLIST_MAX = 20;
export const WISHLIST_MAX_PREMIUM = 50;

const WISHLIST_KEY = (uid: string) => `wishlist:${uid}`;
const CB_MAX_BYTES = 64;

export function safeCbWl(data: string): string {
  if (Buffer.byteLength(data, "utf8") <= CB_MAX_BYTES) return data;
  let t = data;
  while (Buffer.byteLength(t, "utf8") > CB_MAX_BYTES) t = t.slice(0, -1);
  return t;
}

export async function getWishlistMax(userId: string, premHint?: boolean): Promise<number> {
  const prem =
    premHint !== undefined ? premHint : await isPremium(userId).catch(() => false);
  return prem ? WISHLIST_MAX_PREMIUM : WISHLIST_MAX;
}

export async function getWishlist(userId: string): Promise<string[]> {
  try {
    const raw = await redis.get(WISHLIST_KEY(userId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export async function saveWishlist(userId: string, list: string[]): Promise<void> {
  await redis.setex(WISHLIST_KEY(userId), 90 * 24 * 3600, JSON.stringify(list));
}

export function buildWishlistMsg(
  list: string[],
  isPrem = false,
  maxSlots = WISHLIST_MAX,
  journey?: Record<string, JourneyStatus>,
  summaryLine = "",
): string {
  const premLine = isPrem ? ` ⭐ _(${maxSlots} كتاب)_` : "";

  if (list.length === 0) {
    return (
      `🔖 *قائمة أمنياتك فارغة*${premLine}\n\n` +
      `_بعد تحميل أي كتاب، اضغط «احفظه» لإضافته_\n` +
      `_أو أرسل:_ /wishlist عنوان الكتاب\n\n` +
      `_هذه قائمتك لرحلة القراءة._`
    );
  }

  const items = list
    .map((b, i) => {
      const st = (journey?.[b] || "want") as JourneyStatus;
      return formatWishlistLine(b, st, i);
    })
    .join("\n");

  return (
    `🔖 *رحلة قراءتك* (${list.length}/${maxSlots})${premLine}\n` +
    (summaryLine ? `${summaryLine}\n` : "") +
    `\n${items}\n\n` +
    `_📥 تحميل · 🔄 غيّر الحالة · 🗑 حذف_`
  );
}

export async function buildWishlistKb(
  list: string[],
  userId?: string,
): Promise<TelegramBot.InlineKeyboardMarkup> {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  const journey = userId ? await getJourneyMap(userId) : {};

  list.slice(0, WISHLIST_MAX_PREMIUM).forEach((b, i) => {
    const retryK = storeRetryKey(b);
    const st = journey[b] || "want";
    const cycleLabel =
      st === "want" ? "🔖→📖" : st === "reading" ? "📖→✅" : "✅→🔖";
    rows.push([
      { text: `📥 ${b.slice(0, 28)}`, callback_data: safeCbWl(`retry:${retryK}`) },
      { text: cycleLabel, callback_data: safeCbWl(`wlj:${i}`) },
      { text: "🗑", callback_data: safeCbWl(`wishlist_del:${i}`) },
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

export async function sendWishlist(
  bot: TelegramBot,
  chatId: number,
  userId: string,
): Promise<void> {
  const [list, prem, journey] = await Promise.all([
    getWishlist(userId),
    isPremium(userId).catch(() => false),
    getJourneyMap(userId),
  ]);
  const maxSlots = prem ? WISHLIST_MAX_PREMIUM : WISHLIST_MAX;
  const summary = await journeySummary(userId, list);
  await bot
    .sendMessage(chatId, buildWishlistMsg(list, prem, maxSlots, journey, summary), {
      parse_mode: "Markdown",
      reply_markup: await buildWishlistKb(list, userId),
    })
    .catch(() => {});
}
