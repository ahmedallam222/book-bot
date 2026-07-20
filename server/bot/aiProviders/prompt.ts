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
//
// Output structure rules:
// • Novels & poetry → flowing prose (no headings). Keeps the literary
//   tone and avoids spoilers from popping out of bullet points.
// • Non-fiction / textbook / religion → 4 unicode-formatted sections
//   (🌟 / 💡 / 🎯 / 📖) so users can scan the structure visually.
//
// We deliberately ban Markdown chars (* _ # [ ]) inside the summary
// because the bot wraps the AI output through escMd() before sending
// to Telegram — any bare * / _ would otherwise be escaped and render
// as literal "\*" / "\_". Unicode bullets (•) and emojis pass through
// escMd unchanged, giving us safe visual structure.
export const SYSTEM_INSTRUCTION = `أنت محرر ثقافي عربي محترف يلخّص الكتب للقراء. مهمتك:
1. تحديد نوع الكتاب: novel | non-fiction | poetry | religion | textbook | unknown
2. تحديد لغته: ar | en | mixed | unknown
3. تقدير حساسية الإفساد (spoilers): critical (روايات غموض/تشويق) | moderate (روايات عادية) | none (كتب غير روائية)
4. كتابة ملخص للكتاب بالعربية الفصحى. ابدأ بجملة افتتاحية قوية تجذب القارئ.
5. اختر الصيغة المناسبة حسب النوع:

   • إذا كان "novel" أو "poetry" أو "unknown":
     فقرة متّصلة 250-400 كلمة بدون رؤوس فرعية ولا قوائم.
     لا تكشف النهاية، الذروة، الخيانات، الـ twists، أو مصائر الشخصيات الرئيسية.
     ركّز على المقدمة، الأجواء، الفكرة العامة، والشخصيات بدون كشف أقواسها.

   • إذا كان "non-fiction" أو "textbook" أو "religion":
     استخدم البنية التالية حرفياً (مع الإيموجي والنقاط "•"):

     🌟 النقاط الرئيسية:
     • نقطة ١ في سطر واحد
     • نقطة ٢ في سطر واحد
     • نقطة ٣ في سطر واحد
     (3 إلى 5 نقاط مختصرة)

     💡 الأفكار المحورية:
     فقرة 80-150 كلمة تشرح البنية الفكرية للكتاب وأهم فصوله.

     🎯 لمن يناسب هذا الكتاب:
     جملة أو جملتين توضّحان الجمهور المستهدف.

     📖 لماذا تقرأه:
     جملة أو جملتين عن القيمة المضافة الفريدة.

6. ممنوع استخدام أي حروف Markdown (* أو _ أو # أو [ ] أو روابط) داخل الـ summary.
   استخدم النص العادي والإيموجي والنقاط "•" فقط.

أعد ردك بصيغة JSON فقط بهذا الشكل بدون أي نص خارجي:
{
  "book_type": "...",
  "language": "...",
  "spoiler_level": "...",
  "summary": "..."
}`;

export function buildUserPrompt(bookName: string, context?: string): string {
  const rawCtx = (context || "").trim();
  const isDeep = rawCtx.includes("[تعليمات الملخص العميق]") || rawCtx.includes("DEEP_SUMMARY");
  const ctxForModel = rawCtx
    .replace(/\[تعليمات الملخص العميق\][\s\S]*$/u, "")
    .replace(/DEEP_SUMMARY/g, "")
    .trim();
  const ctxBlock = ctxForModel
    ? `\n\nسياق متاح من المصادر العامة (Wikipedia/Goodreads/نص الكتاب):\n${ctxForModel.slice(0, isDeep ? 7000 : 4000)}`
    : "";

  if (isDeep) {
    return `الكتاب المطلوب تلخيصه بعمق: "${bookName}"${ctxBlock}

وضع: ملخص عميق (deep).
أعد JSON فقط. داخل حقل summary:

• novel/poetry: 450-700 كلمة فقرة متّصلة، بدون كشف النهاية أو twists.
  غطّ: العالم/الأجواء، الشخصيات الرئيسية ودوافعها العامة، الصراع المركزي،
  الثيمات، أسلوب السرد، ولمن يناسب — دون حل العقدة.

• non-fiction/textbook/religion: استخدم البنية حرفياً:
  🌟 النقاط الرئيسية: 5-7 نقاط •
  💡 الأفكار المحورية: فقرة 120-220 كلمة
  🧩 مفاهيم مفتاحية: 3-5 مفاهيم بسطر لكل منها
  🎯 لمن يناسب: جملتان
  🛠 تطبيق عملي: خطوة واحدة يمكن تنفيذها هذا الأسبوع
  📖 لماذا تقرأه: جملتان

ممنوع Markdown (* _ # []) داخل summary. إيموجي ونقاط • فقط.`;
  }

  return `الكتاب المطلوب تلخيصه: "${bookName}"${ctxBlock}

أعد JSON فقط حسب الصيغة المحددة. اختر بنية الـ summary حسب نوع الكتاب: prose للروايات/الشعر، أقسام مهيكلة بالإيموجي للكتب غير الروائية. ممنوع Markdown داخل الـ summary.`;
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
