import { L } from "./logger.js";
import type { BookResult } from "./types.js";
import { normalizeArabic, normalizeForCache } from "./text.js";
import { searchAllSources } from "./engine.js";

// ══════════════════════════════════════════════
// FUZZY SEARCH — محاولات متتالية مع تنويع الاستعلام
//
// BUG FIX: حذفنا skipFirecrawl من المحاولات 2-5.
// السبب: بعد حذف الـ fallback من engine.ts، skipFirecrawl=true
// يعني engine يرجع [] دائماً → المحاولات 2-5 لا معنى لها.
//
// الحل الصح: كل variant (نص مطبَّع، أول كلمتين، إلخ) هو
// query جديد لم تجرّبه Firecrawl بعد → يستحق الكريديت.
// ══════════════════════════════════════════════

export interface FuzzyResult {
  results: BookResult[];
  usedFuzzy: boolean;
}

export async function searchWithFuzzyFallback(bookName: string): Promise<FuzzyResult> {
  // ── محاولة 1: البحث الكامل بالاسم الأصلي ──────
  const r1 = await searchAllSources(bookName);
  if (r1.length > 0) return { results: r1, usedFuzzy: false };

  // ── محاولة 2+3: normalized + أول كلمتين — بالتوازي ─────
  // M5 FIX: كانتا متسلسلتين (45 ثانية كل واحدة في أسوأ حال)
  // هما queries مستقلة تماماً → يمكن تشغيلهما معاً
  const normalized = normalizeArabic(bookName).trim();

  const stopWords = new Set([
    "في", "من", "على", "إلى", "عن", "مع", "بين", "عند", "بعد", "قبل",
    "و", "أو", "ثم", "لكن", "هذا", "هذه", "التي", "الذي",
  ]);
  const words      = bookName.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  const shortQuery = words.length >= 2 ? words.slice(0, 2).join(" ") : "";

  // BUG FIX: كان normalizedKey === originalKey دائماً لأن normalizeForCache تستدعي normalizeArabic
  // فـ normalizeForCache(normalizeArabic(x)) === normalizeForCache(x) دائماً
  // → needsNorm كان false أبداً → المحاولة 2 ميتة تماماً منذ البداية
  // الإصلاح: المقارنة المباشرة بين النص المُعيَّر والأصلي — لو اختلفا فعلاً نجرّب
  const needsNorm  = normalized.length >= 2 && normalized !== bookName;
  const needsShort = shortQuery.length >= 2 && shortQuery !== bookName;

  if (needsNorm || needsShort) {
    const tasks: Promise<BookResult[]>[] = [];
    const labels: string[] = [];

    if (needsNorm)  { tasks.push(searchAllSources(normalized));   labels.push("normalized"); }
    if (needsShort) { tasks.push(searchAllSources(shortQuery));   labels.push("2-word"); }

    const results = await Promise.all(tasks);
    for (let i = 0; i < results.length; i++) {
      if (results[i].length > 0) {
        L.info("bot", `Fuzzy: ${labels[i]} "${bookName}" → "${labels[i] === "normalized" ? normalized : shortQuery}"`);
        return { results: results[i], usedFuzzy: true };
      }
    }
  }

  // ── محاولة 4: أول كلمة واحدة ─────────────────────────────
  if (words.length >= 1) {
    const oneWord = words[0];
    if (oneWord !== bookName && oneWord.length >= 3) {
      const r4 = await searchAllSources(oneWord);
      if (r4.length > 0) {
        L.info("bot", `Fuzzy: 1-word "${bookName}" → "${oneWord}"`);
        return { results: r4, usedFuzzy: true };
      }
    }
  }

  // ── محاولة 5: تصحيح إملائي (همزات + تاء مربوطة) — sequential مع early exit ─────
  // BUG FIX: Promise.all كان يُشغّل 5 variants بالتوازي → 5 × N Firecrawl calls مرة واحدة
  // هذا يُنهك الـ quota ويُسبّب rate limiting 429 لكل المستخدمين
  // الحل: sequential مع early exit — أول نتيجة ناجحة تُوقف الباقي
  //
  // E7 FIX: حد أقصى لعدد variants = 3 (بدل 5 الكاملة)
  // مع Unified Search الجديد: كل call = 2 credits (عربي + دولي)
  // 3 variants × 2 = 6 credits إضافية في أسوأ حال — معقول جداً
  // السبب: variants الإضافية عادةً لا تُفيد لأن الهمزات والتاء
  // معالجتها في normalizeForCache → cache key واحد لكل الأشكال
  const variants = generateSpellingVariants(bookName)
    .filter((v) => v !== bookName)
    .slice(0, 3); // E7: حد أقصى 3 variants
  for (const variant of variants) {
    const r = await searchAllSources(variant);
    if (r.length > 0) {
      L.info("bot", `Fuzzy: spelling "${bookName}" → "${variant}"`);
      return { results: r, usedFuzzy: true };
    }
  }

  return { results: [], usedFuzzy: false };
}

// ══════════════════════════════════════════════
// SPELLING VARIANTS — بدائل الهمزة والتاء المربوطة
// ══════════════════════════════════════════════
export function generateSpellingVariants(text: string): string[] {
  const variants = new Set<string>();

  if (text.includes("ة")) variants.add(text.replace(/ة/g, "ه"));
  if (text.includes("ه") && !text.includes("ة")) variants.add(text.replace(/ه/g, "ة"));
  if (text.includes("ى")) variants.add(text.replace(/ى/g, "ي"));
  if (text.includes("ي") && !text.includes("ى")) variants.add(text.replace(/ي/g, "ى"));

  const hamzaForms = ["أ", "إ", "آ", "ا"];
  for (const h of hamzaForms) {
    if (text.includes(h)) {
      for (const h2 of hamzaForms) {
        if (h2 !== h) variants.add(text.replace(new RegExp(h, "g"), h2));
      }
    }
  }

  return [...variants].filter((v) => v.length >= 2).slice(0, 5);
}
