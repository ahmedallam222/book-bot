// ══════════════════════════════════════════════
// CURATED — قوائم محرَّرة + سلاسل كتب
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { normalizeArabic, escMd } from "./text.js";
import { storeRetryKey } from "./session.js";
import { BOT_NAME } from "./brand.js";

export interface CuratedList {
  id: string;
  title: string;
  blurb: string;
  emoji: string;
  books: string[];
}

export const CURATED_LISTS: CuratedList[] = [
  {
    id: "start_read",
    title: "بداية هادئة للقارئ",
    blurb: "عناوين واضحة، إيقاع لطيف، مناسبة للعودة للقراءة.",
    emoji: "🌱",
    books: [
      "الأمير الصغير",
      "العادات الذرية",
      "فن اللامبالاة",
      "الخيميائي",
      "لا تحزن",
      "مزرعة الحيوانات",
      "قوة الآن",
      "أب غني أب فقير",
    ],
  },
  {
    id: "self_power",
    title: "تطوير الذات — أساس متين",
    blurb: "كتب تُغيّر العادات والتفكير دون ضجيج تحفيزي فارغ.",
    emoji: "🚀",
    books: [
      "العادات الذرية",
      "العادات السبع للناس الأكثر فاعلية",
      "كيف تكسب الأصدقاء وتؤثر في الناس",
      "قوة العادة",
      "التفكير السريع والبطيء",
      "سيكولوجية المال",
      "نادي الخامسة صباحاً",
      "الأب الغني والأب الفقير",
    ],
  },
  {
    id: "arab_novels",
    title: "روايات عربية لا تُفوَّت",
    blurb: "من الكلاسيكي إلى المعاصر — ذوق عربي أصيل.",
    emoji: "📖",
    books: [
      "أولاد حارتنا",
      "موسم الهجرة إلى الشمال",
      "اللص والكلاب",
      "زقاق المدق",
      "الفيل الأزرق",
      "يوتوبيا",
      "عزازيل",
      "أرض زيكولا",
      "عمارة يعقوبيان",
      "ذاكرة الجسد",
    ],
  },
  {
    id: "world_classics",
    title: "كلاسيكيات عالمية",
    blurb: "أسماء خالدة تُقرأ عبر الأجيال.",
    emoji: "🏛",
    books: [
      "البؤساء",
      "الجريمة والعقاب",
      "1984",
      "مئة عام من العزلة",
      "الحرب والسلم",
      "الإخوة كارامازوف",
      "غاتسبي العظيم",
      "دون كيخوته",
      "الشيخ والبحر",
    ],
  },
  {
    id: "faith_core",
    title: "زاد إيماني وعلمي",
    blurb: "مختارات نافعة للسيرة والتهذيب والفقه الميسّر.",
    emoji: "📿",
    books: [
      "الرحيق المختوم",
      "رياض الصالحين",
      "فقه السيرة",
      "زاد المعاد",
      "حصن المسلم",
      "لا تحزن",
      "حوار مع صديقي الملحد",
      "قصص الأنبياء",
    ],
  },

  {
    id: "business_core",
    title: "مال وأعمال",
    blurb: "أساسيات التفكير المالي وبناء القيمة.",
    emoji: "💼",
    books: [
      "سيكولوجية المال",
      "أغنى رجل في بابل",
      "الأب الغني والأب الفقير",
      "أسرار عقل المليونير",
      "ابدأ بلماذا",
      "التأثير",
      "فن الحرب",
    ],
  },
  {
    id: "comfort_reads",
    title: "قراءات خفيفة وممتعة",
    blurb: "للمساء الهادئ — دون ثقل.",
    emoji: "☕",
    books: [
      "الأمير الصغير",
      "أرض زيكولا",
      "شيفرة بلال",
      "في قلبي أنثى عبرية",
      "كافكا على الشاطئ",
      "عداء الطائرة الورقية",
    ],
  },
  {
    id: "mind_science",
    title: "عقل وعلوم",
    blurb: "توسيع الأفق: كون، نفس، وتاريخ الإنسان.",
    emoji: "🔬",
    books: [
      "سابيينس",
      "مختصر تاريخ الزمن",
      "لماذا ننام",
      "لغة الجسد",
      "سيكولوجية الجماهير",
      "عالم صوفي",
      "مقدمة ابن خلدون",
    ],
  },
];

