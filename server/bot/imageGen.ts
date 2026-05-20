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
//   { url: "https://.../nano.php?dl=1&file=img_xxxx.png", prompt, time_taken }
// تيليغرام يفشل في تحميل الـ URL مباشرة لأنها بتنتهي بـ query string
// مش بـ .png، فبننزّل الـ bytes بنفسنا ونرسلها كـ Buffer لـ sendPhoto.

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

// ننزّل الـ image bytes بنفسنا لأن تيليغرام بيرفض URL منتهي بـ query
// string. الـ Buffer بيتبعت مباشرة عبر multipart/form-data من node-telegram-bot-api.
// نحدّ بـ 20MB احتياطاً (الـ API بترجع عادة 2-4MB لصور 2K).
const MAX_IMG_BYTES = 20 * 1024 * 1024;
async function downloadImage(imgUrl: string): Promise<Buffer | { error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(imgUrl, { signal: ctrl.signal });
    if (!r.ok) return { error: `download HTTP ${r.status}` };
    const len = parseInt(r.headers.get("content-length") || "0", 10);
    if (len && len > MAX_IMG_BYTES) return { error: `image too large: ${len}` };
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAX_IMG_BYTES) return { error: `image too large: ${ab.byteLength}` };
    return Buffer.from(ab);
  } catch (e) {
    return { error: String(e).slice(0, 200) };
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
    redis.incr("tel:imageGen:fail").catch(() => {});

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
  redis.incr("tel:imageGen:success").catch(() => {});

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

  // ننزّل الـ bytes ونرسلها كـ Buffer — تيليغرام مش بيقدر يفتح الـ
  // URL مباشرة لأنها بتنتهي بـ ?dl=1&file=*.png مش بـ .png فعلياً.
  const downloaded = await downloadImage(result.url);
  if (Buffer.isBuffer(downloaded)) {
    try {
      await bot.sendPhoto(
        chatId,
        downloaded,
        { caption, parse_mode: "Markdown" },
        { filename: "image.png", contentType: "image/png" },
      );
      if (ackMsg) {
        bot.deleteMessage(chatId, ackMsg.message_id).catch(() => {});
      }
      return;
    } catch (e) {
      L.warn("imageGen", "sendPhoto with buffer failed", {
        userId, err: String(e).slice(0, 200),
      });
      // نسقط لـ URL fallback تحت
    }
  } else {
    L.warn("imageGen", "downloadImage failed, falling back to URL", {
      userId, err: downloaded.error,
    });
  }

  // fallback نهائي: ابعت الـ URL كنص بدون Markdown (URL فيه `_` بتكسر Markdown)
  const fallback =
    `🎨 الصورة جاهزة — اضغط الرابط:\n${result.url}` +
    (remainingLine.replace(/\*/g, ""));
  if (ackMsg) {
    await bot.editMessageText(fallback, {
      chat_id: chatId,
      message_id: ackMsg.message_id,
    }).catch(() => bot.sendMessage(chatId, fallback).catch(() => {}));
  } else {
    await bot.sendMessage(chatId, fallback).catch(() => {});
  }
}
