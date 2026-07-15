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
  pickRandom,
  chance,
} from "./uiVariants.js";

// ══════════════════════════════════════════════
// UI — خلاصة الكتب | نظام تصميم موحّد (v7)
// ──────────────────────────────────────────────
// فلسفة التجربة:
//   1) هرم بصري واضح: عنوان → فاصل → محتوى → تذييل
//   2) لغة عربية فصحى أنيقة بلا ضجيج
//   3) كل رسالة تجيب: ماذا يحدث؟ ماذا بعد؟
//   4) Markdown متوازن (* و _) لتجنّب أخطاء Telegram
// ══════════════════════════════════════════════

/** Primary section divider */
export const DIV = "━━━━━━━━━━━━━━━━";
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
  const n = STAGE_NAMES.length;
  const s = Math.max(0, Math.min(step, n - 1));
  const dots = STAGE_NAMES.map((_, i) => (i <= s ? "●" : "○")).join(" ");
  const name = STAGE_NAMES[s];
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

export function buildProgress(step: number, bookName: string, extraLine?: string): string {
  const variantPool = PROGRESS_VARIANTS[step] ?? PROGRESS_VARIANTS[0];
  const s = pickRandom(variantPool);
  const bar = PROGRESS_BARS[step] ?? PROGRESS_BARS[0];
  const pct = Math.round((step / (PROGRESS_STEPS_COUNT - 1)) * 100);
  const title = escMd(bookName.slice(0, 52));

  let msg =
    `${s.icon} *${s.label}*\n` +
    `${DIV}\n` +
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
  "💡 _أضف اسم المؤلف بعد العنوان — يضاعف دقّة النتائج_",
  "🎲 _جرّب /random لكتاب مفاجأة يناسب ذوقك_",
  "🔖 _/wishlist يحفظ ما تريد قراءته لاحقاً_",
  "📅 _/weekly — أكثر الكتب تحميلاً هذا الأسبوع_",
  "👥 _في المجموعات: بوت + اسم الكتاب_",
  "⚡ _الكتب المحفوظة سابقاً تصلك في ثوانٍ_",
  "🌍 _أبحث في مكتبات عربية متعدّدة معاً_",
  "🎯 _اكتب العنوان فقط — بلا «رواية» أو «pdf»_",
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
  "⭐ _شكراً لثقتك — أنت قارئ من الطراز الرفيع_",
];

export function tip(isPrem = false): string {
  const pool = isPrem ? TIPS_PREMIUM : TIPS_FREE;
  return pool[Math.floor(Math.random() * pool.length)];
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
  const sizeStr   = sizeMB ? ` · *${sizeMB} MB*` : "";
  const cacheStr  = fromCache ? `\n${pickRandom(CACHE_HIT_TAGLINES)}` : "";
  const premBadge = isPrem ? " ⭐" : "";
  const { bar, emoji, remaining } = balanceBar(dlCount, limit);

  let balanceLine: string;
  if (limit <= 0) {
    balanceLine = "♾️ *رصيد غير محدود*";
  } else {
    balanceLine = `${emoji} \`${bar}\`  *${remaining}/${limit}* متبقٍّ اليوم`;
  }

  const tagline = isPrem
    ? pickRandom(SUCCESS_TAGLINES_PREMIUM)
    : pickRandom(SUCCESS_TAGLINES);

  const personality = chance(PERSONALITY_LINE_CHANCE)
    ? `\n\n${pickRandom(PERSONALITY_LINES)}`
    : "";

  const streakPart = streakLine ? `\n${streakLine}` : "";
  const title = escMd(bookName.slice(0, 52));

  return (
    `${tagline}${premBadge}\n` +
    `${DIV}\n` +
    `📗  _«${title}»_${sizeStr}${cacheStr}\n\n` +
    `${balanceLine}${streakPart}${personality}`
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
    `${pickRandom(NO_RESULTS_HEADLINES)}\n` +
    `${DIV}\n` +
    `📖  _«${title}»_\n\n` +
    `*جرّب تحسين البحث:*\n` +
    `◦ العنوان الرئيسي فقط\n` +
    `◦ أضف اسم المؤلف بعده\n` +
    `◦ راجع الإملاء والتشكيل\n\n` +
    `_بعض الكتب مدفوعة أو غير منشورة رقمياً._`
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
    `${pickRandom(PAID_BOOK_HEADLINES)}\n` +
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