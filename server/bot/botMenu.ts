// ══════════════════════════════════════════════
// BOT MENU — قائمة أوامر تيليجرام (setMyCommands)
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";

const USER_COMMANDS: TelegramBot.BotCommand[] = [
  { command: "start",    description: "البداية والقائمة" },
  { command: "search",   description: "ابحث عن كتاب" },
  { command: "random",   description: "كتاب مفاجأة" },
  { command: "daily",    description: "سجّل حضورك اليوم" },
  { command: "today",    description: "كتاب اليوم" },
  { command: "library",  description: "مكتبتي" },
  { command: "history",  description: "آخر طلباتك" },
  { command: "continue", description: "أكمل رحلتي" },
  { command: "lists",    description: "قوائم مختارة" },
  { command: "profile",  description: "ملفي الشخصي" },
  { command: "stats",    description: "رصيدي اليوم" },
  { command: "myweek",   description: "تقريري الأسبوعي" },
  { command: "mymonth",  description: "تقريري الشهري" },
  { command: "wishlist", description: "أمنياتي" },
  { command: "prefs",    description: "إعدادات الإشعارات" },
  { command: "pulse",    description: "لحظة يومية خفيفة" },
  { command: "taste",    description: "غيّر ذوق القراءة" },
  { command: "share",    description: "بطاقة مشاركة كتاب" },
  { command: "img",      description: "صورة بالذكاء الاصطناعي" },
  { command: "help",     description: "كيف أستخدم رفيق؟" },
  { command: "lang",     description: "Language / اللغة ar|en" },
  { command: "premium",  description: "Premium" },
  { command: "invite",   description: "ادعُ صديقاً" },
];

export async function registerBotMenu(bot: TelegramBot): Promise<void> {
  try {
    await bot.setMyCommands(USER_COMMANDS);
    await bot.setMyCommands(USER_COMMANDS, {
      scope: { type: "all_private_chats" },
    } as any).catch(() => {});
    await bot.setMyCommands(
      [
        { command: "club",  description: "كتاب النادي" },
        { command: "group", description: "دليل المجموعة" },
        { command: "help",  description: "مساعدة رفيق" },
      ],
      { scope: { type: "all_group_chats" } } as any,
    ).catch(() => {});
    L.info("bot", `Bot command menu registered (${USER_COMMANDS.length} cmds)`);
  } catch (e) {
    L.warn("bot", `setMyCommands failed: ${String(e).slice(0, 100)}`);
  }
}
