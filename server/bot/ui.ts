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
// UI — خلاصة الكتب | تجربة غامرة
// ══════════════════════════════════════════════

// ── شريط تقدم سينمائي ─────────────────────────

const PROGRESS_BARS = [
  "░░░░░░░░░░",
  "▓░░░░░░░░░",
  "▓▓▓░░░░░░░",
  "▓▓▓▓▓░░░░░",
  "▓▓▓▓▓▓▓░░░",
  "▓▓▓▓▓▓▓▓▓░",
  "▓▓▓▓▓▓▓▓▓▓",
];

const PROGRESS_STEPS_COUNT = 7;

export function buildProgress(step: number, bookName: string, extraLine?: string): string {
  // Pick a random variant for this step from the pool. Falls back
  // to the step-0 pool if step is out of range (defensive).
  const variantPool = PROGRESS_VARIANTS[step] ?? PROGRESS_VARIANTS[0];
  const s = pickRandom(variantPool);
  const bar = PROGRESS_BARS[step] ?? PROGRESS_BARS[0];
  const pct = Math.round((step / (PROGRESS_STEPS_COUNT - 1)) * 100);

  let msg =
    `${s.icon} *${s.label}...*\n` +
    `\`${bar}\` ${pct}%\n\n` +
    `📖 _"${escMd(bookName.slice(0, 55))}"_`;

  if (extraLine) msg += `\n\n${extraLine}`;
  return msg;
}

// ── نصائح ذكية — مختلفة للعادي والـ Premium ──

const TIPS_FREE = [
  "💎 _أضف اسم المؤلف — يضاعف دقة النتائج_",
  "🎲 _جرّب /random لكتاب مفاجأة يناسب ذوقك_",
  "🔖 _/wishlist لحفظ ما تريد قراءته لاحقاً_",
  "📅 _/weekly — أكثر الكتب تحميلاً هذا الأسبوع_",
  "👥 _استخدمني في المجموعات: بوت اسم الكتاب_",
  "⚡ _الكتاب المحفوظ مسبقاً يصلك في ثوانٍ_",
  "🌍 _أبحث في مكتبات عربية متعددة في آنٍ واحد_",
  "🎯 _اكتب العنوان فقط — بدون كلمة رواية أو pdf_",
  `⭐ _ترقّ لـ Premium — ${PREMIUM_LIMIT} تحميل/يوم بـ ${PREMIUM_STARS_PRICE} Stars فقط_`,
];

const TIPS_PREMIUM = [
  "💎 _أضف اسم المؤلف — يضاعف دقة النتائج_",
  "🎲 _جرّب /random لكتاب مفاجأة يناسب ذوقك_",
  "🔖 _قائمتك تتسع لـ 50 كتاب كـ Premium — استغلّها!_",
  "📅 _/weekly — أكثر الكتب تحميلاً هذا الأسبوع_",
  "👥 _استخدمني في المجموعات: بوت اسم الكتاب_",
  "⚡ _طلباتك بأولوية قصوى — تُعالَج أولاً دائماً_",
  "🌍 _أبحث في مكتبات عربية متعددة في آنٍ واحد_",
  "🎯 _اكتب العنوان فقط — بدون كلمة رواية أو pdf_",
  "📚 _سجلّك يحتفظ بآخر 20 كتاب حمّلتها_",
];

/** isPrem اختياري — لو مش موجود بيستخدم الـ tips العادية */
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
): string {
  const sizeStr   = sizeMB ? ` · *${sizeMB} MB*` : "";
  const cacheStr  = fromCache ? `\n${pickRandom(CACHE_HIT_TAGLINES)}` : "";
  const premBadge = isPrem ? " ⭐" : "";

  let balanceLine: string;
  if (limit <= 0) {
    balanceLine = "♾️ رصيد غير محدود";
  } else {
    const remaining = Math.max(0, limit - dlCount);
    const filled    = Math.round((dlCount / limit) * 8);
    const bar       = "█".repeat(Math.min(filled, 8)) + "░".repeat(Math.max(0, 8 - filled));
    const emoji     = remaining === 0 ? "⛔" : remaining <= 2 ? "🟡" : "🟢";
    balanceLine     = `${emoji} \`${bar}\` *${remaining}/${limit}* متبقٍّ اليوم`;
  }

  const tagline = isPrem
    ? pickRandom(SUCCESS_TAGLINES_PREMIUM)
    : pickRandom(SUCCESS_TAGLINES);

  // Occasionally append a personality line (~10% by default).
  const personality = chance(PERSONALITY_LINE_CHANCE)
    ? `\n\n${pickRandom(PERSONALITY_LINES)}`
    : "";

  return (
    `${tagline}${premBadge}\n` +
    `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
    `📗 _"${escMd(bookName.slice(0, 55))}"_${sizeStr}${cacheStr}\n\n` +
    `${balanceLine}${personality}`
  );
}

// ── رسالة لا نتائج ───────────────────────────

// `apologetic` — when true, prepends a brief apology line. Used on
// failure paths where we want to be visibly contrite (e.g. group chats
// where the bot replies to the asker by quoting their message — see
// performFullSearch's reply_to_message_id wiring). No-op otherwise.
export function buildNoResults(
  bookName: string,
  _usedFuzzy: boolean,
  apologetic = false,
): string {
  const apology = apologetic
    ? `🙏 _عذراً، حاولت من المصادر المتاحة._\n\n`
    : "";
  return (
    apology +
    `${pickRandom(NO_RESULTS_HEADLINES)}\n` +
    `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
    `_"${escMd(bookName.slice(0, 55))}"_\n\n` +
    `جرّب:\n` +
    `◦ اكتف بالعنوان الرئيسي فقط\n` +
    `◦ أضف اسم المؤلف بعد العنوان\n` +
    `◦ تأكد من الإملاء الصحيح\n\n` +
    `_بعض الكتب مدفوعة أو غير متاحة رقمياً._`
  );
}

