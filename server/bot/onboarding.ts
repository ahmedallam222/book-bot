// ══════════════════════════════════════════════
// ONBOARDING — مسار ذكي (ذوق → 3 كتب للتجربة)
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import {
  isOnboarded,
  setInterestBoost,
  GENRE_LABELS,
  getPrimaryGenre,
} from "./interests.js";
import { BOT_NAME } from "./brand.js";
import { sampleBooksForGenre, listsForGenre } from "./curated.js";
import { storeRetryKey } from "./session.js";
import { redis } from "./redis.js";

const GENRE_BUTTONS: { id: string; text: string }[] = [
  { id: "novel", text: "📖 روايات" },
  { id: "selfhelp", text: "🚀 تطوير ذات" },
  { id: "religion", text: "📿 دين" },
  { id: "history", text: "🏛 تاريخ" },
  { id: "science", text: "🔬 علوم" },
  { id: "psych", text: "🧠 علم نفس" },
  { id: "philosophy", text: "💭 فلسفة" },
  { id: "poetry", text: "✒️ شعر" },
];

export function buildOnboardingMessage(name: string): string {
  const n = (name || "").trim() || "صديقي";
  return (
    `🌟 *مرحباً ${n} — لنجعل ${BOT_NAME} يعرف ذوقك*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `*الخطوة 1 من 2:* اختر مجالاً تحبّه.\n` +
    `سأقرّب «كتاب اليوم» والمفاجآت والقوائم من اهتمامك.\n\n` +
    `_اختياري تماماً · ثانية واحدة · يمكنك التخطّي._`
  );
}

export function kbOnboarding(): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < GENRE_BUTTONS.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [
      { text: GENRE_BUTTONS[i].text, callback_data: `onb:${GENRE_BUTTONS[i].id}` },
    ];
    if (GENRE_BUTTONS[i + 1]) {
      row.push({
        text: GENRE_BUTTONS[i + 1].text,
        callback_data: `onb:${GENRE_BUTTONS[i + 1].id}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "⏭  تخطّي الآن", callback_data: "onb:skip" }]);
  return { inline_keyboard: rows };
}

export async function shouldShowOnboarding(userId: string): Promise<boolean> {
  return !(await isOnboarded(userId));
}

/** بعد اختيار الذوق — رسالة + أزرار 3 كتب + قائمة مرتبطة */
export async function completeOnboarding(
  userId: string,
  genreId: string | "skip",
): Promise<{ text: string; kb: TelegramBot.InlineKeyboardMarkup }> {
  if (genreId === "skip") {
    await setInterestBoost(userId, "other", 1);
    try { const { redis } = await import("./redis.js"); await redis.incr("tel:onboard:complete"); } catch { /* */ }
    return {
      text:
        `حسناً 🌿\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `سأتعلّم ذوقك تدريجياً من الكتب التي تطلبها.\n\n` +
        `*ابدأ الآن:*\n` +
        `◦ اكتب *عنوان كتاب* في المحادثة\n` +
        `◦ أو جرّب «كتاب مفاجأة» / «قوائم»\n\n` +
        `_يمكنك لاحقاً: /taste لتغيير الذوق._`,
      kb: {
        inline_keyboard: [
          [
            { text: "🎲  مفاجأة", callback_data: "rg:any" },
            { text: "📖  قوائم", callback_data: "curated_menu" },
          ],
          [{ text: "🔍  ابحث", callback_data: "new_search" }],
        ],
      },
    };
  }

  await setInterestBoost(userId, genreId, 8);
  try { const { redis } = await import("./redis.js"); await redis.incr("tel:onboard:complete"); } catch { /* */ }
  // remember last chosen genre for soft tips
  try {
    await redis.set(`ret:onb_genre:${userId}`, genreId, "EX", 400 * 86400);
  } catch { /* */ }

  const label = GENRE_LABELS[genreId] || genreId;
  const samples = sampleBooksForGenre(genreId, 3);
  const lists = listsForGenre(genreId).slice(0, 1);
  const listId = lists[0]?.id;

  const sampleLines = samples.length
    ? samples.map((b, i) => `${i + 1}. «${b}»`).join("\n")
    : "◦ اكتب أي عنوان تحبّه";

  const text =
    `✨ *تم — ذوقك: ${label}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `*الخطوة 2:* جرّب أحد هذه العناوين (أو اكتب عنوانك):\n` +
    `${sampleLines}\n\n` +
    `سأقرّب «كتاب اليوم» والمفاجآت من هذا المجال.\n` +
    `_غيّر ذوقك متى شئت: /taste_`;

  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (const b of samples) {
    const k = storeRetryKey(b);
    const labelB = b.length > 30 ? b.slice(0, 29) + "…" : b;
    rows.push([{ text: `📥  ${labelB}`, callback_data: `retry:${k}` }]);
  }
  if (listId) {
    rows.push([{ text: "📖  قائمة كاملة لهذا الذوق", callback_data: `clist:${listId}` }]);
  }
  rows.push([
    { text: "🎲  مفاجأة", callback_data: "rg:any" },
    { text: "📖  كل القوائم", callback_data: "curated_menu" },
  ]);
  rows.push([{ text: "🔄  غيّر الذوق", callback_data: "onb_restart" }]);

  return { text, kb: { inline_keyboard: rows } };
}

/** إعادة فتح اختيار الذوق */
export function buildTasteResetMessage(): string {
  return (
    `🎭 *تغيير الذوق — ${BOT_NAME}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `اختر مجالاً جديداً وسأحدّث اقتراحاتك.\n` +
    `_لا يُحذف تاريخ تحميلاتك._`
  );
}

export async function getOnboardingGenre(userId: string): Promise<string | null> {
  try {
    return (await redis.get(`ret:onb_genre:${userId}`)) || (await getPrimaryGenre(userId));
  } catch {
    return null;
  }
}
