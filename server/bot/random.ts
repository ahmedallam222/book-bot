import TelegramBot from "node-telegram-bot-api";
import { redis }    from "./redis.js";
import { L }        from "./logger.js";
import { GENRE_MAP, SUGGESTIONS } from "./suggestions.js";
import { handleBookRequest }      from "./bookRequest.js";
import { escMd }                  from "./text.js";
import { onSuccessfulRandom } from "./retention.js";

// ══════════════════════════════════════════════
// RANDOM — كتاب مفاجأة بجنس أدبي
// ══════════════════════════════════════════════

// قائمة الأجناس المدعومة للعرض في الأزرار
const GENRE_LABELS: Record<string, string> = {
  "رواية":      "رواية 📖",
  "تطوير":      "تطوير ذات 🚀",
  "تاريخ":      "تاريخ 🏛️",
  "علم":        "علوم 🔬",
  "دين":        "دين 📿",
  "فلسفة":      "فلسفة 💭",
  "اقتصاد":     "اقتصاد 💰",
  "نفس":        "علم نفس 🧩",
  "خيال علمي":  "خيال علمي 🛸",
  "رعب":        "رعب وغموض 🕵️",
  "أطفال":      "أطفال ويافعين 👶",
  "شعر":        "شعر 📝",
  "تكنولوجيا":  "تكنولوجيا 💻",
  "سياسة":      "سياسة 🌍",
  "فن":         "فن وإبداع 🎨",
  "صحة":        "صحة ورياضة 🏋️",
  "لغة":        "لغة عربية 📚",
};

// ── مساعد: استخرج الإيموجي الأخير من نص ──────
function extractEmoji(text: string): string {
  const matches = [...text.matchAll(/\p{Emoji_Presentation}/gu)];
  return matches.length ? matches[matches.length - 1][0] : "📚";
}

// ── مساعد: ابحث عن كتب الجنس داخل GENRE_MAP ──
function findBooksForGenreKey(key: string): string[] {
  for (const [keys, books] of Object.entries(GENRE_MAP)) {
    if (keys.split("|").some(k => k.includes(key) || key.includes(k))) {
      return books;
    }
  }
  return [];
}

// ── GENRES: المصدر الموحّد للأجناس (مُصدَّر لـ routes.ts) ──
export const GENRES = Object.entries(GENRE_LABELS).map(([id, labelWithEmoji]) => ({
  id,
  label:  labelWithEmoji.replace(/\p{Emoji_Presentation}/gu, "").trim(),
  emoji:  extractEmoji(labelWithEmoji),
  books:  findBooksForGenreKey(id),
}));

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getBooksForGenre(genreKey: string): string[] {
  if (genreKey === "any") return SUGGESTIONS;

  for (const [keys, books] of Object.entries(GENRE_MAP)) {
    if (keys.split("|").some((k) => k.includes(genreKey) || genreKey.includes(k))) {
      return books;
    }
  }
  return SUGGESTIONS;
}

// ── تجنّب تكرار آخر كتاب اتقدّم للمستخدم ─────
async function pickUniqueRandom(userId: string, books: string[]): Promise<string> {
  if (books.length <= 1) return books[0] ?? pickRandom(SUGGESTIONS);

  const lastKey = `random:last:${userId}`;
  const last    = await redis.get(lastKey).catch(() => null);
  let picked    = pickRandom(books);
  let attempts  = 0;

  while (picked === last && attempts < 5) {
    picked = pickRandom(books);
    attempts++;
  }

  await redis.set(lastKey, picked, "EX", 86400).catch(() => {});
  return picked;
}

export async function handleRandomCommand(
  bot:       TelegramBot,
  chatId:    number,
  userId:    string,
  token:     string,
  username?: string | null,
  genreInput?: string
): Promise<void> {
  if (!genreInput || genreInput.trim() === "") {
    // عرض أزرار الأجناس — زرين في كل سطر
    const entries = Object.entries(GENRE_LABELS);
    const rows: TelegramBot.InlineKeyboardButton[][] = [];

    for (let i = 0; i < entries.length; i += 2) {
      const row: TelegramBot.InlineKeyboardButton[] = [];
      row.push({ text: entries[i][1], callback_data: `rg:${entries[i][0]}` });
      if (entries[i + 1]) {
        row.push({ text: entries[i + 1][1], callback_data: `rg:${entries[i + 1][0]}` });
      }
      rows.push(row);
    }

    rows.push([{ text: "🎲 أي كتاب", callback_data: "rg:any" }]);

    await bot.sendMessage(chatId,
      `🎲 *اختر نوع الكتاب*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
      `_سأختار لك كتاباً بلطف — بلا ضغط_`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
    ).catch(() => {});
    return;
  }

  await handleRandomByGenre(bot, chatId, userId, token, username, genreInput.trim());
}

export async function handleRandomGenreCallback(
  bot:      TelegramBot,
  chatId:   number,
  userId:   string,
  token:    string,
  username: string | null | undefined,
  genreKey: string
): Promise<void> {
  if (genreKey === "menu") {
    await handleRandomCommand(bot, chatId, userId, token, username);
    return;
  }
  await handleRandomByGenre(bot, chatId, userId, token, username, genreKey);
}

async function handleRandomByGenre(
  bot:      TelegramBot,
  chatId:   number,
  userId:   string,
  token:    string,
  username: string | null | undefined,
  genreKey: string
): Promise<void> {
  const books    = getBooksForGenre(genreKey);
  const bookName = await pickUniqueRandom(userId, books);

  // إحصاءات الجنس
  redis.zincrby("stats:random:genres", 1, genreKey).catch(() => {});

  // الإيموجي حسب الجنس
  const genreEmoji = GENRE_LABELS[genreKey]
    ? extractEmoji(GENRE_LABELS[genreKey])
    : "🎲";

  await bot.sendMessage(chatId,
    `🎲 *كتاب مفاجأة*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `${genreEmoji} _"${escMd(bookName)}"_\n\n` +
    `_جارٍ البحث..._`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "🎲 كتاب آخر", callback_data: `rg:${genreKey}` },
          { text: "🔙 اختر التصنيف",  callback_data: "rg:menu" },
        ]],
      },
    }
  ).catch(() => {});

  L.info("random", "Random book selected", {
    genre: genreKey,
    book:  bookName.slice(0, 60),
    userId,
  });

  onSuccessfulRandom(userId).catch(() => {});
  await handleBookRequest(bot, chatId, userId, bookName, token, username);
}