/** سلاسل: بعد قراءة X جرّب … */
export const SERIES_MAP: { keys: string[]; next: string[] }[] = [
  {
    keys: ["العادات الذرية", "atomic habits"],
    next: ["قوة العادة", "العادات السبع للناس الأكثر فاعلية", "العمق"],
  },
  {
    keys: ["فن اللامبالاة"],
    next: ["كل شيء عن الحب", "قوة الآن", "لا تهتم بصغائر الأمور"],
  },
  {
    keys: ["كيف تكسب الأصدقاء", "كيف تكسب الاصدقاء"],
    next: ["التأثير", "قواعد السطوة", "لغة الجسد"],
  },
  {
    keys: ["الأب الغني", "اب غني", "أبي الغني"],
    next: ["سيكولوجية المال", "أغنى رجل في بابل", "أسرار عقل المليونير"],
  },
  {
    keys: ["الخيميائي"],
    next: ["الأمير الصغير", "قواعد العشق الأربعون", "على قهوة سادة"],
  },
  {
    keys: ["1984", "مزرعة الحيوانات"],
    next: ["Brave New World", "حكاية خادمة", "العمى"],
  },
  {
    keys: ["الجريمة والعقاب", "الإخوة كارامازوف", "الاخوة كرامازوف"],
    next: ["الأبله", "المقامر", "مذكرات قبو"],
  },
  {
    keys: ["أولاد حارتنا", "اللص والكلاب", "زقاق المدق"],
    next: ["الثلاثية", "الحرافيش", "بين القصرين"],
  },
  {
    keys: ["الفيل الأزرق", "تراب الماس"],
    next: ["فيرتيجو", "أرض الإله", "المجهول"],
  },
  {
    keys: ["الرحيق المختوم"],
    next: ["فقه السيرة", "زاد المعاد", "نور اليقين"],
  },
  {
    keys: ["مقدمة ابن خلدون"],
    next: ["سابيينس", "قصة الحضارة", "تاريخ الطبري"],
  },
];

export function getCuratedList(id: string): CuratedList | undefined {
  return CURATED_LISTS.find((l) => l.id === id);
}

export function seriesAfter(bookName: string, limit = 3): string[] {
  const n = normalizeArabic(bookName).toLowerCase();
  for (const s of SERIES_MAP) {
    if (s.keys.some((k) => n.includes(normalizeArabic(k).toLowerCase()) || normalizeArabic(k).toLowerCase().includes(n.slice(0, 8)))) {
      return s.next.slice(0, limit);
    }
  }
  return [];
}

export function buildCuratedMenuMessage(): string {
  const lines = CURATED_LISTS.map(
    (l, i) => `${i + 1}. ${l.emoji} *${escMd(l.title)}* — _${escMd(l.blurb.slice(0, 50))}_`,
  ).join("\n");
  return (
    `📖 *قوائم ${BOT_NAME} المختارة*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `مجموعات كتب منتقاة بعناية — اضغط قائمة ثم حمّل أي عنوان.\n\n` +
    `${lines}\n\n` +
    `_ليست إعلاناً · اختيارات للقراءة على مهل_`
  );
}

export function kbCuratedMenu(): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < CURATED_LISTS.length; i += 2) {
    const a = CURATED_LISTS[i];
    const row: TelegramBot.InlineKeyboardButton[] = [
      { text: `${a.emoji} ${a.title.slice(0, 18)}`, callback_data: `clist:${a.id}` },
    ];
    if (CURATED_LISTS[i + 1]) {
      const b = CURATED_LISTS[i + 1];
      row.push({
        text: `${b.emoji} ${b.title.slice(0, 18)}`,
        callback_data: `clist:${b.id}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "🏠  الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

export function buildCuratedListMessage(list: CuratedList): string {
  const books = list.books
    .map((b, i) => `${i + 1}. ${escMd(b)}`)
    .join("\n");
  return (
    `${list.emoji} *${escMd(list.title)}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `_${escMd(list.blurb)}_\n\n` +
    `${books}\n\n` +
    `_اضغط عنواناً بالأسفل للبحث والتحميل._`
  );
}

export function kbCuratedList(list: CuratedList): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (const b of list.books.slice(0, 10)) {
    const k = storeRetryKey(b);
    const label = b.length > 32 ? b.slice(0, 31) + "…" : b;
    rows.push([{ text: `📥  ${label}`, callback_data: `retry:${k}` }]);
  }
  rows.push([
    { text: "📖  كل القوائم", callback_data: "curated_menu" },
    { text: "🏠  الرئيسية", callback_data: "main_menu" },
  ]);
  return { inline_keyboard: rows };
}

export function buildSeriesMessage(bookName: string, next: string[]): string {
  if (next.length === 0) {
    return (
      `✨ *سلسلة مقترحة*\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `_لا سلسلة محفوظة لهذا العنوان بعد._\n` +
      `جرّب القوائم المختارة: /lists`
    );
  }
  const lines = next.map((b, i) => `${i + 1}. ${escMd(b)}`).join("\n");
  return (
    `✨ *بعد «${escMd(bookName.slice(0, 40))}»*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `اقتراحات مكملة لنفس المسار:\n${lines}\n\n` +
    `_اضغط للتحميل مباشرةً._`
  );
}

export function kbSeries(next: string[]): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = next.slice(0, 4).map((b) => {
    const k = storeRetryKey(b);
    const label = b.length > 34 ? b.slice(0, 33) + "…" : b;
    return [{ text: `📥  ${label}`, callback_data: `retry:${k}` }];
  });
  rows.push([
    { text: "📖  قوائم مختارة", callback_data: "curated_menu" },
    { text: "🏠  الرئيسية", callback_data: "main_menu" },
  ]);
  return { inline_keyboard: rows };
}
