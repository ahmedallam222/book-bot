import { escMd } from "./text.js";

// ══════════════════════════════════════════════════════════════
//  UI LAYER — خلاصة الكتب v7
//  الفلسفة: مكتبة حيّة — كل رسالة تجربة بصرية وشعورية
//  المبادئ: الوضوح أولاً، الجمال ثانياً، الدفء دائماً
// ══════════════════════════════════════════════════════════════

const HR  = "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄";
const HR2 = "━━━━━━━━━━━━━━━━━━━";

// ── شريط مرئي قابل للتخصيص ──────────────────────────────────
function bar(filled: number, total = 10): string {
  const f = Math.max(0, Math.min(total, Math.round(filled)));
  return "▰".repeat(f) + "▱".repeat(total - f);
}

// ── مؤشر مستوى ───────────────────────────────────────────────
function levelIndicator(remaining: number, limit: number): string {
  if (limit <= 0) return "♾️";
  if (remaining === 0) return "⛔";
  if (remaining === 1) return "🔴";
  if (remaining <= 2) return "🟡";
  if (remaining <= Math.ceil(limit * 0.4)) return "🟠";
  return "🟢";
}

// ── ٣٢ نصيحة — ثلاثة أقسام: حكمة × علم × سرّ ──────────────
const TIPS_POOL: readonly string[] = [
  // ✦ الحكمة الأدبية الخالدة
  "📖 «خير جليس في الزمان كتاب» — المتنبي",
  "🌙 «الكتاب مرآة: إن أطلّ فيه قرد، لن يرى ملاكاً» — ليكتنبرغ",
  "🔥 «القارئ يعيش ألف حياة قبل موته، والأمّي لا يعيش إلا واحدة» — جورج مارتن",
  "🗝️ «كتاب لا تقرؤه لا يُفيدك بشيء» — مارك تويني",
  "💎 «اقرأ ألف كتاب وستكون كاتباً — اقرأ عشرة آلاف وستكون أسلوباً» — كينج",
  "🌊 «الكتاب صديق لا ينام، ومعلّم لا يكذب، وطبيب لا يتعب»",
  "⭐ «العلم يزيد بالإنفاق، والمال ينقص به» — الإمام علي",
  "🎭 «الكتب تُعلّمنا أن نتعاطف مع من لم نلتقِ بهم — ومن لن نلتقي»",
  "🪞 «القراءة وحدها تُتيح لك أن تعيش حياة آخرين دون أن تتخلّى عن حياتك»",
  "🌸 «من لم يُحبّ الكتاب لم يُحبّ العلم» — القاضي عياض",
  "🏛️ «الجهل عدو العقل، والكتاب سيفه» — ابن خلدون",
  "🕊️ «الكتاب رفيق لا يُخذلك، وجليس لا يملّك» — الجاحظ",
  // ✦ العلم والحقائق المُدهشة
  "🧠 القراءة ٦ دقائق فقط تُخفّض التوتر ٦٨٪ — جامعة ساسيكس ٢٠٠٩",
  "⏱️ ٢٠ دقيقة يومياً = ١٢ كتاباً سنوياً = عقل مختلف كلياً",
  "💤 القراءة قبل النوم تُهدّئ الجهاز العصبي وتعمّق النوم العميق",
  "🧬 القرّاء المنتظمون يُصابون بالخرف بنسبة أقل ٣٢٪ — Neurology Journal",
  "🧩 الروايات تُنمّي التعاطف والذكاء العاطفي — أثبتته دراسات Harvard",
  "🏃 القرّاء المنتظمون أكثر صحة نفسية وأقل اكتئاباً في المتوسط",
  "📊 ٩٤٪ من أنجح قادة العالم يقرؤون كتاباً جديداً كل أسبوع",
  "🌍 اللغة العربية تمتلك أكثر من ١٢ مليون كلمة — أغنى لغات العالم",
  "🔤 القراءة بالعربية تُنشّط جانبَي الدماغ معاً بسبب اتجاه الكتابة",
  // ✦ أسرار القراءة
  "☕ لحظة الانتظار — تذكّر آخر فكرة غيّرتك من كتاب قرأته",
  "✨ أجمل كتاب في حياتك لم تقرأه بعد — أنت الآن على وشكه",
  "🎯 الكتاب الصحيح في اللحظة الصحيحة يُغيّر مجرى حياة بأكملها",
  "🚀 أكثر العقول تأثيراً عبر التاريخ كانت تقرأ بشراهة لا تُصدَّق",
  "💡 القراءة لا تُعلّمك ماذا تُفكّر — بل تُعلّمك *كيف* تُفكّر",
  "🌺 «تفقّد كتابك قبل كل شيء، فهو أمين ما أودعته»",
  "🎶 الكتاب الجيد يُموسق الأفكار — تُعزف في رأسك أياماً بعد إغلاقه",
  "🔮 كل كتاب تُكمله يُوسّع العالم الذي تسكنه — إلى الأبد",
  "🌟 أنت اليوم مجموع كل ما قرأته — وغداً ستكون ما تقرأه الآن",
  "📜 قبل الطباعة كان نسخ كتاب يستغرق عاماً — نُرسله في ثوانٍ",
  "🏛️ مكتبة الإسكندرية احتوت ٥٠٠ ألف لفافة — مكتبتك اليوم بلا سقف",
];

