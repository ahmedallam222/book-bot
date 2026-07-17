import { escMd } from "./text.js";
import { DAILY_LIMIT, PREMIUM_LIMIT, PREMIUM_STARS_PRICE } from "./config.js";
import {
  PROGRESS_VARIANTS,
  SUCCESS_TAGLINES,
  SUCCESS_TAGLINES_PREMIUM,
  CACHE_HIT_TAGLINES,
  PAID_BOOK_HEADLINES,
  NO_RESULTS_HEADLINES,
  PERSONALITY_LINES,
  PERSONALITY_LINE_CHANCE,
  SUCCESS_CTAS,
  SUCCESS_FOOTERS,
  PROGRESS_DIVIDERS,
  STAGE_NAME_POOLS,
  pickRandom,
  pickFresh,
  chance,
} from "./uiVariants.js";

// ══════════════════════════════════════════════
// UI — رفيق | نظام تصميم موحّد (v8 · نبرة دافئة)
// ──────────────────────────────────────────────
// فلسفة التجربة:
//   1) هرم بصري واضح: عنوان → فاصل → محتوى → تذييل
//   2) لغة عربية فصحى أنيقة بلا ضجيج
//   3) كل رسالة تجيب: ماذا يحدث؟ ماذا بعد؟
//   4) Markdown متوازن (* و _) لتجنّب أخطاء Telegram
// ══════════════════════════════════════════════

/** Primary section divider */
export const DIV = "━━━━━━━━━━━━━━━━";
export function divLine(): string {
  return pickFresh(PROGRESS_DIVIDERS, "div");
}
/** Soft secondary divider */
export const DIV_SOFT = "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄";

// Named journey stages (shown under progress)
const STAGE_NAMES = [
  "استقبال",
  "بحث",
  "توسيع",
  "نتائج",
  "تحقق",
  "تحميل",
  "إرسال",
] as const;

// Modern progress track — step 0..6
const PROGRESS_BARS = [
  "〔░░░░░░░░░░〕",
  "〔█░░░░░░░░░〕",
  "〔███░░░░░░░〕",
  "〔█████░░░░░〕",
  "〔███████░░░〕",
  "〔█████████░〕",
  "〔██████████〕",
];

const PROGRESS_STEPS_COUNT = 7;

/** Visual stage map: ● completed/current  ○ upcoming */
function stageMap(step: number): string {
  const n = STAGE_NAME_POOLS.length;
  const s = Math.max(0, Math.min(step, n - 1));
  const dots = Array.from({ length: n }, (_, i) => (i <= s ? "●" : "○")).join(" ");
  const name = pickFresh(STAGE_NAME_POOLS[s], `stage:${s}`);
  return `\`${dots}\`  _${name}_`;
}

function balanceBar(used: number, limit: number): { bar: string; emoji: string; remaining: number } {
  if (limit <= 0) return { bar: "∞", emoji: "♾️", remaining: 999 };
  const remaining = Math.max(0, limit - used);
  const filled = Math.round((used / limit) * 10);
  const bar = "█".repeat(Math.min(filled, 10)) + "░".repeat(Math.max(0, 10 - filled));
  const emoji = remaining === 0 ? "⛔" : remaining <= 2 ? "🟡" : "🟢";
  return { bar, emoji, remaining };
}

// ── شريط تقدّم سينمائي ───────────────────────

export function buildProgress(step: number, bookName: string, extraLine?: string, elapsedSec?: number): string {
  const variantPool = PROGRESS_VARIANTS[step] ?? PROGRESS_VARIANTS[0];
  const s = pickFresh(variantPool, `prog:${step}`);
  const bar = PROGRESS_BARS[step] ?? PROGRESS_BARS[0];
  const pct = Math.round((step / (PROGRESS_STEPS_COUNT - 1)) * 100);
  const title = escMd(bookName.slice(0, 52));
  const timeBit = (typeof elapsedSec === "number" && elapsedSec >= 3)
    ? ` · ⏱ _${elapsedSec}ث_`
    : "";

  let msg =
    `${s.icon} *${s.label}*${timeBit}\n` +
    `${divLine()}\n` +
    `${bar}  *${pct}%*\n` +
    `${stageMap(step)}\n\n` +
    `📖  _«${title}»_`;

  if (extraLine) {
    msg += `\n\n${DIV_SOFT}\n${extraLine}`;
  }
  return msg;
}

