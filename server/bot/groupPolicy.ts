// ══════════════════════════════════════════════
// GROUP POLICY — free-text anti-spam + soft replies + welcome
// ══════════════════════════════════════════════
import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { GROUP_FREE_TEXT_CHAT_IDS } from "./config.js";
import { GROUP_CLUB_WELCOME_EXTRA } from "./groupClub.js";

const RATE_KEY = (chatId: number, userId: string) =>
  `grp:rate:${chatId}:${userId}`;
const SOFT_KEY = (chatId: number, userId: string) =>
  `grp:soft:${chatId}:${userId}`;
const WELCOME_KEY = (chatId: number) => `grp:welcome_sent:${chatId}`;

/** Max book requests per user per window in free-text groups */
const RATE_LIMIT = 8;
const RATE_WINDOW_SEC = 10 * 60;
/** Soft "not a book" tip at most once per 3 minutes */
const SOFT_COOLDOWN_SEC = 180;
/** Welcome pin/text once per 7 days per group */
const WELCOME_TTL_SEC = 7 * 86400;

export function isFreeTextGroup(chatId: number): boolean {
  return GROUP_FREE_TEXT_CHAT_IDS.has(String(chatId));
}

/**
 * Returns true if the user may place another book request in this group.
 * Always true outside free-text groups (DM / trigger-based groups).
 */
export async function allowGroupBookRequest(
  chatId: number,
  userId: string,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  if (!isFreeTextGroup(chatId)) return { ok: true };
  try {
    const key = RATE_KEY(chatId, userId);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, RATE_WINDOW_SEC);
    if (n > RATE_LIMIT) {
      const ttl = await redis.ttl(key);
      redis.incr("tel:group:rate_limited").catch(() => {});
      return { ok: false, retryAfterSec: Math.max(ttl, 30) };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

export async function maybeSoftNotBookReply(
  bot: TelegramBot,
  chatId: number,
  userId: string,
  replyToMsgId?: number,
): Promise<void> {
  if (!isFreeTextGroup(chatId)) return;
  try {
    const key = SOFT_KEY(chatId, userId);
    const ok = await redis.set(key, "1", "EX", SOFT_COOLDOWN_SEC, "NX");
    if (ok !== "OK") return;
    await bot.sendMessage(
      chatId,
      `📚 *لبحث عن كتاب:* اكتب العنوان مباشرة\n` +
        `مثال: \`فكر وازدد ثراء\`\n\n` +
        `_أو:_ \`بوت اسم الكتاب\`\n` +
        `_الأوامر:_ /help · /random · /club · /premium`,
      {
        parse_mode: "Markdown",
        reply_to_message_id: replyToMsgId,
        allow_sending_without_reply: true,
      } as any,
    );
    redis.incr("tel:group:soft_not_book").catch(() => {});
  } catch (e) {
    L.debug("groupPolicy", "soft reply failed", { err: String(e).slice(0, 80) });
  }
}

export const GROUP_WELCOME_TEXT =
  `🌿 *أهلاً — أنا رفيق*\n\n` +
  `أتريد كتاباً؟ اكتب *عنوانه مباشرةً* في المحادثة.\n` +
  `مثال: \`فكر وازدد ثراء\`\n\n` +
  `*ماذا أقدّم؟*\n` +
  `◦ أبحث وأرسل ملف PDF\n` +
  `◦ يمكنك طلب ملخّص بعد التحميل\n` +
  `◦ أزرار: مفاجأة · أمنيات · Premium\n\n` +
  `*نصيحة:* العنوان وحده يكفي غالباً.\n` +
  `_/help للشرح · /daily لتسجيل الحضور · /club لنادي الأسبوع_` +
  GROUP_CLUB_WELCOME_EXTRA;

export async function maybeSendGroupWelcome(
  bot: TelegramBot,
  chatId: number,
  force = false,
): Promise<void> {
  if (!isFreeTextGroup(chatId) && !force) return;
  try {
    const key = WELCOME_KEY(chatId);
    if (!force) {
      const ok = await redis.set(key, "1", "EX", WELCOME_TTL_SEC, "NX");
      if (ok !== "OK") return;
    } else {
      await redis.set(key, "1", "EX", WELCOME_TTL_SEC);
    }
    const m = await bot.sendMessage(chatId, GROUP_WELCOME_TEXT, {
      parse_mode: "Markdown",
    });
    // Best-effort pin (needs admin rights)
    try {
      await bot.pinChatMessage(chatId, m.message_id, {
        disable_notification: true,
      } as any);
    } catch { /* not admin — ignore */ }
    redis.incr("tel:group:welcome_sent").catch(() => {});
  } catch (e) {
    L.warn("groupPolicy", "welcome failed", { chatId, err: String(e).slice(0, 80) });
  }
}