export function tip(): string {
  return TIPS_POOL[Math.floor(Math.random() * TIPS_POOL.length)];
}

// ── ٧ مراحل بحث — سردية سينمائية ────────────────────────────
interface Stage {
  pct:    number;
  filled: number;
  icon:   string;
  header: string;
  sub:    string;
  mood:   string; // لون عاطفي للمرحلة
}

const STAGES: Stage[] = [
  {
    pct: 5,   filled: 1,  icon: "🔭",
    header: "أُطلق رادارات البحث",
    sub:    "أطرق أبواب ٢٠+ مكتبة رقمية عربية وعالمية",
    mood:   "🌑",
  },
  {
    pct: 22,  filled: 3,  icon: "📡",
    header: "أسبر أعماق المصادر",
    sub:    "foulabook · hindawi · waqfeya وسواها",
    mood:   "🌒",
  },
  {
    pct: 40,  filled: 4,  icon: "🗺️",
    header: "خريطة النتائج تتشكّل",
    sub:    "وجدت آثاراً — أُحكم التتبّع وأُضيّق الخناق",
    mood:   "🌓",
  },
  {
    pct: 55,  filled: 6,  icon: "🔬",
    header: "أُمحّص الجودة بدقّة",
    sub:    "فحص سلامة PDF — نُحكم الباب أمام الملفات الوهمية",
    mood:   "🌔",
  },
  {
    pct: 70,  filled: 7,  icon: "⚖️",
    header: "أنتقي أفضل المصادر",
    sub:    "نسبة النجاح التاريخية تقود الاختيار تلقائياً",
    mood:   "🌕",
  },
  {
    pct: 87,  filled: 9,  icon: "🚀",
    header: "الكتاب في طريقه إليك",
    sub:    "يتحوّل إلى بيانات تعبر الأثير الرقمي نحوك",
    mood:   "🌖",
  },
  {
    pct: 100, filled: 10, icon: "✅",
    header: "وصل الكتاب!",
    sub:    "أتمنّى لك قراءة ممتعة 📖",
    mood:   "🌟",
  },
];

export function buildProgress(stageIdx: number, bookName: string, extra = ""): string {
  const s = STAGES[Math.min(stageIdx, STAGES.length - 1)];

  let msg =
    `${s.icon} *${s.header}*\n` +
    `${HR}\n` +
    `📗 _"${escMd(bookName.slice(0, 50))}"_\n\n` +
    `\`${bar(s.filled)}\` *${s.pct}٪*  ${s.mood}\n` +
    `_${s.sub}_`;

  if (extra) msg += `\n\n${extra}`;
  return msg;
}

// ── رسالة الترحيب — مُخصَّصة لكل وقت ────────────────────────
export function buildWelcome(
  name: string,
  remaining: number,
  dailyLimit: number,
  sourcesCount: number,
  isPrem = false,
): string {
  const greeting = getTimeGreeting();
  const badge    = isPrem ? " ⭐" : "";
  const used     = Math.max(0, dailyLimit - remaining);
  const ind      = levelIndicator(remaining, dailyLimit);

  let usageLine: string;
  if (dailyLimit <= 0) {
    usageLine = `\`▰▰▰▰▰▰▰▰▰▰\`  ♾️  _رصيد بلا حدود_`;
  } else {
    const f = dailyLimit > 0 ? Math.round((used / dailyLimit) * 10) : 0;
    usageLine = `\`${bar(f)}\`  ${ind}  *${remaining}* / ${dailyLimit}`;
  }

  const quoteOfDay = getQuoteOfDay();

  return (
    `📚 *خلاصة الكتب*${badge}\n` +
    `${HR}\n\n` +
    `${greeting}، *${escMd(name)}*! 👋\n\n` +
    `اكتب اسم أي كتاب وأُرسله لك *PDF مجاناً*\n` +
    `_من ${sourcesCount}+ مصدر عربي وعالمي_\n\n` +
    `${HR}\n` +
    `${usageLine}\n` +
    `_يتجدد رصيدك كل منتصف ليل_ 🌙\n\n` +
    `_${quoteOfDay}_`
  );
}

