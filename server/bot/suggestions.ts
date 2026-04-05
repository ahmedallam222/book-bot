import { L } from "./logger.js";
import { normalizeArabic } from "./text.js";
import { searchAllSources, getSearchCacheResults } from "./engine.js";

// ══════════════════════════════════════════════
// SUGGESTIONS + CACHE WARMING
// ══════════════════════════════════════════════

export const GENRE_MAP: Record<string, string[]> = {
  "رواية|قصة|fiction|novel|story":           ["الأمير الصغير", "أرض زيكولا", "البؤساء", "مئة عام من العزلة", "1984"],
  "تطوير|نجاح|عادات|إنتاج|self.help|habits": ["العادات الذرية", "فن اللامبالاة", "قوة العادة", "عقلية النمو"],
  "تاريخ|سيرة|حياة|history|biography":       ["رحلة ابن بطوطة", "مختصر تاريخ الزمن", "عمر المختار", "صلاح الدين"],
  "علم|فيزياء|رياضيات|science|physics|math":  ["مختصر تاريخ الزمن", "عالم صوفي", "من نحن", "الكون في قشرة جوز"],
  "دين|إسلام|فقه|religion|islamic":           ["الرحيق المختوم", "فقه السيرة", "إحياء علوم الدين", "البداية والنهاية"],
  "فلسفة|تفكير|منطق|philosophy|thinking":     ["عالم صوفي", "الوجودية", "مقدمة إلى الفلسفة", "كيف تقرأ كتاباً"],
  "اقتصاد|مال|أعمال|business|economics":      ["أب غني أب فقير", "التفكير السريع والبطيء", "نقطة الانعطاف"],
  "نفس|اجتماع|psychology|social":             ["قوة التفكير الإيجابي", "لغة الجسد", "التلاعب بالعقول"],
};

export const SUGGESTIONS = [
  "الأمير الصغير — أنطوان دو سانت إكزوبيري",
  "فن اللامبالاة — مارك مانسون",
  "1984 — جورج أورويل",
  "الخيميائي — باولو كويلو",
  "العادات الذرية — جيمس كلير",
  "أرض زيكولا — عمرو عبد الحميد",
  "البؤساء — فيكتور هوغو",
  "حوار مع صديقي الملحد — إياد قنيبي",
  "مئة عام من العزلة — غابرييل غارسيا ماركيز",
  "رحلة ابن بطوطة",
];

// ملاحظة: getRelatedSuggestion() حُذفت — لم تُستدعَ من أي مكان
// warmRelatedCache() هي الوظيفة الفعلية المُستخدَمة من bookRequest.ts

/**
 * يسبق طلبات المستخدمين بتحميل كتب من نفس النوع في الـ cache.
 * fire-and-forget — لا await خارجياً.
 */
export async function warmRelatedCache(bookName: string): Promise<void> {
  const norm = normalizeArabic(bookName);
  for (const [keys, books] of Object.entries(GENRE_MAP)) {
    if (keys.split("|").some((k) => norm.includes(normalizeArabic(k)))) {
      // ✅ FIX: getSearchCacheResults الآن async
      const cacheChecks = await Promise.all(books.map((b) => getSearchCacheResults(b)));
      const toWarm = books
        .filter((_, i) => cacheChecks[i].length === 0)
        .slice(0, 2);
      toWarm.forEach((b, i) => {
        setTimeout(() => {
          searchAllSources(b).catch(() => {});
          L.info("bot", `Cache warming: "${b}"`);
        }, i * 4000);
      });
      break;
    }
  }
}
