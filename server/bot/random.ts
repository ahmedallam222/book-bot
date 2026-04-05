import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { normalizeArabic, escMd } from "./text.js";
import { handleBookRequest } from "./bookRequest.js";

// ══════════════════════════════════════════════
// /random — كتاب عشوائي من نوع أدبي محدد
//
// الاستخدام:
//   /random            → كتاب عشوائي من أي نوع
//   /random رواية      → رواية عشوائية
//   /random تطوير      → كتاب تطوير ذات عشوائي
//   /random دين        → كتاب إسلامي عشوائي
// ══════════════════════════════════════════════

// ── تعريف الأنواع الأدبية ─────────────────────────────────────
// كل نوع: label (للعرض) + keywords (للكشف) + قائمة كتب موسّعة
export interface Genre {
  label:    string;   // اسم النوع العربي للعرض
  emoji:    string;
  keywords: string[]; // كلمات مفتاحية عربية وإنجليزية للكشف
  books:    string[]; // قائمة كتب متنوعة
}

export const GENRES: Genre[] = [
  {
    label: "رواية وقصة",
    emoji: "📖",
    keywords: ["رواية", "قصة", "fiction", "novel", "story", "روايات"],
    books: [
      "الأمير الصغير", "أرض زيكولا", "البؤساء", "مئة عام من العزلة",
      "1984", "الخيميائي", "عزازيل", "ذهب مع الريح", "الجريمة والعقاب",
      "موبي ديك", "شيفرة دافنشي", "رجل من الشرق", "بائعة الورد",
      "في قلب الليل", "ألف شمس مشرقة", "عقد اللؤلؤ", "ليلة القدر",
    ],
  },
  {
    label: "تطوير الذات",
    emoji: "🚀",
    keywords: ["تطوير", "نجاح", "عادات", "إنتاج", "self help", "habits", "تحفيز", "ذات"],
    books: [
      "العادات الذرية", "فن اللامبالاة", "قوة العادة", "عقلية النمو",
      "الأب الغني والأب الفقير", "فكر وازدد ثراء", "قوة اللاوعي",
      "رسائل إلى لوسيليوس", "كيف تكسب الأصدقاء", "السر",
      "اليقظة الذهنية", "قوة التفكير الإيجابي", "الإنسان باحث عن المعنى",
    ],
  },
  {
    label: "التاريخ والسيرة",
    emoji: "🏛️",
    keywords: ["تاريخ", "سيرة", "حياة", "history", "biography", "تراجم", "شخصية"],
    books: [
      "رحلة ابن بطوطة", "مختصر تاريخ الزمن", "عمر المختار", "صلاح الدين الأيوبي",
      "نابليون", "ستيف جوبز", "مذكرات هيلاري كلينتون", "سيرة ابن خلدون",
      "قصة الحضارة", "الإسلام والغرب", "حياة المسلمين في الأندلس",
      "سيرة خاتم الأنبياء", "مالك بن نبي", "البيروني",
    ],
  },
  {
    label: "العلوم والمعرفة",
    emoji: "🔬",
    keywords: ["علم", "فيزياء", "رياضيات", "science", "physics", "math", "biology", "أحياء", "كيمياء", "فلك"],
    books: [
      "مختصر تاريخ الزمن", "عالم صوفي", "من نحن", "الكون في قشرة جوز",
      "نقطة الانعطاف الصغيرة", "الجينوم البشري", "الكوزموس",
      "عبقرية اينشتاين", "تاريخ الكيمياء", "الفيزياء النظرية للمبتدئين",
      "الرياضيات اللغة العالمية", "أصل الأنواع", "موجز تاريخ العلم",
    ],
  },
  {
    label: "الدين والروحانيات",
    emoji: "☪️",
    keywords: ["دين", "إسلام", "فقه", "religion", "islamic", "قرآن", "حديث", "عقيدة", "تفسير"],
    books: [
      "الرحيق المختوم", "فقه السيرة", "إحياء علوم الدين",
      "البداية والنهاية", "تفسير ابن كثير", "رياض الصالحين",
      "المستدرك على الصحيحين", "الأذكار النووية", "حلية الأولياء",
      "الموافقات للشاطبي", "التبيان في آداب حملة القرآن",
    ],
  },
  {
    label: "الفلسفة والفكر",
    emoji: "💭",
    keywords: ["فلسفة", "تفكير", "منطق", "philosophy", "thinking", "فكر", "نقد", "أخلاق"],
    books: [
      "عالم صوفي", "الوجودية", "مقدمة إلى الفلسفة", "كيف تقرأ كتاباً",
      "إيثيقا سبينوزا", "الجمهورية لأفلاطون", "ما فوق الخير والشر",
      "فلسفة الحياة اليومية", "نقد العقل الخالص", "تأملات ديكارت",
      "المقدمة لابن خلدون", "طوبى الفارابي", "كتاب الشفاء لابن سينا",
    ],
  },
  {
    label: "الاقتصاد والأعمال",
    emoji: "💼",
    keywords: ["اقتصاد", "مال", "أعمال", "business", "economics", "ريادة", "استثمار", "تسويق"],
    books: [
      "أب غني أب فقير", "التفكير السريع والبطيء", "من أخذ قطعة الجبن",
      "الشركة ناجحة", "الابتكار وريادة الأعمال", "ثروة الأمم",
      "مبادئ الاقتصاد", "عقلية المليونير", "قانون النجاح",
      "فن الحرب في الأعمال", "استراتيجية المحيط الأزرق",
    ],
  },
  {
    label: "علم النفس والاجتماع",
    emoji: "🧠",
    keywords: ["نفس", "اجتماع", "psychology", "social", "سلوك", "علاج", "نفسي", "مجتمع"],
    books: [
      "قوة التفكير الإيجابي", "لغة الجسد", "التلاعب بالعقول",
      "التحليل النفسي", "علم النفس الاجتماعي", "ذكاؤك العاطفي",
      "الإنسان والتحليل النفسي فرويد", "مبادئ علم النفس",
      "الشخصية السيكوباتية", "اضطرابات الشخصية",
      "علم النفس الإيجابي", "التعلم والذاكرة",
    ],
  },
];