// ── رسالة كتاب مدفوع / غير متوفر مجاناً ───────
// Sent when classifyAccess() flagged at least one search result as
// paid/protected (matches PROTECTED_ACCESS_PATTERNS like "اشترِ", "buy now",
// "premium", licensed-only catalogs) AND every download attempt failed.
// This replaces the misleading silent "no PDF" outcome — and prevents
// the bot from sending the wrong author's book just because the PDF
// host was on the trusted list.
export function buildPaidBookMessage(
  bookName: string,
  apologetic = false,
): string {
  const apology = apologetic
    ? `🙏 _عذراً، فحصت المصادر ولم أجد نسخة مجانية._\n\n`
    : "";
  return (
    apology +
    `${pickRandom(PAID_BOOK_HEADLINES)}\n` +
    `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
    `_"${escMd(bookName.slice(0, 55))}"_\n\n` +
    `يبدو أن هذا الكتاب لا يتوفر له *PDF مجاني* في المصادر المتاحة.\n\n` +
    `قد يكون:\n` +
    `◦ مدفوعاً — يُباع في متاجر الكتب\n` +
    `◦ متاحاً للقراءة فقط على موقع الناشر\n` +
    `◦ غير منشور رقمياً بعد\n\n` +
    `_لو تعتقد أنه متاح مجاناً، جرّب صياغة أخرى أو أضِف اسم المؤلف._`
  );
}

// ── رسالة الحد اليومي ────────────────────────

export function buildDailyLimit(
  dlCount:   number,
  limit:     number,
  resetTime: string,
  isPrem     = false,
): string {
  const bar = "█".repeat(8) + "░░";

  if (isPrem) {
    return (
      `⛔ *اكتمل رصيدك اليومي*\n` +
      `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
      `\`${bar}\` *${dlCount}/${limit}* ⭐\n\n` +
      `🌙 يتجدد رصيدك بعد *${resetTime}*\n\n` +
      `_قرأت كثيراً اليوم — أنت قارئ حقيقي!_ 📚`
    );
  }

  return (
    `⛔ *اكتمل رصيدك اليومي*\n` +
    `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
    `\`${bar}\` *${dlCount}/${limit}*\n\n` +
    `🌙 يتجدد رصيدك بعد *${resetTime}*\n\n` +
    `⭐ _ترقّ لـ Premium — ${PREMIUM_LIMIT} تحميل/يوم بـ ${PREMIUM_STARS_PRICE} Stars_`
  );
}

// ── رسالة rate limit ──────────────────────────

export function buildRateLimitMsg(_max: number): string {
  return (
    `⏱️ *تمهّل قليلاً!*\n` +
    `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
    `أرسلت طلبات كثيرة في وقت قصير جداً\n\n` +
    `_انتظر بضع ثوانٍ ثم أعد المحاولة_ 🙏`
  );
}

// ── رسالة قبول الطابور ───────────────────────

export function buildQueueAccepted(bookName: string, position: number, isHigh: boolean): string {
  let posStr: string;
  if (position <= 1) {
    posStr = "🟢 _يُعالَج الآن مباشرةً..._";
  } else if (position <= 3) {
    posStr = `🔢 موقعك: *#${position}* — _بعد لحظات قليلة_`;
  } else {
    const estMin = Math.ceil(position * 0.75);
    posStr = `🔢 موقعك: *#${position}* — _حوالي ${estMin} دقيقة_`;
  }

  const badge    = isHigh ? " ⭐" : "";
  const subtitle = isHigh
    ? "_طلبك في مقدمة الطابور — أولوية Premium_"
    : "_في طابور المعالجة_";

  return (
    `📬 *في الطريق${badge}*\n` +
    `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
    `📖 _"${escMd(bookName.slice(0, 55))}"_\n` +
    `${subtitle}\n\n` +
    `${posStr}`
  );
}

// ── رسالة طلب معلق ───────────────────────────

export function buildPendingMsg(): string {
  return (
    `⏳ *لديك طلب قيد المعالجة*\n\n` +
    `_انتظر حتى يكتمل ثم اطلب كتاباً آخر_\n\n` +
    `◦ /queue لمعرفة حالة طلبك\n` +
    `◦ /cancel لإلغائه والبدء من جديد`
  );
}

// ── رسالة "وصل دورك" ─────────────────────────

export function buildTurnNotification(bookName: string, waitSec: number): string {
  const waitStr = waitSec >= 60
    ? `${Math.floor(waitSec / 60)} دقيقة`
    : `${waitSec} ثانية`;
  return (
    `🔔 *وصل دورك!*\n` +
    `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
    `📖 _"${escMd(bookName.slice(0, 55))}"_\n` +
    `⏱️ انتظرت بصبر *${waitStr}*\n\n` +
    `_أبحث الآن بكل طاقتي..._ 🚀`
  );
}
