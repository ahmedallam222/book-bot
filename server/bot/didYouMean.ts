// ══════════════════════════════════════════════
// هل تقصد…؟ — اقتراحات ذكية عند فشل/غموض البحث
//
// 1) تصحيح أخطاء إملائية شائعة (COMMON_FIXES)
// 2) تشابه مع كتالوج رفيق (SUGGESTIONS + GENRE_MAP)
// 3) دمج مع اقتراحات Llama إن وُجدت
//
// النتيجة: أزرار قابلة للضغط (callback retry:key)
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { normalizeArabic, escMd } from "./text.js";
import { SUGGESTIONS, GENRE_MAP } from "./suggestions.js";
import { storeRetryKey } from "./session.js";
import { getLlamaSuggestions } from "./aiProviders/llamaSuggestions.js";
import { buildNoResults } from "./ui.js";

// أخطاء شائعة — منسوخة/موسَّعة من fuzzy.ts
const COMMON_FIXES: Record<string, string> = {
  "الخميائي": "الخيميائي",
  "الخيمائي": "الخيميائي",
  "يوتبيا": "يوتوبيا",
  "يتوبيا": "يوتوبيا",
  "فهرنهيت": "فهرنهايت",
  "١٩٨٤": "1984",
  "مائة عام": "مئة عام من العزلة",
  "فرانكشتاين": "فرانكنشتاين",
  "فرنكشتاين": "فرانكنشتاين",
  "البؤسا": "البؤساء",
  "دوستيفيسكي": "دوستويفسكي",
  "دستيوفسكي": "دوستويفسكي",
  "الامير الصغير": "الأمير الصغير",
  "امير الصغير": "الأمير الصغير",
  "ألف ليلة": "ألف ليلة وليلة",
  "ألف ليله": "ألف ليلة وليلة",
  "كيف تكسب": "كيف تكسب الأصدقاء وتؤثر في الناس",
  "كيف تكسب الاصدقاء": "كيف تكسب الأصدقاء وتؤثر في الناس",
  "العادات السبع": "العادات السبع للناس الأكثر فاعلية",
  "7 عادات": "العادات السبع للناس الأكثر فاعلية",
  "ابي الغني": "الأب الغني والأب الفقير",
  "ابي الفقير": "الأب الغني والأب الفقير",
  "العادت الذرية": "العادات الذرية",
  "اتوميك هابيتس": "العادات الذرية",
  "دون كيشوت": "دون كيخوته",
  "الجريمه والعقاب": "الجريمة والعقاب",
  "الاخوة كرامازوف": "الإخوة كارامازوف",
  "الاخوه كرامازوف": "الإخوة كارامازوف",
  "الرحيق المحتوم": "الرحيق المختوم",
  "الرحيق المختون": "الرحيق المختوم",
  "مقدمه ابن خلدون": "مقدمة ابن خلدون",
  "فن اللامبالاه": "فن اللامبالاة",
  "فن اللامبلاه": "فن اللامبالاة",
  "ارض زيكولا": "أرض زيكولا",
  "ارض زكولا": "أرض زيكولا",
};

function cleanTitle(raw: string): string {
  return (raw.split(/\s*[—–-]\s*/)[0] || raw).trim().slice(0, 100);
}

let _catalog: string[] | null = null;
function catalog(): string[] {
  if (_catalog) return _catalog;
  const set = new Set<string>();
  for (const s of SUGGESTIONS) set.add(cleanTitle(s));
  for (const books of Object.values(GENRE_MAP)) {
    for (const b of books) set.add(cleanTitle(b));
  }
  _catalog = [...set].filter((t) => t.length >= 2);
  return _catalog;
}

