// ══════════════════════════════════════════════════════════
// Shared prompt + JSON parser for all summary providers
// ══════════════════════════════════════════════════════════
// Every provider sends the same instruction shape so we can swap
// freely without per-provider prompt tuning. Output is strict JSON
// for robust parsing (any provider that wraps it in markdown fences
// is handled by stripFences below).

import type { ProviderJSONOutput, SummaryResponse } from "./types.js";

// The system instruction. Kept in Arabic because every downstream
// user-facing string is Arabic and the models we use respond in the
// language of the prompt.
export const SYSTEM_INSTRUCTION = `أنت محرر ثقافي عربي محترف يلخّص الكتب للقراء. مهمتك:
1. تحديد نوع الكتاب: novel | non-fiction | poetry | religion | textbook | unknown
2. تحديد لغته: ar | en | mixed | unknown
3. تقدير حساسية الإفساد (spoilers): critical (روايات غموض/تشويق) | moderate (روايات عادية) | none (كتب غير روائية)
4. كتابة ملخص جذّاب 250-400 كلمة بالعربية الفصحى:
   - إذا كان روائياً: لا تكشف النهاية، الذروة، moor twists، مصائر الشخصيات الرئيسية، الـ revelations. ركّز على المقدمة، الأجواء، الفكرة العامة، الشخصيات بدون كشف أقواسها.
   - إذا كان غير روائي: اشرح الأفكار الرئيسية، البنية، أهم الفصول، الفئة المستهدفة.
5. ابدأ بجملة افتتاحية قوية تجذب القارئ.

أعد ردك بصيغة JSON فقط بهذا الشكل بدون أي نص خارجي:
{
  "book_type": "...",
  "language": "...",
  "spoiler_level": "...",
  "summary": "..."
}`;

export function buildUserPrompt(bookName: string, context?: string): string {
  const ctxBlock = context && context.trim()
    ? `\n\nسياق متاح من المصادر العامة (Wikipedia/Goodreads):\n${context.trim().slice(0, 4000)}`
    : "";
  return `الكتاب المطلوب تلخيصه: "${bookName}"${ctxBlock}

أعد JSON فقط حسب الصيغة المحددة. الـ summary بالعربية الفصحى 250-400 كلمة.`;
}

// Strip ```json ... ``` fences and whitespace some providers emit even
// when told not to. Defensive — nothing breaks if the input is clean.
function stripFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

// Find the first balanced {...} block. Some chatty providers prefix
// with "Sure, here's the summary:" before the JSON despite our
// "JSON only" instruction. Accepts that gracefully.
function extractFirstObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const VALID_TYPES = new Set(["novel", "non-fiction", "poetry", "religion", "textbook", "unknown"]);
const VALID_LANGS = new Set(["ar", "en", "mixed", "unknown"]);
const VALID_SPOIL = new Set(["critical", "moderate", "none"]);

export function parseProviderResponse(
  raw: string,
  providerName: string,
  source: SummaryResponse["source"],
): SummaryResponse {
  const stripped = stripFences(raw);
  const obj      = extractFirstObject(stripped) ?? stripped;

  let parsed: ProviderJSONOutput;
  try {
    parsed = JSON.parse(obj);
  } catch {
    // If the provider ignored "JSON only" and just gave us prose, salvage
    // it as the summary text — better than failing the entire request.
    if (stripped.length > 50) {
      return {
        summary:      stripped.slice(0, 4000),
        bookType:     "unknown",
        spoilerLevel: "none",
        language:     "unknown",
        providerName,
        source,
      };
    }
    throw new Error(`Provider ${providerName} returned unparseable response: ${stripped.slice(0, 120)}`);
  }

  const summary = (parsed.summary || "").trim();
  if (!summary || summary.length < 50) {
    throw new Error(`Provider ${providerName} returned empty/too-short summary`);
  }

  const bookType     = VALID_TYPES.has(parsed.book_type     || "") ? parsed.book_type     as SummaryResponse["bookType"]    : "unknown";
  const language     = VALID_LANGS.has(parsed.language      || "") ? parsed.language      as SummaryResponse["language"]    : "unknown";
  const spoilerLevel = VALID_SPOIL.has(parsed.spoiler_level || "") ? parsed.spoiler_level as SummaryResponse["spoilerLevel"]: "none";

  return { summary, bookType, language, spoilerLevel, providerName, source };
}