// ── نصائح ذكية ───────────────────────────────

const TIPS_FREE = [

  "🪄 _اكتب عنوان الكتاب فقط — مثل: الأمير الصغير_",
  "⚡ _إن طلبت الكتاب سابقاً… يصل إليك أسرع_",
  "📘 _بعد التحميل: اضغط «ملخّص سريع» إن رغبت_",
  "👥 _في المجموعات: اكتب عنوان الكتاب مباشرةً_",
  "🔔 _/last يعيد إرسال آخر كتاب طلبته_",
  "🧠 _أضف المؤلف بعد العنوان لدقّة أعلى_",
  "🌙 _/random أو زر «كتاب مفاجأة» لاختيار عشوائي_",
  "⭐ _Premium = أولوية طابور + حد أعلى_",

  "💡 _أضف اسم المؤلف بعد العنوان — يضاعف دقّة النتائج_",
  "🎲 _جرّب /random لكتاب مفاجأة يناسب ذوقك_",
  "🔖 _/wishlist يحفظ ما تريد قراءته لاحقاً_",
  "📅 _/weekly — أكثر الكتب تحميلاً هذا الأسبوع_",
  "👥 _في المجموعات: اكتب عنوان الكتاب مباشرةً_",
  "⚡ _الكتب المحفوظة سابقاً تصلك في ثوانٍ_",
  "🌍 _أبحث في مكتبات عربية متعدّدة معاً_",
  "🎯 _اكتب العنوان… دون كلمة pdf أو تحميل_",
  `⭐ _Premium: ${PREMIUM_LIMIT} تحميلاً/يوم بـ ${PREMIUM_STARS_PRICE} Stars_`,
];

const TIPS_PREMIUM = [
  "💡 _أضف اسم المؤلف — يضاعف دقّة النتائج_",
  "🎲 _/random لكتاب مفاجأة من مكتبتنا_",
  "🔖 _قائمتك تتّسع لـ 50 كتاباً — استغلّها_",
  "📅 _/weekly — نبض القرّاء هذا الأسبوع_",
  "⚡ _طلباتك بأولوية قصوى دائماً_",
  "🌍 _أبحث في مكتبات عربية متعدّدة معاً_",
  "🎯 _العنوان فقط — بلا كلمات زائدة_",
  "📚 _سجّلك يحتفظ بآخر 20 كتاباً حمّلتها_",
  "⭐ _شكراً لثقتك — رفيق معك_",
];

export function tip(isPrem = false): string {
  const pool = isPrem ? TIPS_PREMIUM : TIPS_FREE;
  return pickFresh(pool, isPrem ? "tip_p" : "tip_f");
}

// ── editMsg / deleteMsg ───────────────────────

export async function editMsg(
  token: string, chatId: number, msgId: number, text: string
): Promise<void> {
  if (!msgId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    chatId,
        message_id: msgId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch {}
}

export async function deleteMsg(
  token: string, chatId: number, msgId: number
): Promise<void> {
  if (!msgId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: msgId }),
    });
  } catch {}
}

// ── رسالة النجاح ─────────────────────────────

export function buildSuccessMsg(
  bookName:  string,
  dlCount:   number,
  limit:     number,
  sizeMB?:   string,
  fromCache  = false,
  isPrem     = false,
  streakLine?: string,
): string {
  const sizeStr   = sizeMB && sizeMB !== "?" ? ` · *${sizeMB} MB*` : "";
  const cacheStr  = fromCache ? `
${pickFresh(CACHE_HIT_TAGLINES, "cache")}` : "";
  const premBadge = isPrem ? " ⭐" : "";
  const { bar, emoji, remaining } = balanceBar(dlCount, limit);

  let balanceLine: string;
  if (limit <= 0) {
    balanceLine = "♾️ *رصيد غير محدود*";
  } else {
    balanceLine = `${emoji} \`${bar}\`  *${remaining}/${limit}* متبقٍّ اليوم`;
  }

  const tagline = isPrem
    ? pickFresh(SUCCESS_TAGLINES_PREMIUM, "ok_prem")
    : pickFresh(SUCCESS_TAGLINES, "ok");

  const personality = chance(PERSONALITY_LINE_CHANCE)
    ? `
${pickFresh(PERSONALITY_LINES, "persona")}`
    : "";

  const streakPart = streakLine ? `
${streakLine}` : "";
  const title = escMd(bookName.slice(0, 52));
  const cta = pickFresh(SUCCESS_CTAS, "cta");
  const footer = pickFresh(SUCCESS_FOOTERS, "footer");

  const premHint = (!isPrem && remaining <= 2 && limit > 0)
    ? `

⭐ *Premium:* ${PREMIUM_LIMIT} تحميلاً/يوم · أولوية طابور · بـ ${PREMIUM_STARS_PRICE} Stars
→ /premium`
    : (isPrem ? `

⭐ _Premium نشط — أولوية + ${limit} تحميلاً/يوم_` : "");

  // Clean “card” layout after PDF delivery — reads like a mini app card
  return (
    `${tagline}${premBadge}
` +
    `${divLine()}
` +
    `📗  *«${title}»*${sizeStr}${cacheStr}

` +
    `${balanceLine}${streakPart}

` +
    `${cta}` +
    `${personality}${premHint}

` +
    `${footer}`
  );
}

