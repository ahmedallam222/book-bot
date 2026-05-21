// ══════════════════════════════════════════════
// IMAGE GENERATION — nano-banana API
// ══════════════════════════════════════════════
//
// /img <prompt> — يولّد صورة عن طريق nano-banana endpoint
// خارجي ويرسلها كصورة في تيليغرام.
//
// الحدود:
//   - IMAGE_DAILY_LIMIT صورة لكل user في اليوم (افتراضي 5)
//     عداد مخزّن في Redis تحت `img:daily:{userId}:{YYYY-MM-DD}`
//     مع EX = ثواني حتى منتصف ليل القاهرة. لا يتداخل مع
//     downloads daily limit (storage.getDailyDownloadCount).
//   - timeout 90s لاستدعاء nano-banana (API تستغرق ~42s نموذجياً)
//   - prompt يُرسل كما هو بدون ترجمة — أي لغة مسموحة.
//
// الـ endpoint يرجع JSON على الصيغة:
//   { url: "https://.../img_xxxx.png", prompt: "...", time_taken: "42.23 sec" }
// نمرّر الـ URL مباشرة لـ bot.sendPhoto — تيليغرام يحمّلها بنفسه.
// لا حاجة لتنزيل الـ image مؤقتاً عندنا.

import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { redis } from "./redis.js";
import { isAdmin } from "./guards.js";
import { reactRandom } from "./reactions.js";
import { REACTION_RECEIVED } from "./uiVariants.js";
import { escMd, cairoDateString, msUntilCairoMidnight } from "./text.js";
import {
  MAINTENANCE_KEY,
  IMAGE_DAILY_LIMIT,
  NANO_BANANA_API_KEY,
  NANO_BANANA_ENDPOINT,
  TIMEOUT_IMAGE_GEN,
} from "./config.js";

const MAX_PROMPT_LEN = 1000;
const MIN_PROMPT_LEN = 3;

// ── Nano Banana usage tracking keys (read from admin panel) ──
// عدّاد إجمالي مدى الحياة لكل مستخدم — sorted set عشان نقدر نسحب أعلى المستخدمين
// بـ ZREVRANGE بدون scan على آلاف keys. score = عدد مرات الاستدعاء الناجحة.
const NB_TOP_USERS_KEY = "img:topUsers";
// إجمالي يومي لكل المستخدمين (success فقط) — مع TTL حتى منتصف ليل القاهرة.
const NB_DAILY_TOTAL_PREFIX = "img:daily:total:";
// إجمالي مدى الحياة (success + fail نُتركهما منفصلين، الموجودَين بالفعل
// أسفل: `tel:imageGen:success` و `tel:imageGen:fail`).
const NB_TOTAL_SUCCESS_KEY = "tel:imageGen:success";
const NB_TOTAL_FAIL_KEY    = "tel:imageGen:fail";

interface NanoBananaResponse {
  url?: string;
  prompt?: string;
  time_taken?: string;
  error?: string;
}

function imageDailyKey(userId: string): string {
  return `img:daily:${userId}:${cairoDateString()}`;
}

// عداد ذرّي مع TTL ثابت حتى منتصف ليل القاهرة.
// نستخدم INCR ثم EXPIRE فقط عند أول increment (NX). لو الاستدعاء
// Redis فشل، نرجع 0 ونسمح بالعملية (fail-open) عشان عطل Redis
// مؤقت ما يقفلش الميزة بالكامل.
async function bumpDailyImageCount(userId: string): Promise<number> {
  const key = imageDailyKey(userId);
  try {
    const ttlSec = Math.max(60, Math.ceil(msUntilCairoMidnight() / 1000));
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, ttlSec).catch(() => {});
    }
    return count;
  } catch (e) {
    L.warn("imageGen", "bumpDailyImageCount failed (fail-open)", { err: String(e).slice(0, 100) });
    return 0;
  }
}

