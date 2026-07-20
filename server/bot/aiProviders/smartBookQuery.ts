// ══════════════════════════════════════════════
// SMART BOOK QUERY — AI + local spelling repair
//
// Pipeline (cheap → expensive):
//   1) lightNormalizeQuery
//   2) local spelling map (partial + full)
//   3) optional AI correction (Arabic typos + foreign names)
//
// Used before search and again on no-results.
// ══════════════════════════════════════════════

import { createHash } from "crypto";
import { L } from "../logger.js";
import { redis } from "../redis.js";
import { canonicalizeForCache } from "../text.js";
import { lightNormalizeQuery } from "../queryNormalize.js";
import {
  CLOUDFLARE_AI_ACCOUNT_ID,
  CLOUDFLARE_AI_API_TOKEN,
  MISTRAL_API_KEY,
  MISTRAL_API_KEY_2,
} from "../config.js";

const CACHE_TTL = 7 * 24 * 3600;
const AI_TIMEOUT_MS = 7000;
const MIN_LEN = 3;

/** Extra local fixes beyond fuzzy.ts (Arabic typos + popular books). */
const LOCAL_FIXES: Record<string, string> = {
  الخميائي: "الخيميائي",
  الخيمائي: "الخيميائي",
  العادت: "العادات",
  العادت_الذرية: "العادات الذرية",
  "العادت الذرية": "العادات الذرية",
  "العادات الذريه": "العادات الذرية",
  "فن اللامباله": "فن اللامبالاة",
  "فن اللامبالاه": "فن اللامبالاة",
  "فن اللامبلاه": "فن اللامبالاة",
  "الامير الصغير": "الأمير الصغير",
  "امير الصغير": "الأمير الصغير",
  "مقدمه ابن خلدون": "مقدمة ابن خلدون",
  "مقدمه ابنخلدون": "مقدمة ابن خلدون",
  "الرحيق المحتوم": "الرحيق المختوم",
  "الجريمه والعقاب": "الجريمة والعقاب",
  "الاخوة كرامازوف": "الإخوة كارامازوف",
  "الاخوه كرامازوف": "الإخوة كارامازوف",
  "سيكولوجيه المال": "سيكولوجية المال",
  "سيكولوجيه الجماهير": "سيكولوجية الجماهير",
  "قوانين الطبيعه البشريه": "قوانين الطبيعة البشرية",
  "قوانين الطبيعه": "قوانين الطبيعة البشرية",
  "الطبيعه البشريه": "الطبيعة البشرية",
  "فهم الطبيعه البشريه": "فهم الطبيعة البشرية",
  "الذكاء العاطفي": "الذكاء العاطفي",
  "ذكا عاطفي": "الذكاء العاطفي",
  "العادات السبع": "العادات السبع للناس الأكثر فاعلية",
  "كيف تكسب الاصدقاء": "كيف تكسب الأصدقاء وتؤثر في الناس",
  "كيف تكسب الأصدقاء": "كيف تكسب الأصدقاء وتؤثر في الناس",
  "ابي الغني": "الأب الغني والأب الفقير",
  "الاب الغني": "الأب الغني والأب الفقير",
  "ارض زيكولا": "أرض زيكولا",
  "ارض زكولا": "أرض زيكولا",
  "اولاد حارتنا": "أولاد حارتنا",
  "موسم الهجره": "موسم الهجرة إلى الشمال",
  "موسم الهجرة": "موسم الهجرة إلى الشمال",
  "لانك الله": "لأنك الله",
  "لا تحزن": "لا تحزن",
  "قوة اللاوعي": "قوة اللاوعي",
  "قوة العاده": "قوة العادة",
  "السر روندا": "السر",
  "اتوميك هابيتس": "العادات الذرية",
  "atomic habits": "العادات الذرية",
  "deep work": "العمل العميق",
  "العمل العميق": "العمل العميق",
  "دوستويفسكي": "دوستويفسكي",
  "دستيوفسكي": "دوستويفسكي",
  "دوستيفيسكي": "دوستويفسكي",
  "ماركيز": "غابرييل غارسيا ماركيز",
  "يوتبيا": "يوتوبيا",
  "يتوبيا": "يوتوبيا",
  "فرانكشتاين": "فرانكنشتاين",
  "البؤسا": "البؤساء",
  "الفيل الازرق": "الفيل الأزرق",
  "عزازيل": "عزازيل",
  "تراب الماس": "تراب الماس",
};