// ── لا نتائج ─────────────────────────────────

export function buildNoResults(
  bookName: string,
  _usedFuzzy: boolean,
  apologetic = false,
): string {
  const apology = apologetic
    ? `🙏 _عذراً — بحثتُ في المصادر المتاحة._\n\n`
    : "";
  const title = escMd(bookName.slice(0, 52));
  return (
    apology +
    `${pickFresh(NO_RESULTS_HEADLINES, "nores")}\n` +
    `${DIV}\n` +
    `📖  _«${title}»_\n\n` +
    `*جرّب تحسين البحث:*\n` +
    `◦ العنوان الرئيسي فقط\n` +
    `◦ أضف اسم المؤلف بعده\n` +
    `◦ راجع الإملاء والتشكيل\n\n` +
    `_بعض الكتب مدفوعة أو غير منشورة رقمياً — أو لم تمرّ فحوصات جودة الملف._`
  );
}

// ── روابط فقط ────────────────────────────────

export function buildLinksOnly(
  bookName: string,
  links: readonly string[],
): string {
  if (!links || links.length === 0) {
    return buildNoResults(bookName, false, /* apologetic */ true);
  }
  const top = links.slice(0, 3);
  const linksBlock = top
    .map((u, i) => `  ${i + 1}\\. ${escMd(u)}`)
    .join("\n");
  const title = escMd(bookName.slice(0, 52));
  return (
    `🔗 *وجدتُ أثراً — لكن التحميل التلقائي تعذّر*\n` +
    `${DIV}\n` +
    `📖  _«${title}»_\n\n` +
    `*روابط يمكنك فتحها يدوياً:*\n` +
    `${linksBlock}\n\n` +
    `_قد يطلب المصدر تأكيداً أو تجاوز إعلان قبل التحميل._`
  );
}

// ── ملف أكبر من حد البوت ─────────────────────

export function buildTooLargeMsg(
  bookName: string,
  openableLinks: readonly string[] = [],
): string {
  const title = escMd(bookName.slice(0, 52));
  let linkBlock = "";
  if (openableLinks.length > 0) {
    const lines = openableLinks.slice(0, 3).map((u, i) => `  ${i + 1}\\. ${u}`);
    linkBlock =
      `\n\n*افتح من تطبيق تيليجرام* _(يقبل ملفات أكبر من البوت):_\n` +
      lines.join("\n");
  }
  return (
    `📦 *الكتاب أكبر من حدّ تيليجرام للبوت*\n` +
    `${DIV}\n` +
    `📖  _«${title}»_\n\n` +
    `وجدتُ النسخة، لكن حجمها يتجاوز *50 MB* — وهذا سقف رفع الملفات للبوتات.\n\n` +
    `*ما الذي يمكنك فعله؟*\n` +
    `◦ اطلب جزءاً أو مجلّداً محدّداً\n` +
    `◦ جرّب صياغة «مختصر» أو «طبعة صغيرة»\n` +
    `◦ افتح الرابط في تطبيق تيليجرام مباشرة` +
    linkBlock
  );
}

// ── كتاب مدفوع ───────────────────────────────

