// ══════════════════════════════════════════════
// ONBOARDING — ترحيب خرافي باختيار ذوق (مرّة واحدة)
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { isOnboarded, setInterestBoost, GENRE_LABELS } from "./interests.js";
import { BOT_NAME } from "./brand.js";

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
  return (
    `🌟 *مرحباً ${name} — لنجعل ${BOT_NAME} يعرف ذوقك*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `اختر *مجالاً تحبّه* (يمكنك تجاهل الرسالة):\n` +
    `سأقترح لك كتباً أقرب إلى اهتمامك في «كتاب اليوم» والمفاجآت.\n\n` +
    `_خطوة اختيارية · تستغرق ثانية واحدة._`
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

export async function completeOnboarding(
  userId: string,
  genreId: string | "skip",
): Promise<string> {
  if (genreId === "skip") {
    await setInterestBoost(userId, "other", 1);
    return (
      `حسناً 🌿\n` +
      `_سأتعلّم ذوقك تدريجياً من الكتب التي تطلبها.\n` +
      `اكتب عنوان أي كتاب الآن._`
    );
  }
  await setInterestBoost(userId, genreId, 8);
  const label = GENRE_LABELS[genreId] || genreId;
  return (
    `✨ *تم — ذوقك: ${label}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `سأقرّب إليك «كتاب اليوم» والمفاجآت من هذا المجال.\n` +
    `يمكنك تغيير مسارك ببساطة عبر ما تحمّله لاحقاً.\n\n` +
    `*ابدأ الآن:* اكتب عنوان كتاب، أو اضغط «كتاب مفاجأة».`
  );
}
