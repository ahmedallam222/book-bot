import { createHash } from "crypto";
import { redis } from "./redis.js";
import { MISTRAL_API_KEY, TIMEOUT_MISTRAL } from "./config.js";
import { L } from "./logger.js";

// ══════════════════════════════════════════════════════════════
//  BOOK NAME PARSER — Mistral-powered title extractor
//
//  الهدف: تحويل المدخل الخام من المستخدم إلى اسم كتاب نظيف
//  قبل إرساله للبحث، لمنع حالتين:
//
//  (1) ضوضاء لغوية — المستخدم يكتب جملة بدل اسم الكتاب:
//      "ممكن تجيب لي كتاب العقيدة الواسطية"
//       → "العقيدة الواسطية"
//
//  (2) تشابه أسماء — المستخدم يكتب اسماً غامضاً:
//      "الأمير" → Mistral يُعيد العنوان الأكثر شيوعاً
//
//  المنطق:
//   1. Regex local cleaner أولاً (سريع، بدون API)
//   2. إذا بقي النص مع ضوضاء → Mistral
//   3. Redis cache (TTL 24h) — لتجنب API call متكرر
//   4. Fail-safe: إعادة المدخل الأصلي بدون تغيير
// ══════════════════════════════════════════════════════════════

const PARSE_CACHE_TTL_SEC = 24 * 3600;

function parseCacheKey(input: string): string {
  return `bnp:${createHash("sha256").update(input.toLowerCase().trim()).digest("hex").slice(0, 24)}`;
}

// ── STEP 1: Local regex cleaner ───────────────────────────────

const NOISE_PREFIXES: RegExp[] = [
  /^(أريد|اريد)\s+(كتاب|كتابه?|مؤلف|ملف|pdf)\s+/i,
  /^(ابحث|بحث|ابحثلي|بحثلي|جيبلي|جيب لي|جيب)\s+(عن\s+)?(كتاب\s+)?/i,
  /^(ممكن|قدر|تقدر)\s+(ت?جيب|ت?رسل|ت?شاركني|ت?حمل)\s+(لي\s+|لنا\s+)?(كتاب\s+)?/i,
  /^(هل\s+)?(عندك|عندكم|لديك|لديكم)\s+(كتاب\s+)?/i,
  /^(أحتاج|احتاج)\s+(إلى\s+|الى\s+|ل)?(كتاب\s+)?/i,
  /^(حمّ?ل|نزّ?ل)\s+(لي\s+)?(كتاب\s+)?/i,
  /^(كتاب|كتابه?|pdf)\s+/i,
  // BUG FIX: إضافة أشكال خليجية شائعة غير موجودة في القائمة الأصلية
  /^(ابغى|ابي|ودي|بدي)\s+(كتاب\s+)?/i,
  /^(بعثلي|ارسللي|شاركني)\s+(كتاب\s+)?/i,
];

const NOISE_SUFFIXES: RegExp[] = [
  /\s+(من\s+فضلك|لو\s+سمحت|please|بليز|شكراً?)\.?$/i,
  /\s+(pdf|بصيغة\s+pdf|كـ?pdf)\.?$/i,
];

function localCleanBookName(input: string): string | null {
  let cleaned = input.trim();
  let changed = false;

  for (const pattern of NOISE_PREFIXES) {
    const before = cleaned;
    cleaned = cleaned.replace(pattern, "").trim();
    if (cleaned !== before) { changed = true; break; }
  }

  for (const pattern of NOISE_SUFFIXES) {
    const before = cleaned;
    cleaned = cleaned.replace(pattern, "").trim();
    if (cleaned !== before) changed = true;
  }

  return changed && cleaned.length >= 2 ? cleaned : null;
}

// ── STEP 2: needsMistral — هل يستحق API call? ─────────────────

function needsMistral(input: string): boolean {
  const wordCount = input.trim().split(/\s+/).length;

  // BUG FIX: كان فحص requestVerbs بعد wordCount guard
  // "جيب الأمير" (3 كلمات) → wordCount<=4 → false → لا تنظيف
  // الحل: فحص أفعال الطلب أولاً بغض النظر عن عدد الكلمات
  const requestVerbs = /\b(أريد|اريد|ابحث|جيب|أحتاج|احتاج|ممكن|تقدر|تجيب|حمل|نزل|ابغى|ابي|ودي|بدي)\b/i;
  if (requestVerbs.test(input)) return true;
  if (input.includes("؟") || input.includes("?")) return true;

  if (wordCount <= 4) return false;
  if (wordCount > 7) return true;

  return false;
}

