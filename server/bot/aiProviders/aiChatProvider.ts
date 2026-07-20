import { BYNARA_API_KEY_1, BYNARA_API_KEY_2, MISTRAL_API_KEY, MISTRAL_API_KEY_2 } from "../config.js";
import { L } from "../logger.js";

export async function parseChatIntent(userText: string): Promise<{
  isChat: boolean;
  response?: string;
  bookName?: string;
  wantsSummary?: boolean;
}> {
  // FIX-DELIVERY: Mistral first — Bynara was timing out (6s×N) and
  // delaying chat/intent parsing even when Mistral is healthy.
  const endpoints = [
    { url: "https://api.mistral.ai/v1/chat/completions", key: MISTRAL_API_KEY, model: "mistral-small-latest" },
    { url: "https://api.mistral.ai/v1/chat/completions", key: MISTRAL_API_KEY_2, model: "mistral-small-latest" },
    { url: "https://router.bynara.id/v1/chat/completions", key: BYNARA_API_KEY_1, model: "mistral-large" },
    { url: "https://router.bynara.id/v1/chat/completions", key: BYNARA_API_KEY_2, model: "mistral-large" }
  ].filter(e => !!e.key);

  const systemPrompt = `أنت مساعد بوت تيليجرام اسمه «رفيق» — رفيق كتب عربي هادئ.
حلّل نية المستخدم وأخرج JSON فقط:

قواعد:
1) دردشة/تحية/سؤال عام → isChat=true + رد عربي دافئ قصير.
2) طلب كتاب/رواية → isChat=false + bookName = العنوان النظيف فقط (بدون: عايز، عندك، تحميل، pdf، رواية، لو سمحت).
3) صحّح الإملاء الواضح إن أمكن (العادت الذريه→العادات الذرية).
4) طلب كتب لمؤلف ("كتب نجيب محفوظ") → bookName = اسم المؤلف.
5) ملخص/تلخيص → wantsSummary=true + عنوان نظيف.
6) لا تخترع عناوين غير مذكورة.

{
  "isChat": boolean,
  "response": "رد عربي إن isChat وإلا فارغ",
  "bookName": "عنوان نظيف إن لم تكن دردشة",
  "wantsSummary": boolean
}`;

  for (const ep of endpoints) {
    try {
      const r = await fetch(ep.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ep.key}`,
        },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          model: ep.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userText }
          ],
          max_tokens: 300,
          temperature: 0.3,
          response_format: { type: "json_object" }
        }),
      });

      if (!r.ok) continue;

      const data = await r.json() as any;
      const content = data.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(content);
      
      return {
        isChat: !!parsed.isChat,
        response: parsed.response || undefined,
        bookName: parsed.bookName || undefined,
        wantsSummary: !!parsed.wantsSummary
      };
    } catch (e) {
      L.warn("aiChat", `AI Chat error on ${ep.url}: ${String(e).slice(0, 80)}`);
    }
  }

  return { isChat: false, bookName: userText, wantsSummary: false };
}
