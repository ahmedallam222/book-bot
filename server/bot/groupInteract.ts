// ══════════════════════════════════════════════
// GROUP INTERACT — تفاعل حي في المجموعات (عمق v2)
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
import { refineBookName } from "./queryUnderstand.js";
import { sampleBooksForGenre } from "./curated.js";
import { storeRetryKey } from "./session.js";
import { GENRE_LABELS } from "./interests.js";

const CHAT_CD = (chatId: number) => `grp:ix:cd:${chatId}`;
const REACT_CD = (chatId: number) => `grp:ix:react:${chatId}`;

/** ردود قصيرة على تحيات/شكر في الجروب */
const GREET_RE =
  /^(?:السلام\s*عليكم|سلام|مرحبا|مرحباً|هلا|أهلا|اهلا|صباح\s*الخير|مساء\s*الخير|hi|hello|hey)[\s!?.…]*$/i;
const THANKS_RE =
  /^(?:شكرا|شكراً|يسلمو|تسلم|thrx|thanks|thank\s*you|عفوا|العفو)[\s!?.…]*$/i;
const WHO_RE =
  /^(?:مين\s*انت|من\s*انت|ايه\s*البوت|إيه\s*البوت|مين\s*رفيق|من\s*رفيق|البوت\s*مين)[\s?؟]*$/i;
const HELP_RE =
  /^(?:ساعد|مساعدة|help|ازاي|كيف|اشرح|أوامر|الاوامر)[\s?؟]*$/i;
const RAFEEQ_RE = /^(?:رفيق|يا\s*رفيق|@?\w*رفيق)[\s!?.…]*$/i;

/** «رشّح لي / أفضل كتاب / اقترح» */
const RECOMMEND_RE =
  /^(?:رش[ّح]?(?:\s*لي)?|اقترح(?:\s*لي)?|نصيحة\s*كتاب|أفضل\s*كتاب|احسن\s*كتاب|كتاب\s*حلو|ماذا\s*أقرأ|ماذا\s*اقرا|suggest|recommend)[\s!?.…]*$/i;

/** استخراج عنوان من جمل مثل: فين كتاب X / حد عنده X / ممكن كتاب X */
const EMBEDDED_BOOK_RE =
  /(?:^|\s)(?:فين|فينه|فينها|وين|حد\s*عنده|عندكم|عندك|ممكن|عايز|جيب(?:لي)?|ابعت(?:لي)?|ارسل(?:لي)?|أرسل(?:\s*لي)?)\s+(?:كتاب|رواية|قصة|ملف)?\s*[:\-]?\s*(.+)$/i;

const DOWNLOAD_REPLY_RE =
  /^(?:حمله|حمّله|نزلّه|نزله|ابعتّه|ابعتّه|ابعتّه|نفسه|ده|دي|هذا|هاته|هاتّه|يلا|تحميل)[\s!?.…]*$/i;

function kbSuggestTitles(titles: string[]): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (const t of titles.slice(0, 5)) {
    const k = storeRetryKey(t);
    const label = t.length > 30 ? t.slice(0, 29) + "…" : t;
    rows.push([{ text: `📖  ${label}`, callback_data: `retry:${k}` }]);
  }
  rows.push([
    { text: "🎲  مفاجأة", callback_data: "rg:any" },
    { text: "🏠  الرئيسية", callback_data: "main_menu" },
  ]);
  return { inline_keyboard: rows };
}

/** إن كان الرد على رسالة تحتوي عنوان كتاب محتمل */
export function extractBookFromReplyContext(
  msg: TelegramBot.Message,
): string | null {
  const reply = msg.reply_to_message;
  if (!reply) return null;
  const text = (msg.text || "").trim();
  if (!DOWNLOAD_REPLY_RE.test(text) && !/^(?:عايز|ممكن|ابعت|حمل)/i.test(text)) {
    // still allow short "pdf" / "الكتاب"
    if (!/^(?:pdf|الكتاب|الكتاب\s*ده)$/i.test(text)) return null;
  }
  const parent =
    (reply.text || reply.caption || "").replace(/\s+/g, " ").trim();
  if (!parent || parent.length < 2 || parent.length > 120) return null;
  // skip pure bot chrome
  if (isUiChromeText(parent)) return null;
  // pull title from «...» or *...*
  const q =
    parent.match(/[«"]([^»"]{2,80})[»"]/) ||
    parent.match(/_«([^»]{2,80})»_/) ||
    parent.match(/\*«([^»]{2,80})»\*/);
  if (q?.[1]) return q[1].trim();
  // if parent looks like a short title
  const refined = refineBookName(parent);
  if (refined.bookName && refined.bookName.length >= 2 && refined.bookName.length <= 80) {
    return refined.bookName;
  }
  if (parent.split(/\s+/).length <= 8 && !/^(?:🌿|✅|📚)/u.test(parent)) {
    return parent.slice(0, 80);
  }
  return null;
}

/**
 * إن وُجد عنوان كتاب مضمّن في جملة دردشة جماعية.
 * يُرجع العنوان أو null.
 */
export function extractEmbeddedBookRequest(text: string): string | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 100) return null;
  if (isUiChromeText(t)) return null;

  const m = t.match(EMBEDDED_BOOK_RE);
  if (m?.[1]) {
    const refined = refineBookName(m[1]);
    const name = (refined.bookName || m[1]).trim();
    if (name.length >= 2 && name.length <= 80) return name;
  }

  // "كتاب X" في وسط جملة قصيرة
  const mid = t.match(/(?:^|\s)(?:كتاب|رواية)\s+([^\n?!]{3,60})$/i);
  if (mid?.[1] && t.split(/\s+/).length <= 10) {
    const refined = refineBookName(mid[1]);
    return (refined.bookName || mid[1]).trim();
  }

  return null;
}