export function buildPaidBookMessage(
  bookName: string,
  apologetic = false,
): string {
  const apology = apologetic
    ? `🙏 _عذراً — لم أجد نسخة مجّانية موثوقة._\n\n`
    : "";
  const title = escMd(bookName.slice(0, 52));
  return (
    apology +
    `${pickFresh(PAID_BOOK_HEADLINES, "paid")}\n` +
    `${DIV}\n` +
    `📖  _«${title}»_\n\n` +
    `يبدو أن هذا العمل *لا يتوفّر كـ PDF مجّاني* في المصادر المتاحة.\n\n` +
    `*احتمالات شائعة:*\n` +
    `◦ يُباع في متاجر الكتب\n` +
    `◦ متاح للقراءة فقط على موقع الناشر\n` +
    `◦ غير منشور رقمياً بعد\n\n` +
    `_إن كنت متأكّداً من وجود نسخة مجّانية، جرّب صياغة أخرى أو أضف المؤلف._`
  );
}

// ── الحد اليومي ──────────────────────────────

export function buildDailyLimit(
  dlCount:   number,
  limit:     number,
  resetTime: string,
  isPrem     = false,
): string {
  const { bar } = balanceBar(limit, limit); // full bar

  if (isPrem) {
    return (
      `⛔ *اكتمل رصيدك اليومي*\n` +
      `${DIV}\n` +
      `\`${bar}\`  *${dlCount}/${limit}* ⭐\n\n` +
      `🌙 يتجدّد رصيدك بعد *${resetTime}*\n\n` +
      `_قرأتَ كثيراً اليوم — أنت قارئ حقيقي._ 📚`
    );
  }

  return (
    `⛔ *اكتمل رصيدك اليومي*\n` +
    `${DIV}\n` +
    `\`${bar}\`  *${dlCount}/${limit}*\n\n` +
    `🌙 يتجدّد رصيدك بعد *${resetTime}*\n\n` +
    `⭐ *Premium* — ${PREMIUM_LIMIT} تحميلاً/يوم بـ ${PREMIUM_STARS_PRICE} Stars\n` +
    `_اضغط الزر أدناه أو /premium_`
  );
}

// ── rate limit ───────────────────────────────

export function buildRateLimitMsg(_max: number): string {
  return (
    `⏱️ *تمهّل لحظة*\n` +
    `${DIV}\n` +
    `أرسلتَ طلبات متتالية بسرعة عالية.\n\n` +
    `_انتظر بضع ثوانٍ ثم أعد المحاولة — أنا معك._ 🙏`
  );
}

// ── قبول الطابور ─────────────────────────────

export function buildQueueAccepted(bookName: string, position: number, isHigh: boolean): string {
  let posStr: string;
  if (position <= 1) {
    posStr = "🟢  _يُعالَج الآن مباشرةً_";
  } else if (position <= 3) {
    posStr = `🔢  موقعك *#${position}* — _لحظات قليلة_`;
  } else {
    const estMin = Math.ceil(position * 0.75);
    posStr = `🔢  موقعك *#${position}* — _حوالي ${estMin} د_`;
  }

  const badge    = isHigh ? " ⭐" : "";
  const subtitle = isHigh
    ? "_في مقدّمة الطابور — أولوية Premium_"
    : "_في طابور المعالجة_";
  const title = escMd(bookName.slice(0, 52));

  return (
    `📬 *طلبك في الطريق${badge}*\n` +
    `${DIV}\n` +
    `📖  _«${title}»_\n` +
    `${subtitle}\n\n` +
    `${posStr}`
  );
}

// ── طلب معلّق ────────────────────────────────

export function buildPendingMsg(): string {
  return (
    `⏳ *لديك طلب قيد المعالجة*\n` +
    `${DIV}\n` +
    `انتظر اكتماله قبل طلب كتاب آخر.\n\n` +
    `◦ /queue — حالة طلبك\n` +
    `◦ /cancel — إلغاء والبدء من جديد`
  );
}

// ── وصل دورك ─────────────────────────────────

export function buildTurnNotification(bookName: string, waitSec: number): string {
  const waitStr = waitSec >= 60
    ? `${Math.floor(waitSec / 60)} دقيقة`
    : `${waitSec} ثانية`;
  const title = escMd(bookName.slice(0, 52));
  return (
    `🔔 *وصل دورك!*\n` +
    `${DIV}\n` +
    `📖  _«${title}»_\n` +
    `⏱️ انتظرتَ *${waitStr}*\n\n` +
    `_أبدأ البحث الآن بكل طاقتي..._ 🚀`
  );
}