// ── تطابق النوع من النص ───────────────────────────────────────
export function detectGenre(input: string): Genre | null {
  if (!input.trim()) return null;
  const norm = normalizeArabic(input.toLowerCase());
  for (const genre of GENRES) {
    if (genre.keywords.some((k) => norm.includes(normalizeArabic(k)))) {
      return genre;
    }
  }
  return null;
}

/** اختر كتاباً عشوائياً من قائمة — يتجنب آخر كتاب طُلب */
function pickRandom(books: string[], avoid?: string): string {
  const candidates = avoid
    ? books.filter((b) => normalizeArabic(b) !== normalizeArabic(avoid))
    : books;
  const pool = candidates.length > 0 ? candidates : books;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── buildGenreListMessage ─────────────────────────────────────
export function buildGenreListMessage(): string {
  let msg = `🎲 *أمر /random — كتاب مفاجأة!*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n`;
  msg += `_اكتب اسم النوع الأدبي الذي تريده:_\n\n`;
  for (const g of GENRES) {
    msg += `${g.emoji} \`/random ${g.keywords[0]}\`  — *${g.label}*\n`;
  }
  msg += `\n_أو فقط_ \`/random\` _لكتاب عشوائي من أي نوع_ 🎯`;
  return msg;
}

// ── Handler الرئيسي ──────────────────────────────────────────
export async function handleRandomCommand(
  bot: TelegramBot,
  chatId: number,
  userId: string,
  token: string,
  username: string | undefined,
  genreInput: string,
  lastBook?: string
): Promise<void> {
  // /random بدون نوع → اختر نوعاً عشوائياً
  let genre: Genre | null = detectGenre(genreInput);

  if (!genre) {
    if (genreInput.trim()) {
      // كتب نوع غير معروف — أظهر القائمة
      await bot.sendMessage(
        chatId,
        `❓ لم أتعرف على النوع *"${escMd(genreInput.slice(0, 30))}"*\n\n${buildGenreListMessage()}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }
    // عشوائي تام
    genre = GENRES[Math.floor(Math.random() * GENRES.length)];
  }

  const bookName = pickRandom(genre.books, lastBook);

  await bot.sendMessage(
    chatId,
    `${genre.emoji} *${genre.label}* — اخترت لك:\n\n` +
    `📚 _${escMd(bookName)}_\n\n` +
    `🔍 أبحث عنه الآن...`,
    { parse_mode: "Markdown" }
  ).catch(() => {});

  L.info("bot", `/random → genre=${genre.label}, book="${bookName}"`, { userId });

  await handleBookRequest(bot, chatId, userId, bookName, token, username);
}