function norm(s: string): string {
  return normalizeArabic(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/** تشابه بسيط: تداخل كلمات + احتواء */
function scoreMatch(query: string, candidate: string): number {
  const q = norm(query);
  const c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) return 85;
  const qw = q.split(" ").filter((w) => w.length > 1);
  const cw = new Set(c.split(" ").filter((w) => w.length > 1));
  if (qw.length === 0) return 0;
  let hit = 0;
  for (const w of qw) {
    if (cw.has(w)) hit += 2;
    else {
      for (const x of cw) {
        if (x.includes(w) || w.includes(x)) {
          hit += 1;
          break;
        }
      }
    }
  }
  const ratio = hit / (qw.length * 2);
  // prefix bonus
  const prefix = c.startsWith(q.slice(0, Math.min(4, q.length))) ? 0.15 : 0;
  return Math.round((ratio + prefix) * 100);
}

function applyCommonFix(query: string): string | null {
  const n = norm(query);
  // exact key
  for (const [wrong, right] of Object.entries(COMMON_FIXES)) {
    if (norm(wrong) === n) return right;
  }
  // contains
  for (const [wrong, right] of Object.entries(COMMON_FIXES)) {
    if (n.includes(norm(wrong)) && norm(wrong).length >= 4) return right;
  }
  return null;
}

export interface DidYouMeanResult {
  /** عناوين مقترحة (مرتّبة) */
  suggestions: string[];
  /** تصحيح إملائي مباشر إن وُجد */
  spellingFix: string | null;
}

/**
 * اقتراحات محلية سريعة (بدون شبكة)
 */
export function localDidYouMean(query: string, limit = 4): DidYouMeanResult {
  const spellingFix = applyCommonFix(query);
  const scored: { t: string; s: number }[] = [];
  const seen = new Set<string>();

  if (spellingFix) {
    seen.add(norm(spellingFix));
  }

  for (const title of catalog()) {
    const s = scoreMatch(query, title);
    if (s < 35) continue;
    const k = norm(title);
    if (seen.has(k)) continue;
    // لا نقترح نفس الاستعلام
    if (k === norm(query)) continue;
    seen.add(k);
    scored.push({ t: title, s });
  }

  scored.sort((a, b) => b.s - a.s);
  const suggestions: string[] = [];
  if (spellingFix) suggestions.push(cleanTitle(spellingFix));
  for (const x of scored) {
    if (suggestions.length >= limit) break;
    if (norm(x.t) === norm(spellingFix || "")) continue;
    suggestions.push(x.t);
  }
  return { suggestions, spellingFix };
}

/**
 * محلي + Llama (اختياري) — للإرسال عند لا نتائج
 */
export async function resolveDidYouMean(query: string, limit = 4): Promise<string[]> {
  const local = localDidYouMean(query, limit);
  const out = [...local.suggestions];
  const seen = new Set(out.map(norm));

  if (out.length < limit) {
    const llama = await getLlamaSuggestions(query).catch(() => [] as string[]);
    for (const s of llama) {
      const t = cleanTitle(s);
      if (t.length < 2) continue;
      const k = norm(t);
      if (seen.has(k) || k === norm(query)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= limit) break;
    }
  }
  return out.slice(0, limit);
}

/** لوحة أزرار: كل اقتراح → retry:session */
export function kbDidYouMean(
  bookName: string,
  suggestions: string[],
): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  for (const s of suggestions.slice(0, 4)) {
    const key = storeRetryKey(s);
    const label = s.length > 28 ? s.slice(0, 27) + "…" : s;
    rows.push([{ text: `📖  ${label}`, callback_data: `retry:${key}` }]);
  }

  const retryK = storeRetryKey(bookName);
  rows.push([
    { text: "🔁  أعد المحاولة", callback_data: `retry:${retryK}` },
    { text: "🎲  كتاب مفاجأة", callback_data: "rg:any" },
  ]);
  rows.push([
    { text: "🔍  عنوان مختلف", callback_data: "new_search" },
    { text: "🏠  الرئيسية", callback_data: "main_menu" },
  ]);
  return { inline_keyboard: rows };
}

/** رسالة فشل بحث + قسم هل تقصد */
export async function buildDidYouMeanMessage(
  bookName: string,
  apologetic = false,
): Promise<{ text: string; suggestions: string[] }> {
  const suggestions = await resolveDidYouMean(bookName, 4);
  const base = buildNoResults(bookName, false, apologetic);

  if (suggestions.length === 0) {
    return { text: base, suggestions: [] };
  }

  const local = localDidYouMean(bookName, 4);
  const header = local.spellingFix
    ? `✏️ *هل تقصد:* «${escMd(local.spellingFix)}»؟`
    : `💡 *هل تقصد أحد هذه العناوين؟*`;

  const lines = suggestions
    .map((s, i) => `${i + 1}. ${escMd(s)}`)
    .join("\n");

  const text =
    base +
    `\n\n` +
    `${header}\n` +
    `${lines}\n\n` +
    `_اضغط الزر المطابق أدناه للبحث مباشرةً._`;

  return { text, suggestions };
}
