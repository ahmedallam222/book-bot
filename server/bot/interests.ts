// ══════════════════════════════════════════════
// INTERESTS — ذوق القارئ (تعلّم صامت)
//
// كل تحميل ناجح يعزّز تصنيفاً. يُستخدم في:
//   • كتاب اليوم · المفاجأة · الاقتراحات بعد التسليم
//   • عرض «ذوقك» في الملف الشخصي
// ══════════════════════════════════════════════

import { redis } from "./redis.js";
import { normalizeArabic } from "./text.js";
import { GENRE_MAP } from "./suggestions.js";

const KEY = (uid: string) => `ret:interest:${uid}`;

/** مفاتيح تصنيف ودّية بالعربية */
export const GENRE_LABELS: Record<string, string> = {
  novel:    "روايات وأدب",
  selfhelp: "تطوير الذات",
  religion: "دين وسيرة",
  history:  "تاريخ وسِيَر",
  science:  "علوم ومعرفة",
  psych:    "علم نفس",
  philosophy: "فلسفة",
  poetry:   "شعر",
  other:    "متنوّع",
};

const KEYWORD_TO_GENRE: { re: RegExp; id: string }[] = [
  { re: /رواية|قصة|أدب|novel|fiction|محفوظ|دوستوي|ماركيز|أورويل/i, id: "novel" },
  { re: /تطوير|عادات|نجاح|ذات|تحفيز|إنتاج|كاريجي|مانسون|كلير/i, id: "selfhelp" },
  { re: /دين|إسلام|فقه|سيرة|قرآن|حديث|نووي|قرني|ابن القيم|مباركفور/i, id: "religion" },
  { re: /تاريخ|سيرة|ابن خلدون|هراري|بطوطة|سياسة/i, id: "history" },
  { re: /علم|كون|فيزياء|فضاء|طب|بيول|هوكينغ|ساغان/i, id: "science" },
  { re: /نفس|سيكول|حب|زواج|علاقات|جولمان/i, id: "psych" },
  { re: /فلسف|وجود|كامو|سارتر|أفلاطون|نيتش/i, id: "philosophy" },
  { re: /شعر|ديوان|متنبي|درويش|قباني|بلاغة/i, id: "poetry" },
];

/** يستنتج تصنيفاً من عنوان كتاب */
export function inferGenre(bookName: string): string {
  const n = normalizeArabic(bookName);
  for (const { re, id } of KEYWORD_TO_GENRE) {
    if (re.test(n) || re.test(bookName)) return id;
  }
  // مطابقة مع GENRE_MAP
  const nl = n.toLowerCase();
  for (const [pattern, books] of Object.entries(GENRE_MAP)) {
    for (const b of books) {
      const bn = normalizeArabic(b).toLowerCase();
      if (bn.includes(nl.slice(0, Math.min(12, nl.length))) || nl.includes(bn.slice(0, 8))) {
        if (/رواية|قصة|fiction|novel|أدب/i.test(pattern)) return "novel";
        if (/تطوير|نجاح|عادات|self/i.test(pattern)) return "selfhelp";
        if (/دين|إسلام|فقه/i.test(pattern)) return "religion";
        if (/تاريخ/i.test(pattern)) return "history";
        if (/علم|نفس/i.test(pattern)) return /نفس/.test(pattern) ? "psych" : "science";
        if (/فلسف/i.test(pattern)) return "philosophy";
        if (/شعر/i.test(pattern)) return "poetry";
      }
    }
  }
  return "other";
}

export async function recordInterest(userId: string, bookName: string, weight = 1): Promise<void> {
  const genre = inferGenre(bookName);
  try {
    await redis.zincrby(KEY(userId), weight, genre);
    await redis.expire(KEY(userId), 400 * 86400);
  } catch { /* fail-open */ }
}

/** تسجيل صريح من onboarding */
export async function setInterestBoost(userId: string, genreId: string, amount = 5): Promise<void> {
  try {
    await redis.zincrby(KEY(userId), amount, genreId);
    await redis.expire(KEY(userId), 400 * 86400);
    await redis.set(`ret:onboarded:${userId}`, "1", "EX", 400 * 86400);
  } catch { /* */ }
}

export async function isOnboarded(userId: string): Promise<boolean> {
  try {
    return (await redis.get(`ret:onboarded:${userId}`)) === "1";
  } catch {
    return false;
  }
}

export async function getTopInterests(
  userId: string,
  limit = 3,
): Promise<{ id: string; label: string; score: number }[]> {
  try {
    const rows = await redis.zrevrange(KEY(userId), 0, limit - 1, "WITHSCORES");
    const out: { id: string; label: string; score: number }[] = [];
    for (let i = 0; i < rows.length; i += 2) {
      const id = rows[i];
      const score = parseFloat(rows[i + 1] || "0") || 0;
      if (score <= 0) continue;
      out.push({ id, label: GENRE_LABELS[id] || id, score });
    }
    return out;
  } catch {
    return [];
  }
}

export async function getPrimaryGenre(userId: string): Promise<string | null> {
  const top = await getTopInterests(userId, 1);
  return top[0]?.id ?? null;
}

/** سطر ودّي للملف الشخصي */
export async function buildInterestProfileLine(userId: string): Promise<string> {
  const top = await getTopInterests(userId, 3);
  if (top.length === 0) {
    return `🎭 *ذوقك:* لم يتضح بعد — حمّل كتباً أو اختر اهتماماً من الترحيب`;
  }
  const parts = top.map((t) => t.label).join(" · ");
  return `🎭 *ذوقك القرائي:* ${parts}`;
}

/** كتب من التصنيفات المفضّلة */
export function booksForGenreId(genreId: string): string[] {
  const patterns: Record<string, RegExp> = {
    novel: /رواية|قصة|fiction|novel|أدب/i,
    selfhelp: /تطوير|نجاح|عادات|self/i,
    religion: /دين|إسلام|فقه|سيرة/i,
    history: /تاريخ/i,
    science: /علم|كون|فيزياء/i,
    psych: /نفس/i,
    philosophy: /فلسف/i,
    poetry: /شعر/i,
  };
  const re = patterns[genreId];
  if (!re) return [];
  const out: string[] = [];
  for (const [pattern, books] of Object.entries(GENRE_MAP)) {
    if (re.test(pattern)) out.push(...books);
  }
  return out;
}
