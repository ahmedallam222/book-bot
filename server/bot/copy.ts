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
    `أسفل المحادثة أزرار ثابتة للأوامر الشائعة.\n` +
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
    `◦ يعرض: عدد الكتب · سلسلتك · ذوقك · أسبوعك · شاراتك\n` +
    `◦ الأمر: \`/profile\`\n\n` +

    `📚 *مكتبتك الشخصية*\n` +
    `◦ \`/library\` أو زر «مكتبتي» — كل ما حمّلته\n` +
    `◦ \`/history\` — آخر طلباتك مع إعادة تحميل\n` +
    `◦ \`/continue\` — أكمل من آخر كتاب\n` +
    `◦ \`/lists\` — قوائم · \`/share\` — بطاقة مشاركة\n` +
    `◦ \`/prefs\` — تفضيلات الإشعارات\n` +
    `◦ \`/pulse\` — سؤال يومي خفيف\n\n` +

    `📊 *4) رصيدي اليوم*\n` +
    `◦ كم تحميلاً يتبقّى لك اليوم\n` +
    `◦ الأمر: \`/stats\`\n\n` +

    `📊 *5) تقرير أسبوعك*\n` +
    `◦ \`/myweek\` أسبوعي · \`/mymonth\` شهري\n` +
    `◦ ملخص شخصي دون مقارنة مع أحد\n\n` +

    `🔖 *6) قائمة الأمنيات ورحلة القراءة*\n` +
    `◦ احفظ كتباً: لاحقاً → أقرأ → أنهيت\n` +
    `◦ \`/wishlist\` أو زر «أمنياتي»\n\n` +

    `📘 *7) الملخّص الذكي*\n` +
    `◦ بعد وصول الكتاب: اضغط «ملخّص سريع»\n\n` +

    `🎨 *8) صورة بالذكاء الاصطناعي*\n` +
    `◦ \`/img\` ثمّ وصف الصورة\n` +
    `◦ مثال: \`/img مكتبة هادئة عند النافذة\`\n\n` +

    `📖 *9) كتاب اليوم*\n` +
    `◦ زر «كتاب اليوم» أو \`/today\` — اقتراح يومي اختياري\n\n` +

    `🕊 *لحظة يومية*\n` +
    `◦ \`/pulse\` أو زر «لحظة» — سؤال خفيف اختياري + نقاط\n\n` +

    `🎭 *ذوقك*\n` +
    `◦ \`/taste\` — غيّر اهتماماتك واحصل على قوائم أقرب لك\n\n` +

    `👥 *10) نادي المجموعات*\n` +
    `◦ في المجموعة: اكتب العنوان مباشرةً\n` +
    `◦ كتاب النادي: \`/club\`\n` +
    `◦ أو: \`بوت\` ثمّ العنوان\n\n` +

    `🎁 *11) ادعُ صديقاً*\n` +
    `◦ \`/invite\` — قد تحصل على Premium عند دعوة الآخرين\n\n` +

    `⭐ *Premium*\n` +
    `◦ المجّاني: *${DAILY_LIMIT}* تحميلات يومياً\n` +
    `◦ Premium: *${PREMIUM_LIMIT}* تحميلاً يومياً مع أولويّة\n` +
    `◦ السعر: *${PREMIUM_STARS_PRICE}* Stars شهرياً — \`/premium\`\n\n` +

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
        { text: "📊  أسبوعي", callback_data: "my_week" },
        { text: "📖  كتاب اليوم", callback_data: "botd:show" },
      ],
      [
        { text: "📚  مكتبتي", callback_data: "my_library" },
        { text: "📖  قوائم", callback_data: "curated_menu" },
      ],
      [
        { text: "🕊  لحظة", callback_data: "micro_open" },
        { text: "📅  شهري", callback_data: "my_month" },
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
        { text: "📖  كتاب اليوم", callback_data: "botd:show" },
      ],
      [
        { text: "📚  مكتبتي", callback_data: "my_library" },
        { text: "🕊  لحظة", callback_data: "micro_open" },
      ],
      [
        { text: "📊  أسبوعي", callback_data: "my_week" },
        { text: "👤  ملفي", callback_data: "my_profile" },
      ],
      [{ text: "🏠  الرئيسية", callback_data: "main_menu" }],
    ],
  };
}

export function kbAfterProfile(): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [
      [
        { text: "✅  سجّل حضورك", callback_data: "daily_quest" },
        { text: "📚  مكتبتي", callback_data: "my_library" },
      ],
      [
        { text: "📜  سجلّي", callback_data: "my_history" },
        { text: "📊  أسبوعي", callback_data: "my_week" },
      ],
      [
        { text: "🎭  ذوقي", callback_data: "onb_restart" },
        { text: "🎁  ادعُ صديقاً", callback_data: "invite_view" },
      ],
      [
        { text: "📊  رصيدي", callback_data: "my_stats" },
        { text: "🏠  الرئيسية", callback_data: "main_menu" },
      ],
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
    `💡 إن تشابه العنوان، أضف *اسم المؤلّف* لدقّة أعلى.\n\n` +
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
