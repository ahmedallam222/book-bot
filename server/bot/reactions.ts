import TelegramBot from "node-telegram-bot-api";

// Telegram Bot API: setMessageReaction
// مكتبة node-telegram-bot-api تدعمه منذ 0.66 ولكن typing غير محكم — نتجاوزه بـ any
// المرجع: https://core.telegram.org/bots/api#setmessagereaction
//
// قائمة الـ reactions المسموحة لجميع البوتات بدون خطة Premium:
// 👍 👎 ❤️ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍
// 🐳 ❤️‍🔥 🌚 🌭 💯 🤣 ⚡️ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻
// 👀 🎃 🙈 😇 😨 🤝 ✍️ 🤗 🫡 🎅 🎄 ☃️ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎
// 👾 🤷‍♂️ 🤷 🤷‍♀️ 😡

/**
 * يضع reaction واحد على رسالة. fire-and-forget — لا يُلقي أخطاء حتى لو فشل
 * (مثلاً لو الإصدار قديم أو الرسالة قديمة جداً).
 *
 * @param bot     instance البوت
 * @param chatId  معرف المحادثة
 * @param msgId   معرف الرسالة (الـ message_id من رسالة المستخدم)
 * @param emoji   الـ emoji (مفرد فقط — Telegram يقبل array لكن نبسّطه)
 */
export async function react(
  bot: TelegramBot,
  chatId: number | string,
  msgId: number,
  emoji: string,
): Promise<void> {
  if (!msgId || !emoji) return;
  try {
    await (bot as any).setMessageReaction(chatId, msgId, {
      reaction: [{ type: "emoji", emoji }],
      is_big: false,
    });
  } catch {
    // Telegram يرفض الـ reactions على رسائل قديمة (>48h) أو في group بلا
    // صلاحية. نتجاهل بصمت — هذا تحسين تجميلي لا يجب أن يكسر التدفق.
  }
}

/** يحذف الـ reaction (مفيد لاستبدال 👀 بـ ✅) */
export async function clearReaction(
  bot: TelegramBot,
  chatId: number | string,
  msgId: number,
): Promise<void> {
  if (!msgId) return;
  try {
    await (bot as any).setMessageReaction(chatId, msgId, { reaction: [] });
  } catch { /* swallow */ }
}

/**
 * يختار emoji عشوائي من pool ويطبّقه. fire-and-forget. يُستخدَم
 * لتنويع تفاعلات البوت (بدل تكرار 🎉 لكل نجاح، نختار من pool
 * متنوّع: 🎉 🔥 🤩 🥳 ❤️ ⚡ ...). pool فارغ → no-op آمن.
 */
export async function reactRandom(
  bot:    TelegramBot,
  chatId: number | string,
  msgId:  number,
  pool:   readonly string[],
): Promise<void> {
  if (!msgId || pool.length === 0) return;
  const emoji = pool[Math.floor(Math.random() * pool.length)];
  return react(bot, chatId, msgId, emoji);
}
