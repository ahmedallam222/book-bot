import TelegramBot from "node-telegram-bot-api";
import { redis }    from "./redis.js";
import { L }        from "./logger.js";
import { escMd, truncateAtWord } from "./text.js";
import { getWeeklyTopBooks } from "./analytics.js";

// ══════════════════════════════════════════════
// WEEKLY — أفضل كتب الأسبوع
//
// قبل الإصلاح: كان يقرأ من `stats:top_books` (الـ all-time) — نفس
// المصدر بالظبط لقائمة "🏆 الأكثر تحميلاً". الـ button name كان "أسبوعي"
// لكن البيانات كلية، فالقائمتين كانت متطابقة 100% للمستخدم.
//
// الآن: نقرأ من `stats:top_books:week:{ISO-week}` (TTL 21 يوم) عبر
// `getWeeklyTopBooks`. الـ keys دي بيكتبها `trackDownload` في
// analytics.ts بتوقيت القاهرة — فالأسبوع بينتهي في 23:59:59 ليلة الأحد
// القاهري ويبدأ أسبوع جديد فجر الإثنين القاهري.
// ══════════════════════════════════════════════

const WEEKLY_CACHE_KEY = "weekly:top:cache";
const WEEKLY_CACHE_TTL = 3600; // 1h

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
        `📅 *أفضل كتب الأسبوع*\n\n_لا توجد بيانات كافية بعد — عد لاحقاً!_\n\n_يمكنك عرض تقريرك الشخصي:_ /myweek`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines  = books.map((b, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const count = isAdmin ? ` _(${b.count})_` : "";
      // Smart truncate at word boundary (was: hard slice at 55 → "Full boo")
      return `${medal} _${escMd(truncateAtWord(b.book, 80))}_${count}`;
    });

    const msg =
      `📅 *أفضل كتب الأسبوع*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      lines.join("\n") +
      `\n\n_اكتب اسم أي كتاب لتحميله فوراً_ 📥`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 تحديث", callback_data: "weekly_refresh" },
            { text: "📊 أسبوعي أنا", callback_data: "my_week" },
          ],
          [
            { text: "🏠 القائمة", callback_data: "main_menu" },
            ...(isAdmin ? [{ text: "📤 تصدير", callback_data: "weekly_export" }] : []),
          ],
        ],
      },
    }).catch(() => {});

    L.debug("weekly", `Sent weekly top books`, { userId, count: books.length });
  } catch (e) {
    L.error("weekly", `Error`, { err: String(e).slice(0, 100) });
    await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
  }
}