// ── استقبال الطابور ────────────────────────────────────────────
export function buildQueueAccepted(
  bookName: string,
  position: number,
  isPrem: boolean,
): string {
  const badge = isPrem
    ? "⚡ *طلب مميّز — أولوية فائقة*"
    : "📋 *تم استقبال طلبك*";

  const posLine = position <= 1
    ? "🟢  يُعالَج الآن فوراً!"
    : `📍  موقعك في الطابور: *#${position}*`;

  const etaLine =
    position <= 1 ? "_ستصل نتيجتك خلال لحظات_" :
    position <= 2 ? `_طلب واحد قبلك — ثوانٍ قليلة_` :
    position <= 5 ? `_${position - 1} طلبات قبلك — أقل من دقيقتين_` :
    `_${position - 1} طلباً قبلك — نعمل بسرعة_ ⚡`;

  return (
    `${badge}\n` +
    `${HR}\n` +
    `📗 _"${escMd(bookName.slice(0, 50))}"_\n\n` +
    `${posLine}\n` +
    `${etaLine}\n\n` +
    `_/cancel للإلغاء · /queue لمعرفة الحالة_`
  );
}

// ── إشعار "وصل دورك" ───────────────────────────────────────────
export function buildTurnNotification(bookName: string, waitSec: number): string {
  const waitStr =
    waitSec >= 120 ? `${Math.floor(waitSec / 60)} دقيقة` :
    waitSec >= 60  ? "دقيقة كاملة" :
    `${waitSec} ثانية`;

  return (
    `🔔 *وصل دورك!*\n` +
    `${HR}\n` +
    `📗 _"${escMd(bookName.slice(0, 50))}"_\n\n` +
    `انتظرت *${waitStr}* بصبر جميل 🙏\n` +
    `جارٍ البحث والتجهيز الآن...`
  );
}

// ── طلبات معلّقة ───────────────────────────────────────────────
export function buildPendingMsg(): string {
  return (
    `⏳ *لديك طلب قيد المعالجة*\n` +
    `${HR}\n\n` +
    `انتظر حتى ينتهي طلبك الحالي قبل طلب كتاب آخر\n\n` +
    `_/cancel للإلغاء · /queue لمعرفة الحالة_`
  );
}

// ── رسالة النجاح ───────────────────────────────────────────────
export function buildSuccessMsg(
  bookName:  string,
  dlCount:   number,
  limit:     number,
  sizeMB?:   string,
  fromCache  = false,
): string {
  const headline  = fromCache
    ? "⚡ *وصل فوراً من الأرشيف!*"
    : "🎉 *وصل الكتاب!*";
  const cacheNote = fromCache
    ? "\n_إرسال لحظي من الكاش المحلي_ 🏎️"
    : "";

  let countLine: string;
  if (limit <= 0) {
    countLine = `\`▰▰▰▰▰▰▰▰▰▰\`  ♾️  _${dlCount} كتاب اليوم_`;
  } else {
    const f    = Math.round((dlCount / limit) * 10);
    const left = Math.max(0, limit - dlCount);
    const ind  = levelIndicator(left, limit);
    const note = left === 0
      ? "⛔ *وصلت للحد — يتجدد الرصيد الليلة*"
      : `${ind}  *${left}* كتاب متبقٍ`;
    countLine = `\`${bar(f)}\`  ${note}`;
  }

  return (
    `${headline}\n` +
    `${HR}\n\n` +
    `📗 *${escMd(bookName.slice(0, 56))}*` +
    (sizeMB ? `\n📦 _الحجم: ${sizeMB} ميغابايت_` : "") +
    `${cacheNote}\n\n` +
    `${countLine}`
  );
}

// ── رسالة فشل الإرسال + روابط يدوية ──────────────────────────
export function buildFailMsg(bookName: string, resultsCount: number): string {
  return (
    `🔗 *وجدت ${resultsCount} رابط مباشر*\n` +
    `${HR}\n` +
    `📗 _"${escMd(bookName.slice(0, 56))}"_\n\n` +
    `لم ينجح الإرسال التلقائي — اختر رابطاً مباشراً:\n`
  );
}

// ── لا نتائج ───────────────────────────────────────────────────
export function buildNoResults(bookName: string, _networkIssue: boolean): string {
  const smartTips = getSmartSearchTips(bookName);
  return (
    `😔 *لم أعثر على الكتاب*\n` +
    `${HR}\n` +
    `_"${escMd(bookName.slice(0, 50))}"_\n\n` +
    `💡 *جرّب هذه الحلول:*\n` +
    `${smartTips}\n\n` +
    `_نبحث في ٢٠+ مصدر — لكن ليس كل كتاب متاح رقمياً بعد_`
  );
}

