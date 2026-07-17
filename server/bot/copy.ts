// ══════════════════════════════════════════════
// COPY — نصوص رفيق بالعربية الفصحى
// ══════════════════════════════════════════════

import { BOT_NAME, BOT_TAGLINE } from "./brand.js";
import { DAILY_LIMIT, PREMIUM_LIMIT, PREMIUM_STARS_PRICE } from "./config.js";

/** نص المساعدة الموحّد — /help وزر «كيف أستخدم رفيق؟» */
export function buildHelpMessage(): string {
  return (
    `❓ *كيف تستخدم ${BOT_NAME}؟*
` +
    `━━━━━━━━━━━━━━━━

` +
    `أسفل المحادثة أزرار ثابتة للأوامر الشائعة.
` +
    `أنا *${BOT_NAME}* — ${BOT_TAGLINE}.
` +
    `هدفي بسيط: أن أُرسل إليك *ملف PDF* لأيّ كتاب عربيّ تطلبه.

` +

    `📖 *1) أتريد كتاباً؟*
` +
    `◦ اكتب *عنوان الكتاب* في المحادثة (مثال: الأمير الصغير)
` +
    `◦ أو: \`/search\` ثمّ العنوان
` +
    `◦ للمفاجأة: اضغط «كتاب مفاجأة» أو اكتب \`/random\`

` +

    `✅ *2) سجّل حضورك (مرّة في اليوم)*
` +
    `◦ زر «سجّل حضورك» أو الأمر \`/daily\`
` +
    `◦ معناه: أنّك فتحت البوت اليوم — ولا يُطلب منك تحميل كتب
` +
    `◦ يمنحك نقاطاً بسيطة ترفع «مستواك» كقارئ

` +

    `👤 *3) ملفي الشخصي*
` +
    `◦ يعرض: عدد الكتب المحمّلة · سلسلتك · مستواك · شاراتك
` +
    `◦ الأمر: \`/profile\`

` +

    `📊 *4) رصيدي اليوم*
` +
    `◦ كم تحميلاً يتبقّى لك اليوم
` +
    `◦ الأمر: \`/stats\`

` +

    `🔖 *5) قائمة الأمنيات*
` +
    `◦ احفظ كتباً لتعود إليها لاحقاً
` +
    `◦ \`/wishlist\` أو زر «أمنياتي»

` +

    `📘 *6) الملخّص الذكي*
` +
    `◦ بعد وصول الكتاب: اضغط «ملخّص سريع»

` +

    `🎨 *7) صورة بالذكاء الاصطناعي*
` +
    `◦ \`/img\` ثمّ وصف الصورة
` +
    `◦ مثال: \`/img مكتبة هادئة عند النافذة\`

` +

    `📖 *8) كتاب اليوم*
` +
    `◦ زر «📖 كتاب اليوم» في الأسفل أو الأمر \`/today\`
` +
    `◦ اقتراح يومي هادئ — اختياري تماماً

` +

    `🎁 *9) ادعُ صديقاً*
` +
    `◦ \`/invite\` — قد تحصل على Premium عند دعوة الآخرين

` +

    `⭐ *Premium*
` +
    `◦ المجّاني: *${DAILY_LIMIT}* تحميلات يومياً
` +
    `◦ Premium: *${PREMIUM_LIMIT}* تحميلاً يومياً مع أولويّة
` +
    `◦ السعر: *${PREMIUM_STARS_PRICE}* Stars شهرياً — \`/premium\`

` +

    `👥 *في المجموعات*
` +
    `◦ غالباً يكفي أن تكتب عنوان الكتاب مباشرةً
` +
    `◦ أو: \`بوت\` ثمّ عنوان الكتاب

` +

    `💡 *نصيحة:* اكتب العنوان بوضوح. إن تشابهت العناوين، أضف اسم المؤلّف.

` +
    `_${BOT_NAME} معك… بهدوء._`
  );
}

export function kbHelp(): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [
      [
        { text: "🔍  ابحث عن كتاب", callback_data: "new_search" },
        { text: "✅  سجّل حضورك", callback_data: "daily_quest" },
      ],
      [
        { text: "🎲  كتاب مفاجأة", callback_data: "rg:any" },
        { text: "👤  ملفي", callback_data: "my_profile" },
      ],
      [
        { text: "⭐  Premium", callback_data: "premium_buy" },
        { text: "🏠  الرئيسية", callback_data: "main_menu" },
      ],
    ],
  };
}

export function kbAfterDaily(): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [
      [
        { text: "🎲  كتاب مفاجأة", callback_data: "rg:any" },
        { text: "🔍  ابحث عن كتاب", callback_data: "new_search" },
      ],
      [
        { text: "👤  ملفي", callback_data: "my_profile" },
        { text: "🏠  الرئيسية", callback_data: "main_menu" },
      ],
    ],
  };
}

export function kbAfterProfile(): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [
      [
        { text: "✅  سجّل حضورك", callback_data: "daily_quest" },
        { text: "📊  رصيدي اليوم", callback_data: "my_stats" },
      ],
      [
        { text: "🎁  ادعُ صديقاً", callback_data: "invite_view" },
        { text: "🔍  ابحث", callback_data: "new_search" },
      ],
      [{ text: "🏠  الرئيسية", callback_data: "main_menu" }],
    ],
  };
}

export function buildSearchPrompt(): string {
  return (
    `🔍 *ابحث عن كتاب*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `اكتب *عنوان الكتاب* في المحادثة الآن.\n\n` +
    `*أمثلة:*\n` +
    `◦ الأمير الصغير\n` +
    `◦ فنّ اللامبالاة\n` +
    `◦ مقدّمة ابن خلدون\n\n` +
    `💡 إن كان العنوان شائعاً، أضف *اسم المؤلّف* لدقّة أعلى.\n\n` +
    `_بعد الكتابة… يبحث ${BOT_NAME} ويرسل ملف PDF._`
  );
}

export function buildImgPrompt(): string {
  return (
    `🎨 *إنشاء صورة بالذكاء الاصطناعي*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `اكتب الأمر على هذا النحو:\n` +
    `\`/img\` ثمّ وصف الصورة\n\n` +
    `*مثال:*\n` +
    `\`/img قطّة تقرأ كتاباً بجانب نافذة\`\n\n` +
    `⏱ يستغرق التوليد غالباً بين نصف دقيقة ودقيقة.\n` +
    `🎫 يوجد حدّ يوميّ (يختلف بين المجّاني وPremium).\n\n` +
    `_كلّما كان الوصف أوضح، جاءت الصورة أجمل._`
  );
}
