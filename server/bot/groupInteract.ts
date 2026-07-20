// ══════════════════════════════════════════════
// GROUP INTERACT — تفاعل حي في المجموعات
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { escMd } from "./text.js";
import { isFreeTextGroup } from "./groupPolicy.js";
import { getGroupClubBook, kbClubWithVotes } from "./groupClub.js";
import { BOT_NAME } from "./brand.js";
import { isFeatureOn } from "./featureFlags.js";
import { replyKeyboardRemove, isUiChromeText } from "./replyKeyboard.js";

const CHAT_CD = (chatId: number) => `grp:ix:cd:${chatId}`;
const REACT_CD = (chatId: number) => `grp:ix:react:${chatId}`;

/** ردود قصيرة على تحيات/شكر في الجروب */
const GREET_RE =
  /^(?:السلام\s*عليكم|سلام|مرحبا|مرحباً|هلا|أهلا|اهلا|صباح\s*الخير|مساء\s*الخير|hi|hello|hey)[\s!?.…]*$/i;
const THANKS_RE =
  /^(?:شكرا|شكراً|يسلمو|تسلم| thrx|thanks|thank\s*you|عفوا|العفو)[\s!?.…]*$/i;
const WHO_RE =
  /^(?:مين\s*انت|من\s*انت|ايه\s*البوت|إيه\s*البوت|مين\s*رفيق|من\s*رفيق|البوت\s*مين)[\s?؟]*$/i;
const HELP_RE =
  /^(?:ساعد|مساعدة|help|ازاي|كيف|اشرح|أوامر|الاوامر)[\s?؟]*$/i;
const RAFEEQ_RE = /^(?:رفيق|يا\s*رفيق|@?\w*رفيق)[\s!?.…]*$/i;

export async function tryGroupSocialReply(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<boolean> {
  if (!(await isFeatureOn("group_interact"))) return false;
  const chatId = msg.chat.id;
  if (msg.chat.type === "private") return false;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return false;
  if (isUiChromeText(text)) return false; // handled as UI elsewhere
  // only free-text groups or when bot mentioned
  const entities = msg.entities || [];
  const mentioned = entities.some((e) => e.type === "mention" || e.type === "text_mention");
  if (!isFreeTextGroup(chatId) && !mentioned && !RAFEEQ_RE.test(text)) {
    return false;
  }

  let reply: string | null = null;
  if (GREET_RE.test(text) || RAFEEQ_RE.test(text)) {
    reply =
      `🌿 أهلاً — أنا *${BOT_NAME}*.\n` +
      `اكتب *عنوان كتاب* وسأبحث عنه.\n` +
      `_/club · /random · /help_`;
  } else if (THANKS_RE.test(text)) {
    reply = `_العفو — سعيد بالمساعدة. كتاب آخر؟_ 📖`;
  } else if (WHO_RE.test(text)) {
    reply =
      `أنا *${BOT_NAME}* — أجلب كتب PDF وألخّص وأقترح.\n` +
      `في الجروب: اكتب العنوان مباشرةً.`;
  } else if (HELP_RE.test(text)) {
    reply =
      `*باختصار:*\n` +
      `◦ اكتب اسم الكتاب\n` +
      `◦ /random مفاجأة\n` +
      `◦ /club كتاب النادي\n` +
      `◦ /help الدليل الكامل`;
  }

  if (!reply) return false;

  // rate limit social replies per chat
  try {
    const ok = await redis.set(CHAT_CD(chatId), "1", "EX", 45, "NX");
    if (ok !== "OK") return false;
  } catch {
    return false;
  }

  try {
    await bot.sendMessage(chatId, reply, {
      parse_mode: "Markdown",
      reply_to_message_id: msg.message_id,
      allow_sending_without_reply: true,
      reply_markup: replyKeyboardRemove(),
    } as any);
    redis.incr("tel:group:social_reply").catch(() => {});
    return true;
  } catch (e) {
    L.debug("groupInteract", "social reply failed", { err: String(e).slice(0, 80) });
    return false;
  }
}

/** بعد تسليم كتاب في جروب: تفاعل مرئي */
export async function celebrateGroupDelivery(
  bot: TelegramBot,
  chatId: number,
  bookName: string,
  userMessageId?: number,
): Promise<void> {
  if (chatId > 0) return; // private
  try {
    const ok = await redis.set(REACT_CD(chatId), "1", "EX", 20, "NX");
    // always try react on user message
    if (userMessageId) {
      try {
        await (bot as any).setMessageReaction?.(chatId, userMessageId, {
          reaction: [{ type: "emoji", emoji: "🎉" }],
        });
      } catch {
        // older API — ignore
      }
    }
    if (ok !== "OK") return;
    // short public line
    await bot.sendMessage(
      chatId,
      `✅ *تم* — «${escMd(bookName.slice(0, 50))}»\n` +
        `_كتاب آخر؟ اكتب العنوان · /club للنادي_`,
      {
        parse_mode: "Markdown",
        reply_to_message_id: userMessageId,
        allow_sending_without_reply: true,
      } as any,
    ).catch(() => {});
    redis.incr("tel:group:celebrate").catch(() => {});
  } catch (e) {
    L.debug("groupInteract", "celebrate failed", { err: String(e).slice(0, 80) });
  }
}

/** أمر /group أو نص «نادي» يفتح تجربة تفاعلية */
export async function sendGroupPlaybook(
  bot: TelegramBot,
  chatId: number,
): Promise<void> {
  const { title } = await getGroupClubBook(chatId);
  const alts = ["العادات الذرية", "الأمير الصغير", "فن اللامبالاة", "الرحيق المختوم", "1984"]
    .filter((t) => t !== title);
  const text =
    `👥 *${BOT_NAME} في الجروب*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `*تفاعل سريع:*\n` +
    `◦ اكتب عنوان أي كتاب\n` +
    `◦ قل «مرحبا» أو «رفيق» — أرد بلطف\n` +
    `◦ /random · /club · /help\n\n` +
    `📖 *كتاب النادي:* «${escMd(title)}»\n` +
    `_صوّت 👍 أو حمّله من الأزرار_`;
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: kbClubWithVotes(title, alts),
  });
}