export async function tryGroupSocialReply(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<boolean> {
  if (!(await isFeatureOn("group_interact"))) return false;
  const chatId = msg.chat.id;
  if (msg.chat.type === "private") return false;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return false;
  if (isUiChromeText(text)) return false;

  const entities = msg.entities || [];
  const mentioned = entities.some(
    (e) => e.type === "mention" || e.type === "text_mention",
  );
  if (!isFreeTextGroup(chatId) && !mentioned && !RAFEEQ_RE.test(text)) {
    return false;
  }

  let reply: string | null = null;
  let markup: TelegramBot.InlineKeyboardMarkup | undefined;

  // توصيات
  if (RECOMMEND_RE.test(text) || /(?:رش[ّح]|اقترح|ماذا\s*أقرأ)/i.test(text) && text.length < 40) {
    const picks = [
      ...sampleBooksForGenre("selfhelp", 2),
      ...sampleBooksForGenre("novel", 2),
      ...sampleBooksForGenre("religion", 1),
    ].slice(0, 5);
    const lines = picks.map((s, i) => `${i + 1}. ${s}`).join("\n");
    reply =
      `✨ *اقتراحات ${BOT_NAME}*\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `${lines}\n\n` +
      `_اضغط عنواناً · أو اكتب اسماً مباشرةً_`;
    markup = kbSuggestTitles(picks);
    redis.incr("tel:group:recommend").catch(() => {});
  } else if (GREET_RE.test(text) || RAFEEQ_RE.test(text)) {
    reply =
      `🌿 أهلاً — أنا *${BOT_NAME}*.\n` +
      `اكتب *عنوان كتاب* وسأبحث عنه.\n` +
      `_/club · /random · /help · قل «رشّح لي»_`;
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
      `◦ «رشّح لي» لاقتراحات\n` +
      `◦ /random مفاجأة\n` +
      `◦ /club كتاب النادي\n` +
      `◦ /help الدليل الكامل`;
  } else if (/^(?:نادي|club)$/i.test(text)) {
    // fall through to playbook caller — return false so commands handle? 
    // soft club tip
    const { title } = await getGroupClubBook(chatId);
    reply = `📖 *كتاب النادي:* «${escMd(title)}»\n_/club للتصويت والتحميل_`;
  }

  if (!reply) return false;

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
      reply_markup: markup || replyKeyboardRemove(),
    } as any);
    redis.incr("tel:group:social_reply").catch(() => {});
    return true;
  } catch (e) {
    L.debug("groupInteract", "social reply failed", {
      err: String(e).slice(0, 80),
    });
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
    if (userMessageId) {
      try {
        await (bot as any).setMessageReaction?.(chatId, userMessageId, {
          reaction: [{ type: "emoji", emoji: "🎉" }],
        });
      } catch {
        /* older API */
      }
    }
    if (ok !== "OK") return;
    await bot
      .sendMessage(
        chatId,
        `✅ *تم* — «${escMd(bookName.slice(0, 50))}»\n` +
          `_كتاب آخر؟ اكتب العنوان · /club للنادي · قل «رشّح لي»_`,
        {
          parse_mode: "Markdown",
          reply_to_message_id: userMessageId,
          allow_sending_without_reply: true,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🎲  مفاجأة", callback_data: "rg:any" },
                { text: "🏠  الرئيسية", callback_data: "main_menu" },
              ],
            ],
          },
        } as any,
      )
      .catch(() => {});
    redis.incr("tel:group:celebrate").catch(() => {});
  } catch (e) {
    L.debug("groupInteract", "celebrate failed", {
      err: String(e).slice(0, 80),
    });
  }
}

/** أمر /group أو نص «نادي» يفتح تجربة تفاعلية */
export async function sendGroupPlaybook(
  bot: TelegramBot,
  chatId: number,
): Promise<void> {
  const { title } = await getGroupClubBook(chatId);
  const alts = [
    "العادات الذرية",
    "الأمير الصغير",
    "فن اللامبالاة",
    "الرحيق المختوم",
    "1984",
  ].filter((t) => t !== title);
  const genres = Object.entries(GENRE_LABELS)
    .filter(([id]) => id !== "other")
    .slice(0, 4)
    .map(([, label]) => label)
    .join(" · ");
  const text =
    `👥 *${BOT_NAME} في الجروب*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `*تفاعل سريع:*\n` +
    `◦ اكتب عنوان أي كتاب\n` +
    `◦ قل «مرحبا» أو «رشّح لي»\n` +
    `◦ رد على رسالة بـ «حمّله» إن ظهر عنوان\n` +
    `◦ /random · /club · /help\n\n` +
    `*ذوق متنوع:* ${escMd(genres)}\n\n` +
    `📖 *كتاب النادي:* «${escMd(title)}»\n` +
    `_صوّت 👍 أو حمّله من الأزرار_`;
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: kbClubWithVotes(title, alts),
  });
}