async function getDailyImageCount(userId: string): Promise<number> {
  try {
    const v = await redis.get(imageDailyKey(userId));
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

// undo زيادة العداد لو الاستدعاء فشل بعد ما زدنا. ليس critical
// عشان العداد يصفر تلقائياً عند منتصف الليل.
async function decrDailyImageCount(userId: string): Promise<void> {
  try {
    await redis.decr(imageDailyKey(userId));
  } catch { /* swallow */ }
}

// ── Stats helpers (for admin panel) ───────────
// نسجّل كل استدعاء ناجح في: (1) عدّاد المستخدم في sorted set،
// (2) عدّاد اليوم لكل المستخدمين. fail-open: لو Redis فشل ما نأخّرش
// رد البوت ولا نطلع error لليوزر.
async function recordSuccessfulImage(userId: string): Promise<void> {
  try {
    await redis.zincrby(NB_TOP_USERS_KEY, 1, userId);
  } catch { /* swallow */ }
  try {
    const key = `${NB_DAILY_TOTAL_PREFIX}${cairoDateString()}`;
    const count = await redis.incr(key);
    if (count === 1) {
      const ttlSec = Math.max(60, Math.ceil(msUntilCairoMidnight() / 1000));
      await redis.expire(key, ttlSec).catch(() => {});
    }
  } catch { /* swallow */ }
}

export interface ImageGenStats {
  totalSuccess: number;
  totalFail:    number;
  todayCount:   number;
  topUsers:     { userId: string; count: number }[];
}

// يُقرأ من admin panel. يرجع zeros لو Redis تعطّل عشان ما يكسرش
// الـ panel كله من أجل قسم إحصاءات واحد.
export async function getImageGenStats(topN = 10): Promise<ImageGenStats> {
  const safeInt = async (key: string): Promise<number> => {
    try {
      const v = await redis.get(key);
      return v ? parseInt(v, 10) || 0 : 0;
    } catch { return 0; }
  };

  const [totalSuccess, totalFail, todayCount, topRaw] = await Promise.all([
    safeInt(NB_TOTAL_SUCCESS_KEY),
    safeInt(NB_TOTAL_FAIL_KEY),
    safeInt(`${NB_DAILY_TOTAL_PREFIX}${cairoDateString()}`),
    redis.zrevrange(NB_TOP_USERS_KEY, 0, Math.max(0, topN - 1), "WITHSCORES")
      .catch(() => [] as string[]),
  ]);

  const topUsers: { userId: string; count: number }[] = [];
  for (let i = 0; i < topRaw.length; i += 2) {
    const userId = topRaw[i];
    const count  = parseInt(topRaw[i + 1] ?? "0", 10) || 0;
    if (userId) topUsers.push({ userId, count });
  }

  return { totalSuccess, totalFail, todayCount, topUsers };
}

async function callNanoBanana(prompt: string): Promise<NanoBananaResponse> {
  const url = new URL(NANO_BANANA_ENDPOINT);
  url.searchParams.set("key", NANO_BANANA_API_KEY);
  url.searchParams.set("prompt", prompt);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_IMAGE_GEN);
  try {
    const r = await fetch(url.toString(), {
      method: "GET",
      signal: ctrl.signal,
      headers: { "Accept": "application/json" },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { error: `HTTP ${r.status}: ${body.slice(0, 200)}` };
    }
    const data = await r.json() as NanoBananaResponse;
    if (!data.url) return { error: "missing_url" };
    return data;
  } catch (e) {
    const msg = String(e);
    if (msg.includes("aborted") || msg.includes("timeout")) {
      return { error: "timeout" };
    }
    return { error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleImageCommand(
  bot: TelegramBot,
  chatId: number,
  userId: string,
  promptRaw: string,
  userMessageId?: number,
): Promise<void> {
  // ── Maintenance gate (admins يتجاوزون) ──
  if (!isAdmin(userId)) {
    const maintenance = await redis.get(MAINTENANCE_KEY).catch(() => null);
    if (maintenance === "1") {
      await bot.sendMessage(chatId,
        `🔧 *البوت في وضع الصيانة حالياً*\n\nسنعود قريباً! ⏳`,
        { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
  }

  // ── API key check ──
  if (!NANO_BANANA_API_KEY) {
    L.warn("imageGen", "NANO_BANANA_API_KEY not configured");
    await bot.sendMessage(chatId,
      `⚠️ ميزة توليد الصور غير مفعّلة حالياً.`).catch(() => {});
    return;
  }

  // ── Prompt validation ──
  const prompt = promptRaw.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_LEN);
  if (prompt.length < MIN_PROMPT_LEN) {
    await bot.sendMessage(chatId,
      `🎨 *إنشاء صورة بالـ AI*\n` +
      `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n` +
      `الاستخدام: \`/img <وصف الصورة>\`\n\n` +
      `📌 *مثال:*\n` +
      `\`/img A red sports car drifting in a neon city\`\n\n` +
      `⏱ توليد الصورة يستغرق ~40 ثانية\n` +
      `🎫 لديك *${IMAGE_DAILY_LIMIT}* صور/يوم مجاناً`,
      { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  // ── Daily limit (admins بلا حد) ──
  if (!isAdmin(userId)) {
    const used = await getDailyImageCount(userId);
    if (used >= IMAGE_DAILY_LIMIT) {
      await bot.sendMessage(chatId,
        `⛔ *وصلت الحد اليومي للصور*\n\n` +
        `استخدمت: *${used}/${IMAGE_DAILY_LIMIT}* صور اليوم\n` +
        `🕐 يتجدد عند منتصف ليل القاهرة`,
        { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
  }

  // 👀 reaction فوري — يحس أن البوت "شاف" الطلب
  reactRandom(bot, chatId, userMessageId || 0, REACTION_RECEIVED).catch(() => {});
  redis.zadd("user:lastSeen", Date.now(), userId).catch(() => {});

  // ── Bump counter قبل الـ call (admins استثناء) ──
  let counted = false;
  if (!isAdmin(userId)) {
    await bumpDailyImageCount(userId);
    counted = true;
  }

  // ── ack message — نظهر progress placeholder ──
  let ackMsg: TelegramBot.Message | null = null;
  try {
    ackMsg = await bot.sendMessage(chatId,
      `🎨 جارٍ توليد الصورة...\n_ينتهي خلال ~40 ثانية_ ⏳`,
      { parse_mode: "Markdown" });
  } catch { /* non-fatal */ }

  // ── call nano-banana ──
  const t0 = Date.now();
  const result = await callNanoBanana(prompt);
  const elapsedMs = Date.now() - t0;

  if (result.error || !result.url) {
    // refund العداد عشان المستخدم ما يخسرش credit على فشلنا
    if (counted) await decrDailyImageCount(userId);

    L.warn("imageGen", "nano-banana failed", {
      userId,
      err: result.error?.slice(0, 100),
      elapsedMs,
    });
    redis.incr(NB_TOTAL_FAIL_KEY).catch(() => {});

    const friendly = result.error === "timeout"
      ? `⏱ انتهى الوقت قبل اكتمال الصورة. حاول مرة أخرى.`
      : `❌ خطأ في توليد الصورة. حاول لاحقاً.`;

    if (ackMsg) {
      await bot.editMessageText(friendly, {
        chat_id: chatId,
        message_id: ackMsg.message_id,
      }).catch(() => bot.sendMessage(chatId, friendly).catch(() => {}));
    } else {
      await bot.sendMessage(chatId, friendly).catch(() => {});
    }
    return;
  }

  // ── success — أرسل الصورة ──
  L.info("imageGen", "generated", {
    userId,
    elapsedMs,
    promptLen: prompt.length,
    apiTime: result.time_taken,
  });
  redis.incr(NB_TOTAL_SUCCESS_KEY).catch(() => {});
  // عداد التشخيص للوحة الأدمن: per-user lifetime + daily global.
  // admins يتعدّون في الإحصاءات عشان نشوف الاستخدام الفعلي كله.
  recordSuccessfulImage(userId).catch(() => {});

  // عدد الصور المتبقية (admins يرون ∞)
  let remainingLine = "";
  if (!isAdmin(userId)) {
    const used = await getDailyImageCount(userId);
    const remaining = Math.max(0, IMAGE_DAILY_LIMIT - used);
    remainingLine = `\n\n🎫 المتبقّي اليوم: *${remaining}/${IMAGE_DAILY_LIMIT}*`;
  } else {
    remainingLine = `\n\n👑 admin — بلا حد يومي`;
  }

  const seconds = (elapsedMs / 1000).toFixed(1);
  const caption =
    `🎨 *الصورة جاهزة* (${seconds}s)\n\n` +
    `📝 \`${escMd(prompt.slice(0, 200))}\`${remainingLine}`;

  try {
    await bot.sendPhoto(chatId, result.url, {
      caption,
      parse_mode: "Markdown",
    });
    // حذف رسالة الـ ack بعد نجاح الإرسال
    if (ackMsg) {
      bot.deleteMessage(chatId, ackMsg.message_id).catch(() => {});
    }
  } catch (e) {
    L.warn("imageGen", "sendPhoto failed, falling back to URL", {
      userId, err: String(e).slice(0, 100),
    });
    // fallback: ابعت الـ URL كنص لو تيليغرام رفض الصورة
    const fallback =
      `🎨 *الصورة جاهزة* — اضغط الرابط:\n${result.url}${remainingLine}`;
    if (ackMsg) {
      await bot.editMessageText(fallback, {
        chat_id: chatId,
        message_id: ackMsg.message_id,
        parse_mode: "Markdown",
      }).catch(() => bot.sendMessage(chatId, fallback,
        { parse_mode: "Markdown" }).catch(() => {}));
    } else {
      await bot.sendMessage(chatId, fallback,
        { parse_mode: "Markdown" }).catch(() => {});
    }
  }
}