// ── STEP 3: askMistralForBookName ─────────────────────────────

async function askMistralForBookName(input: string): Promise<string | null> {
  if (!MISTRAL_API_KEY) return null;

  const prompt = [
    `أنت مساعد متخصص في استخراج أسماء الكتب من النصوص العربية.`,
    ``,
    `المهمة: استخرج اسم الكتاب الدقيق من النص التالي.`,
    `النص: "${input}"`,
    ``,
    `قواعد صارمة:`,
    `- أجب باسم الكتاب فقط، بدون أي كلام إضافي.`,
    `- لا تضف كلمة "كتاب" أو "مؤلف" أو أي كلمة توضيحية.`,
    `- إذا كان النص يحتوي على اسم كتاب واضح → اكتبه كما هو.`,
    `- إذا كان النص جملة طلب مثل "ممكن تجيب كتاب X" → اكتب X فقط.`,
    `- إذا لم تستطع تحديد اسم كتاب واضح → اكتب: UNKNOWN`,
    ``,
    `مثال: "ممكن تجيبلي كتاب العقيدة الواسطية" → العقيدة الواسطية`,
    `مثال: "الأمير الصغير" → الأمير الصغير`,
    `مثال: "أريد pdf رياضيات للصف الثالث" → رياضيات الصف الثالث`,
  ].join("\n");

  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${MISTRAL_API_KEY}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MISTRAL),
      body: JSON.stringify({
        model:       "mistral-small-latest",
        messages:    [{ role: "user", content: prompt }],
        max_tokens:  60,
        temperature: 0,
      }),
    });

    if (!r.ok) {
      L.warn("bookNameParser", `Mistral HTTP ${r.status} — falling back`);
      return null;
    }

    const data = await r.json() as { choices?: { message?: { content?: string } }[] };
    const ans  = (data.choices?.[0]?.message?.content ?? "").trim();

    if (!ans || ans.toUpperCase().includes("UNKNOWN") || ans.length < 2) return null;

    // إزالة أي اقتباسات أضافها النموذج
    const cleaned = ans.replace(/^["'«»\u201C\u201D]|["'«»\u201C\u201D]$/g, "").trim();
    return cleaned.length >= 2 ? cleaned : null;

  } catch (e) {
    L.warn("bookNameParser", `Mistral error — fallback: ${String(e).slice(0, 80)}`);
    return null;
  }
}

// ══════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════

/**
 * parseBookName
 * ──────────────
 * يُحوِّل المدخل الخام إلى اسم كتاب نظيف.
 *
 * الترتيب:
 *  1. Redis cache
 *  2. Regex local cleaner
 *  3. Mistral (للحالات المعقدة فقط — > 4 كلمات أو فيها أفعال طلب)
 *  4. Fallback: المدخل الأصلي
 *
 * @param rawInput  النص الخام من المستخدم
 * @returns اسم الكتاب المستخرج
 */
export async function parseBookName(rawInput: string): Promise<string> {
  const input = rawInput.trim();
  if (!input) return input;

  // ── 1. Redis cache ──────────────────────────
  const cacheKey = parseCacheKey(input);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      L.debug("bookNameParser", `Cache hit: "${input.slice(0, 40)}" → "${cached.slice(0, 40)}"`);
      return cached;
    }
  } catch { /* miss → continue */ }

  // ── 2. Regex local cleaner ──────────────────
  const localResult = localCleanBookName(input);
  if (localResult && !needsMistral(localResult)) {
    L.debug("bookNameParser", `Local clean: "${input.slice(0, 40)}" → "${localResult.slice(0, 40)}"`);
    redis.setex(cacheKey, PARSE_CACHE_TTL_SEC, localResult).catch(() => {});
    return localResult;
  }

  // ── 3. Mistral ──────────────────────────────
  const toProcess = localResult || input;
  if (MISTRAL_API_KEY && needsMistral(toProcess)) {
    const mistralResult = await askMistralForBookName(toProcess);
    if (mistralResult) {
      L.info("bookNameParser", `Mistral parsed: "${input.slice(0, 40)}" → "${mistralResult.slice(0, 40)}"`);
      redis.setex(cacheKey, PARSE_CACHE_TTL_SEC, mistralResult).catch(() => {});
      return mistralResult;
    }
  }

  // ── 4. Fallback ─────────────────────────────
  const fallback = localResult || input;
  redis.setex(cacheKey, PARSE_CACHE_TTL_SEC, fallback).catch(() => {});
  return fallback;
}
