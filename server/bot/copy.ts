// ══════════════════════════════════════════════
// COPY — نصوص رفيق الواضحة
//
// قاعدة: كل رسالة تجاوب: ماذا؟ ليه؟ وإيه اللي بعده؟
// لغة بسيطة · دافئة · بلا مصطلحات غامضة (XP تُشرح).
// ══════════════════════════════════════════════

import { BOT_NAME, BOT_TAGLINE } from "./brand.js";
import { DAILY_LIMIT, PREMIUM_LIMIT, PREMIUM_STARS_PRICE } from "./config.js";

/** نص المساعدة الموحّد — /help وزر «كيف أستخدم؟» */
export function buildHelpMessage(): string {
  return (
    `❓ *كيف تستخدم ${BOT_NAME}؟*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `أنا *${BOT_NAME}* — ${BOT_TAGLINE}.\n` +
    `هدفي بسيط: تجيبلك *ملف PDF* لأي كتاب عربي تطلبه.\n\n` +

    `📖 *1) عايز كتاب؟*\n` +
    `◦ اكتب *اسم الكتاب* في الشات (مثال: الأمير الصغير)\n` +
    `◦ أو: \`/search\` ثم العنوان\n` +
    `◦ مفاجأة: اضغط «كتاب مفاجأة» أو اكتب \`/random\`\n\n` +

    `✅ *2) سجّل حضورك (مرة في اليوم)*\n` +
    `◦ زر «سجّل حضورك» أو الأمر \`/daily\`\n` +
    `◦ يعني: فتحت البوت النهارده — مش مطلوب تحمّل كتب\n` +
    `◦ بيكسبك نقاط بسيطة وترفع «مستواك» كقارئ\n\n` +

    `👤 *3) ملفي الشخصي*\n` +
    `◦ يشوفلك: كام كتاب حمّلت · سلسلتك · مستواك · شاراتك\n` +
    `◦ الأمر: \`/profile\`\n\n` +

    `📊 *4) رصيدي اليوم*\n` +
    `◦ كام تحميل لسه فاضلك النهارده\n` +
    `◦ الأمر: \`/stats\`\n\n` +

    `🔖 *5) قائمة الأمنيات*\n` +
    `◦ احفظ كتب ترجع لها لاحقاً\n` +
    `◦ \`/wishlist\` أو زر «أمنياتي»\n\n` +

    `📘 *6) ملخّص ذكي*\n` +
    `◦ بعد ما يوصلك الكتاب: زر «ملخّص ذكي»\n\n` +

    `🎨 *7) صورة بالذكاء*\n` +
    `◦ \`/img\` ثم وصف الصورة\n` +
    `◦ مثال: \`/img مكتبة هادئة عند الشباك\`\n\n` +

    `🎁 *8) ادعُ صديقاً*\n` +
    `◦ \`/invite\` — مكافأة Premium لو دعاك ناس\n\n` +

    `⭐ *Premium*\n` +
    `◦ مجاني: *${DAILY_LIMIT}* تحميل/يوم\n` +
    `◦ Premium: *${PREMIUM_LIMIT}* تحميل/يوم + أولوية\n` +
    `◦ السعر: *${PREMIUM_STARS_PRICE}* Stars شهرياً — \`/premium\`\n\n` +

    `👥 *في الجروبات*\n` +
    `◦ غالباً يكفي تكتب اسم الكتاب مباشرة\n` +
    `◦ أو: \`بوت\` ثم اسم الكتاب\n\n` +

    `💡 *نصيحة:* اكتب العنوان بوضوح. لو فيه أكثر من كتاب بنفس الاسم، زوّد اسم المؤلف.\n\n` +
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
    `اكتب *اسم الكتاب* في الشات الآن.\n\n` +
    `*أمثلة:*\n` +
    `◦ الأمير الصغير\n` +
    `◦ فن اللامبالاة\n` +
    `◦ مقدمة ابن خلدون\n\n` +
    `💡 لو الاسم شائع، زوّد *اسم المؤلف* عشان النتيجة أدق.\n\n` +
    `_بعد ما تكتب… ${BOT_NAME} يدور ويرسل PDF._`
  );
}

export function buildImgPrompt(): string {
  return (
    `🎨 *اصنع صورة بالذكاء الاصطناعي*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `اكتب الأمر كده:\n` +
    `\`/img\` ثم وصف الصورة\n\n` +
    `*مثال:*\n` +
    `\`/img قطة تقرأ كتاباً بجانب نافذة\`\n\n` +
    `⏱ غالباً بين نصف دقيقة ودقيقة.\n` +
    `🎫 فيه حد يومي (مجاني/Premium مختلف).\n\n` +
    `_وصف أوضح = صورة أحلى._`
  );
}