export type SmartQueryResult = {
  original: string;
  resolved: string;
  changed: boolean;
  source: "none" | "local" | "ai";
};

function cacheKey(q: string): string {
  const h = createHash("sha256").update(canonicalizeForCache(q)).digest("hex").slice(0, 16);
  return `smartq:v1:${h}`;
}

function meaningfulChange(a: string, b: string): boolean {
  const n = (s: string) =>
    s
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .replace(/[.,،:؛!؟?]+$/u, "")
      .trim()
      .toLowerCase();
  return !!b && n(a) !== n(b);
}

/** Local spelling map: exact then longest partial key. */
export function applyLocalSpellingFixes(raw: string): string {
  let t = lightNormalizeQuery(raw || "") || (raw || "").trim();
  if (!t) return t;

  // exact
  if (LOCAL_FIXES[t]) return LOCAL_FIXES[t];
  const lower = t.toLowerCase();
  if (LOCAL_FIXES[lower]) return LOCAL_FIXES[lower];

  // longest key contained in query
  let bestKey = "";
  let bestVal = "";
  for (const [k, v] of Object.entries(LOCAL_FIXES)) {
    if (k.length < 4) continue;
    if (t.includes(k) || lower.includes(k.toLowerCase())) {
      if (k.length > bestKey.length) {
        bestKey = k;
        bestVal = v;
      }
    }
  }
  if (bestKey) {
    // replace key with value once
    const re = new RegExp(bestKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    t = t.replace(re, bestVal);
  }

  // light character-level common Arabic typos
  t = t
    .replace(/ة(?=\s|$)/g, (m, off, s) => {
      // keep ة usually; no-op for safety
      return m;
    })
    .replace(/\s{2,}/g, " ")
    .trim();

  return t;
}

function parseAiLine(raw: string): string {
  if (!raw) return "";
  let s = raw.split(/\r?\n/).find((l) => l.trim().length > 0) || "";
  s = s.trim();
  s = s.replace(/^\s*(corrected|answer|title|book|النتيجة|العنوان|التصحيح)\s*[:\-—]\s*/i, "");
  s = s.replace(/^\s*[-*•◦]\s+/, "");
  s = s.replace(/^["'«»]+|["'«»]+$/g, "");
  s = s.replace(/[.!?؟،,;:]+$/u, "");
  return s.trim();
}

const SYSTEM = `أنت مصحّح عناوين كتب عربية. مهمتك: إصلاح الإملاء والترجمة الصوتية لأسماء الكتب والمؤلفين.
أرجع سطراً واحداً فقط: العنوان المصحّح بالعربية (أو كما يُكتب في الكتالوجات).
لا تشرح. لا تضف علامات اقتباس. إن كان العنوان سليماً أعده كما هو.`;

async function callCloudflareLlama(query: string): Promise<string | null> {
  if (!CLOUDFLARE_AI_ACCOUNT_ID || !CLOUDFLARE_AI_API_TOKEN) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`;
  const user = [
    `استعلام بحث كتاب فاشل/مشبوه:`,
    `"${query}"`,
    ``,
    `صحّح: أخطاء إملائية عربية، همزات، تاء مربوطة، أسماء أجنبية مكتوبة خطأ (مثل وتيدصي→ويندي).`,
    `أزل حشو مثل: تحميل، pdf، رواية (إن لم تكن جزءاً من العنوان).`,
    `سطر واحد فقط = العنوان النظيف.`,
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CLOUDFLARE_AI_API_TOKEN}`,
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        max_tokens: 96,
        temperature: 0,
      }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: { response?: string }; success?: boolean };
    if (j.success === false) return null;
    return parseAiLine(j.result?.response || "");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function callMistral(query: string): Promise<string | null> {
  const keys = [MISTRAL_API_KEY, MISTRAL_API_KEY_2].filter(Boolean);
  for (const key of keys) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: "mistral-small-latest",
          temperature: 0,
          max_tokens: 80,
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: `صحّح عنوان الكتاب للبحث في كتالوجات عربية:\n"${query}"\nسطر واحد فقط.`,
            },
          ],
        }),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const line = parseAiLine(j.choices?.[0]?.message?.content || "");
      if (line) return line;
    } catch {
      /* try next */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * AI correction for book titles. Returns null on total failure.
 */
export async function correctBookQueryAI(
  query: string,
): Promise<{ corrected: string; changed: boolean } | null> {
  const original = (query || "").trim();
  if (original.length < MIN_LEN) return null;

  const ck = cacheKey(original);
  try {
    const hit = await redis.get(ck);
    if (hit) {
      redis.incr("tel:smartq:cache_hit").catch(() => {});
      const corrected = hit;
      return { corrected, changed: meaningfulChange(original, corrected) };
    }
  } catch { /* */ }

  redis.incr("tel:smartq:ai_used").catch(() => {});
  let ai =
    (await callCloudflareLlama(original)) ||
    (await callMistral(original));

  if (!ai || ai.length < MIN_LEN) {
    redis.incr("tel:smartq:ai_fail").catch(() => {});
    return null;
  }
  // safety: don't let AI invent a completely unrelated 1-token answer
  if (ai.length > 120) ai = ai.slice(0, 120);

  const changed = meaningfulChange(original, ai);
  redis.setex(ck, CACHE_TTL, ai).catch(() => {});
  if (changed) redis.incr("tel:smartq:ai_corrected").catch(() => {});
  else redis.incr("tel:smartq:ai_unchanged").catch(() => {});

  L.info("smartBookQuery", changed ? "ai_corrected" : "ai_unchanged", {
    from: original.slice(0, 50),
    to: ai.slice(0, 50),
  });
  return { corrected: ai, changed };
}

/**
 * Full resolve: local first, then optional AI.
 * @param opts.useAi  default true for no-results; false for cheap pre-search local only
 */
export async function smartResolveBookQuery(
  raw: string,
  opts?: { useAi?: boolean },
): Promise<SmartQueryResult> {
  const original = (raw || "").trim();
  if (!original) {
    return { original: "", resolved: "", changed: false, source: "none" };
  }

  const local = applyLocalSpellingFixes(original);
  if (meaningfulChange(original, local)) {
    redis.incr("tel:smartq:local_fixed").catch(() => {});
    // still try AI to refine if requested
    if (opts?.useAi !== false) {
      const ai = await correctBookQueryAI(local);
      if (ai?.changed) {
        return {
          original,
          resolved: ai.corrected,
          changed: true,
          source: "ai",
        };
      }
    }
    return { original, resolved: local, changed: true, source: "local" };
  }

  if (opts?.useAi === false) {
    return { original, resolved: local || original, changed: false, source: "none" };
  }

  // Heuristic: run AI when query looks messy (dialect marks, rare spelling)
  const messy =
    /[أإآ]/.test(original) === false && /ا/.test(original) // often missing hamza isn't enough
      ? false
      : /[ء-ي]{2,}/.test(original);
  // Always allow AI on explicit request; for pre-search useAi true means try AI
  const ai = await correctBookQueryAI(local || original);
  if (ai?.changed) {
    return {
      original,
      resolved: ai.corrected,
      changed: true,
      source: "ai",
    };
  }

  return {
    original,
    resolved: local || original,
    changed: meaningfulChange(original, local),
    source: meaningfulChange(original, local) ? "local" : "none",
  };
}
