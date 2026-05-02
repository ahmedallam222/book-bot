import TelegramBot from "node-telegram-bot-api";
import { redis }    from "./redis.js";
import { L }        from "./logger.js";
import { escMd }    from "./text.js";

// ══════════════════════════════════════════════
// WEEKLY — أفضل كتب الأسبوع
// ══════════════════════════════════════════════

const WEEKLY_CACHE_KEY = "weekly:top:cache";
const WEEKLY_CACHE_TTL = 3600; // 1h

async function getWeeklyTopBooks(limit = 10): Promise<{ book: string; count: number }[]> {
  try {
    // FIX-WEEKLY: استخدام zrangebyscore مع REV بطريقة متوافقة مع ioredis v4+
    // zrevrange هو الأكثر توافقاً عبر إصدارات Redis المختلفة
    // نستخدمه مباشرةً بدل الـ triple-fallback المعقّد
    const raw = await (redis as any).zrevrange(
      "stats:top_books", 0, limit - 1, "WITHSCORES"
    ) as string[];

    if (!Array.isArray(raw) || raw.length === 0) return [];

    const result: { book: string; count: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      result.push({ book: raw[i], count: parseInt(raw[i + 1], 10) || 0 });
    }
    return result;
  } catch {
    return [];
  }
}

export async function handleWeeklyCommand(
  bot:     TelegramBot,
  chatId:  number,
  userId:  string,
  isAdmin: boolean
): Promise<void> {
  try {
    // Cache
    let books: { book: string; count: number }[] = [];
    const cached = await redis.get(WEEKLY_CACHE_KEY).catch(() => null);
    if (cached) {
      books = JSON.parse(cached);
    } else {
      books = await getWeeklyTopBooks(10);
      if (books.length > 0) {
        await redis.setex(WEEKLY_CACHE_KEY, WEEKLY_CACHE_TTL, JSON.stringify(books)).catch(() => {});
      }
    }

    if (books.length === 0) {
      await bot.sendMessage(chatId,
        `📅 *أفضل الأسبوع*\n\n_لا توجد بيانات كافية بعد — عد لاحقاً!_`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines  = books.map((b, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const count = isAdmin ? ` _(${b.count})_` : "";
      return `${medal} _${escMd(b.book.slice(0, 55))}_${count}`;
    });

    const msg =
      `📅 *أفضل كتب الأسبوع*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      lines.join("\n") +
      `\n\n_اكتب اسم أي كتاب لتحميله فوراً_ 📥`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "🔄 تحديث", callback_data: "weekly_refresh" },
          { text: "🏠 القائمة", callback_data: "main_menu" },
          ...(isAdmin ? [{ text: "📤 تصدير", callback_data: "weekly_export" }] : []),
        ]],
      },
    }).catch(() => {});

    L.debug("weekly", `Sent weekly top books`, { userId, count: books.length });
  } catch (e) {
    L.error("weekly", `Error`, { err: String(e).slice(0, 100) });
    await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
  }
}