// ── الحد اليومي ────────────────────────────────────────────────
export function buildDailyLimit(dlCount: number, limit: number, resetStr: string): string {
  return (
    `📵 *وصلت لحدّك اليومي*\n` +
    `${HR}\n\n` +
    `\`${bar(10)}\`  ⛔  *${limit} / ${limit}*\n\n` +
    `⏰ يتجدد رصيدك خلال *${resetStr}*\n\n` +
    `💡 _للحصول على حد أعلى تواصل مع المشرف_`
  );
}

// ── Rate limit ──────────────────────────────────────────────────
export function buildRateLimitMsg(max: number): string {
  return (
    `⏱️ *تمهّل لحظة!*\n` +
    `${HR}\n\n` +
    `الحد المسموح: *${max} طلبات / دقيقة*\n\n` +
    `_انتظر بضع ثوانٍ ثم أعد المحاولة_ 😌`
  );
}

// ── Fuzzy notice ────────────────────────────────────────────────
export function buildFuzzyNotice(originalName: string): string {
  return (
    `🔎 *لم أجد تطابقاً تاماً*\n` +
    `_أُجرّب أقرب عنوان لـ «${escMd(originalName.slice(0, 36))}»_`
  );
}

// ── Telegram API helpers ─────────────────────────────────────────
export async function editMsg(
  token: string, chatId: number, msgId: number, text: string, kb?: object,
): Promise<void> {
  if (!msgId) return;
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId, message_id: msgId, text,
      parse_mode: "Markdown", disable_web_page_preview: true,
    };
    if (kb) body.reply_markup = kb;
    // BUG FIX: بدون timeout كان fetch يمكن أن ينتظر للأبد → يُجمّد الـ Worker
    // 8 ثوانٍ كافية — Telegram عادةً يُجيب خلال ثانية، 8 ثوانٍ للحالات البطيئة
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {}
}

export async function deleteMsg(
  token: string, chatId: number, msgId: number,
): Promise<void> {
  if (!msgId) return;
  try {
    // BUG FIX: نفس المشكلة — timeout 5 ثوانٍ كافٍ لعملية DELETE
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: msgId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {}
}

// ── helpers ──────────────────────────────────────────────────────
function getTimeGreeting(): string {
  const h = (new Date().getUTCHours() + 3) % 24;
  if (h >= 3  && h < 5)  return "أهلاً بك في ساعة السحر";
  if (h >= 5  && h < 7)  return "فجر القراءة";
  if (h >= 7  && h < 10) return "صباح الكتب";
  if (h >= 10 && h < 12) return "ضحى مباركة";
  if (h >= 12 && h < 14) return "نهار طيب";
  if (h >= 14 && h < 17) return "مساء القراءة";
  if (h >= 17 && h < 19) return "أمسية مباركة";
  if (h >= 19 && h < 21) return "مساء النور";
  if (h >= 21 && h < 23) return "سهرة مباركة";
  return "ليلة القراءة";
}

// اقتباس اليوم — يتغيّر بشكل شبه يومي بناءً على رقم اليوم
function getQuoteOfDay(): string {
  const quotes = [
    "«الكتاب خير أنيس في الوحدة» — الإمام الشافعي",
    "«من أكثر من المطالعة ارتاض ذهنه» — ابن المقفع",
    "«العلم حياة القلوب، ونور الأبصار» — ابن القيم",
    "«من طلب العلم فليُكثر من المطالعة» — الغزالي",
    "«الكتب روضة يتنزّه فيها العقل» — الجاحظ",
    "«في المكتبة ألف صديق لا يخذلونك» — قول مأثور",
    "«العلم ينبّهك، والكتاب يُعلّمك» — حكمة عربية",
  ];
  const dayOfYear = Math.floor(Date.now() / (1000 * 60 * 60 * 24)) % quotes.length;
  return quotes[dayOfYear];
}

// نصائح بحث ذكية حسب طول الاسم
function getSmartSearchTips(bookName: string): string {
  const hasAuthor  = bookName.includes(" - ") || bookName.includes(" — ");
  const isLong     = bookName.length > 30;
  const isEnglish  = /[a-zA-Z]/.test(bookName);

  const tips: string[] = [];
  if (!hasAuthor) tips.push("◦ أضف اسم المؤلف: «العنوان — المؤلف»");
  if (isLong)     tips.push("◦ بسّط العنوان — احذف «الجزء» أو «الفصل»");
  if (!isEnglish) tips.push("◦ جرّب الاسم بالإنجليزي لو كان كتاباً مترجماً");
  tips.push("◦ جرّب مرادفاً أو عنواناً بديلاً");

  return tips.join("\n");
}

export const PROGRESS_STAGES = STAGES;
