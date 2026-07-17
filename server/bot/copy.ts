// ══════════════════════════════════════════════
// COPY — نصوص رفيق بالعربية الفصحى
// ══════════════════════════════════════════════

import { BOT_NAME, BOT_TAGLINE } from "./brand.js";
import { DAILY_LIMIT, PREMIUM_LIMIT, PREMIUM_STARS_PRICE } from "./config.js";

/** نص المساعدة الموحّد — /help وزر «كيف أستخدم رفيق؟» */
export function buildHelpMessage(): string {
  return (
    `❓ *كيف تستخدم ${BOT_NAME}؟*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `أنا *${BOT_NAME}* — ${BOT_TAGLINE}.\n` +
    `هدفي بسيط: أن أُرسل إليك *ملف PDF* لأيّ كتاب عربيّ تطلبه.\n\n` +

    `📖 *1) أتريد كتاباً؟*\n` +
    `◦ اكتب *عنوان الكتاب* في المحادثة (مثال: الأمير الصغير)\n` +
    `◦ أو: \`/search\` ثمّ العنوان\n` +
    `◦ للمفاجأة: اضغط «كتاب مفاجأة» أو اكتب \`/random\`\n\n` +

    `✅ *2) سجّل حضورك (مرّة في اليوم)*\n` +
    `◦ زر «سجّل حضورك» أو الأمر \`/daily\`\n` +
    `◦ معناه: أنّك فتحت البوت اليوم — ولا يُطلب منك تحميل كتب\n` +
    `◦ يمنحك نقاطاً بسيطة ترفع «مستواك» كقارئ\n\n` +

    `👤 *3) ملفي الشخصي*\n` +
    `◦ يعرض: عدد الكتب المحمّلة · سلسلتك · مستواك · شاراتك\n` +
    `◦ الأمر: \`/profile\`\n\n` +

    `📊 *4) رصيدي اليوم*\n` +
    `◦ كم تحميلاً يتبقّى لك اليوم\n` +
    `◦ الأمر: \`/stats\`\n\n` +

    `🔖 *5) قائمة الأمنيات*\n` +
    `◦ احفظ كتباً لتعود إليها لاحقاً\n` +
    `◦ \`/wishlist\` أو زر «أمنياتي»\n\n` +

    `📘 *6) الملخّص الذكي*\n` +
    `◦ بعد وصول الكتاب: اضغط «ملخّص سريع»\n\n` +

    `🎨 *7) صورة بالذكاء الاصطناعي*\n` +
    `◦ \`/img\` ثمّ وصف الصورة\n` +
    `◦ مثال: \`/img مكتبة هادئة عند النافذة\`\n\n` +

    `🎁 *8) ادعُ صديقاً*\n` +
    `◦ \`/invite\` — قد تحصل على Premium عند دعوة الآخرين\n\n` +

    `⭐ *Premium*\n` +
    `◦ المجّاني: *${DAILY_LIMIT}* تحميلات يومياً\n` +
    `◦ Premium: *${PREMIUM_LIMIT}* تحميلاً يومياً مع أولويّة\n` +
    `◦ السعر: *${PREMIUM_STARS_PRICE}* Stars شهرياً — \`/premium\`\n\n` +

    `👥 *في المجموعات*\n` +
    `◦ غالباً يكفي أن تكتب عنوان الكتاب مباشرةً\n` +
    `◦ أو: \`بوت\` ثمّ عنوان الكتاب\n\n` +

    `💡 *نصيحة:* اكتب العنوان بوضوح. إن تشابهت العناوين، أضف اسم المؤلّف.\n\n` +
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
