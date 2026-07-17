// ══════════════════════════════════════════════
// IMAGE GENERATION — nano-banana API
// ══════════════════════════════════════════════
//
// /img <prompt> — يولّد صورة عن طريق nano-banana endpoint
// خارجي ويرسلها كصورة في تيليغرام مع أزرار سريعة (Regenerate /
// Variation / HD download).
//
// الحدود (tier-based):
//   - admin                                   → بلا حد
//   - premium (PREMIUM_LIMIT  /day)           → IMAGE_PREMIUM_DAILY_LIMIT
//   - regular                                 → IMAGE_DAILY_LIMIT
//   عداد مخزّن في Redis تحت `img:daily:{userId}:{YYYY-MM-DD}`
//   مع EX = ثواني حتى منتصف ليل القاهرة.
//
// الـ endpoint يرجع JSON على الصيغة:
//   { url: "https://.../nano.php?dl=1&file=img_xxxx.png", prompt, time_taken }
// تيليغرام يفشل في تحميل الـ URL مباشرة لأنها بتنتهي بـ query string
// مش بـ .png، فبننزّل الـ bytes بنفسنا ونرسلها كـ Buffer.
//
// الـ inline buttons تحت كل صورة بتخزّن (prompt + url) في Redis
// تحت hash قصير عشان نمشّيهم عبر callback_data (المحدود بـ 64 byte).
// TTL = 24h.

import TelegramBot from "node-telegram-bot-api";
import { randomBytes } from "node:crypto";
import { L } from "./logger.js";
import { redis } from "./redis.js";
import { isAdmin } from "./guards.js";
import { isPremium } from "./userSettings.js";
import { reactRandom } from "./reactions.js";
import { REACTION_RECEIVED } from "./uiVariants.js";
import { escMd, cairoDateString, msUntilCairoMidnight } from "./text.js";
import {
  MAINTENANCE_KEY,
  IMAGE_DAILY_LIMIT,
  IMAGE_PREMIUM_DAILY_LIMIT,
  NANO_BANANA_API_KEY,
  NANO_BANANA_ENDPOINT,
  TIMEOUT_IMAGE_GEN,
  CLOUDFLARE_AI_ACCOUNT_ID,
  CLOUDFLARE_AI_API_TOKEN,
  GEMINI_API_KEY,
  PREMIUM_STARS_PRICE,
} from "./config.js";
import { onSuccessfulImage } from "./retention.js";

const MAX_PROMPT_LEN = 1000;
const MIN_PROMPT_LEN = 3;

const NB_TOP_USERS_KEY = "img:topUsers";
const NB_DAILY_TOTAL_PREFIX = "img:daily:total:";
const NB_TOTAL_SUCCESS_KEY = "tel:imageGen:success";
const NB_TOTAL_FAIL_KEY    = "tel:imageGen:fail";

async function recordSuccessfulImage(userId: string): Promise<void> {
  try { await redis.zincrby(NB_TOP_USERS_KEY, 1, userId); } catch { /* */ }
  try {
    const key = `${NB_DAILY_TOTAL_PREFIX}${cairoDateString()}`;
    const count = await redis.incr(key);
    if (count === 1) {
      const ttlSec = Math.max(60, Math.ceil(msUntilCairoMidnight() / 1000));
      await redis.expire(key, ttlSec).catch(() => {});
    }
  } catch { /* */ }
}

export interface ImageGenStats {
  totalSuccess: number;
  totalFail:    number;
  todayCount:   number;
  topUsers:     { userId: string; count: number }[];
}

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
    redis.zrevrange(NB_TOP_USERS_KEY, 0, Math.max(0, topN - 1), "WITHSCORES").catch(() => [] as string[]),
  ]);
  const topUsers: { userId: string; count: number }[] = [];
  for (let i = 0; i < topRaw.length; i += 2) {
    const userId = topRaw[i];
    const count  = parseInt(topRaw[i + 1] ?? "0", 10) || 0;
    if (userId) topUsers.push({ userId, count });
  }
  return { totalSuccess, totalFail, todayCount, topUsers };
}


const MAX_IMG_BYTES  = 20 * 1024 * 1024;
const IMG_META_TTL   = 86_400; // 24h
const PROGRESS_TICK  = 10_000; // 10s

interface NanoBananaResponse {
  url?: string;
  prompt?: string;
  time_taken?: string;
  error?: string;
}

interface ImgMeta {
  prompt: string;
  url:    string;
}

type Tier = "admin" | "premium" | "regular";

function imageDailyKey(userId: string): string {
  return `img:daily:${userId}:${cairoDateString()}`;
}

function imgMetaKey(hash: string): string {
  return `img:meta:${hash}`;
}

function shortHash(): string {
  return randomBytes(6).toString("hex"); // 12-char hex
}

async function getUserTier(userId: string): Promise<Tier> {
  if (isAdmin(userId)) return "admin";
  try {
    return (await isPremium(userId)) ? "premium" : "regular";
  } catch {
    return "regular";
  }
}

function tierLimit(tier: Tier): number {
  if (tier === "admin")   return Infinity;
  if (tier === "premium") return IMAGE_PREMIUM_DAILY_LIMIT;
  return IMAGE_DAILY_LIMIT;
}

// عداد ذرّي مع TTL ثابت حتى منتصف ليل القاهرة.
// INCR ثم EXPIRE فقط عند أول increment. fail-open لو Redis معطّل.
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

// undo زيادة العداد لو الاستدعاء فشل بعد ما زدنا.
async function decrDailyImageCount(userId: string): Promise<void> {
  try {
    await redis.decr(imageDailyKey(userId));
  } catch { /* swallow */ }
}


// ── Multi-provider image generation ──────────
// 1) nano-banana (legacy) with retries for "try again"
// 2) Cloudflare Flux (primary fallback — free tier on Workers AI)
// 3) Gemini image (optional)

interface GenImageResult {
  buffer?: Buffer;
  url?: string;
  provider?: string;
  time_taken?: string;
  error?: string;
}

async function callNanoBananaRaw(prompt: string): Promise<NanoBananaResponse> {
  if (!NANO_BANANA_API_KEY || NANO_BANANA_API_KEY.length < 4) {
    return { error: "nano_key_invalid_or_short" };
  }
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
    if (!data.url) return { error: data.error || "missing_url" };
    return data;
  } catch (e) {
    const msg = String(e);
    if (msg.includes("aborted") || msg.includes("timeout")) return { error: "timeout" };
    return { error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

async function callCloudflareFlux(prompt: string): Promise<GenImageResult> {
  if (!CLOUDFLARE_AI_ACCOUNT_ID || !CLOUDFLARE_AI_API_TOKEN) {
    return { error: "cf_not_configured" };
  }
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_IMAGE_GEN);
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${CLOUDFLARE_AI_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, num_steps: 4 }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { error: `cf_http_${r.status}: ${body.slice(0, 160)}` };
    }
    const data = await r.json() as { result?: { image?: string }; success?: boolean; errors?: unknown };
    const b64 = data?.result?.image;
    if (!b64) return { error: "cf_no_image" };
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length < 1000) return { error: "cf_image_too_small" };
    return { buffer, provider: "cloudflare-flux" };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("aborted")) return { error: "timeout" };
    return { error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiImage(prompt: string): Promise<GenImageResult> {
  if (!GEMINI_API_KEY) return { error: "gemini_not_configured" };
  // Try imagen-style generateContent with image modality
  const models = [
    "gemini-2.0-flash-preview-image-generation",
    "gemini-2.0-flash-exp-image-generation",
  ];
  for (const model of models) {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_IMAGE_GEN);
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        L.debug("imageGen", "gemini model failed", { model, status: r.status, body: body.slice(0, 120) });
        continue;
      }
      const data = await r.json() as {
        candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        const b64 = p.inlineData?.data;
        if (b64) {
          const buffer = Buffer.from(b64, "base64");
          if (buffer.length > 1000) return { buffer, provider: `gemini:${model}` };
        }
      }
    } catch (e) {
      L.debug("imageGen", "gemini error", { model, err: String(e).slice(0, 80) });
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: "gemini_no_image" };
}

/** Unified generator with failover. Prefer buffer for Telegram reliability. */
async function generateImage(prompt: string): Promise<GenImageResult> {
  // 1) Nano with up to 3 attempts (API sometimes returns try again)
  // Nano Banana Pro (2K, no watermark) — key can be short (e.g. USAGIWK).
  // Host may return "try again" under load or when the bot server IP is throttled;
  // we retry then fall through to Flux without failing the user.
  if (NANO_BANANA_API_KEY && NANO_BANANA_API_KEY.length >= 4) {
    for (let i = 0; i < 4; i++) {
      const nano = await callNanoBananaRaw(prompt);
      if (nano.url) {
        const dl = await downloadImage(nano.url);
        if (Buffer.isBuffer(dl)) {
          L.info("imageGen", "nano-banana success", { attempt: i + 1, time: nano.time_taken });
          return { buffer: dl, url: nano.url, provider: "nano-banana-2k", time_taken: nano.time_taken };
        }
        // URL-only: download failed (query-string URL) — still return url for fallback send
        L.warn("imageGen", "nano url ok but download failed — will try buffer providers", {
          err: Buffer.isBuffer(dl) ? "" : String((dl as { error?: string }).error || ""),
        });
        // continue to Flux for reliable buffer; keep nano url as last resort below
      }
      const err = (nano.error || "").toLowerCase();
      if (err.includes("try again") || err.includes("rate") || err.includes("busy") || err.includes("limit")) {
        L.warn("imageGen", "nano busy — retry", { attempt: i + 1, err: nano.error });
        await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
        continue;
      }
      if (err.includes("invalid key")) {
        L.warn("imageGen", "nano invalid key — skip to Flux", { keyLen: NANO_BANANA_API_KEY.length });
        break;
      }
      L.warn("imageGen", "nano failed", { attempt: i + 1, err: nano.error });
      if (i < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  } else {
    L.warn("imageGen", "skipping nano-banana — key missing", {
      keyLen: NANO_BANANA_API_KEY.length,
    });
  }

  // 2) Cloudflare Flux
  const cf = await callCloudflareFlux(prompt);
  if (cf.buffer) {
    L.info("imageGen", "using cloudflare flux fallback");
    return cf;
  }
  L.warn("imageGen", "cloudflare flux failed", { err: cf.error });

  // 3) Gemini
  const gem = await callGeminiImage(prompt);
  if (gem.buffer) {
    L.info("imageGen", "using gemini image fallback");
    return gem;
  }
  L.warn("imageGen", "gemini image failed", { err: gem.error });

  return { error: cf.error || gem.error || "all_providers_failed" };
}


// legacy alias
async function callNanoBanana(prompt: string): Promise<NanoBananaResponse> {
  return callNanoBananaRaw(prompt);
}


// ننزّل الـ image bytes بنفسنا. multipart upload لـ Telegram بيتم من الـ Buffer.
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

// keyboard أزرار سريعة تحت كل صورة. كل button بـ callback_data قصير
// مرتبط بـ hash مخزّن في Redis (prompt + url).
function buildImageKeyboard(hash: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "🔄 توليد تاني", callback_data: `img:re:${hash}` },
      { text: "✨ نسخة مختلفة", callback_data: `img:va:${hash}` },
      { text: "📥 HD",         callback_data: `img:hd:${hash}` },
    ]],
  };
}

// تحدث الـ ack message بصرياً كل 10 ثوان عشان الـ user يحس إن البوت
// شغّال (الـ API بياخد ~40s، فضل ساكت يبقى مزعج).
function startProgressUpdater(
  bot: TelegramBot,
  chatId: number,
  ackMsg: TelegramBot.Message | null,
  tier: Tier,
  used: number,
): NodeJS.Timeout | null {
  if (!ackMsg) return null;
  const t0 = Date.now();
  const limit = tierLimit(tier);
  const counter = tier === "admin" ? "بلا حد" : `${used}/${limit}`;
  const stages = [
    "🎨 جارٍ تحليل الـ prompt...",
    "✍️ جارٍ تخطيط المشهد...",
    "🖌️ جارٍ التلوين...",
    "🪄 جارٍ إضافة التفاصيل...",
    "✨ اللمسات النهائية...",
  ];

  const tick = async (): Promise<void> => {
    const elapsed = Math.floor((Date.now() - t0) / 1000);
    const stage = stages[Math.min(stages.length - 1, Math.floor(elapsed / 10))];
    const text =
      `${stage}\n\n` +
      `⏱ ${elapsed}s مرّوا (المتوقع ~40s)\n` +
      `🎫 اليوم: ${counter}`;
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: ackMsg.message_id,
    }).catch(() => { /* edit-same / message-too-old: نتجاهلها */ });
  };

  return setInterval(tick, PROGRESS_TICK);
}

// core: يكمل المسار من بعد ما اتحقق الـ limit (validate-bump-call-send).
// مفصول عن handleImageCommand عشان callback "regenerate" يقدر يستخدمه.
async function runGeneration(
  bot:       TelegramBot,
  chatId:    number,
  userId:    string,
  prompt:    string,
  tier:      Tier,
  ackPrefix: string,
): Promise<void> {
  // bump counter (admins استثناء)
  let counted = false;
  let usedAfterBump = 0;
  if (tier !== "admin") {
    usedAfterBump = await bumpDailyImageCount(userId);
    counted = true;
  }

  const limit = tierLimit(tier);
  const counterLine = tier === "admin"
    ? "بلا حد"
    : `${usedAfterBump}/${limit}`;

  // ack مع counter من أول لحظة
  let ackMsg: TelegramBot.Message | null = null;
  try {
    ackMsg = await bot.sendMessage(chatId,
      `${ackPrefix}\n` +
      `_ينتهي خلال ~40 ثانية_ ⏳\n\n` +
      `🎫 اليوم: ${counterLine}`,
      { parse_mode: "Markdown" });
  } catch { /* non-fatal */ }

  // progress updater (يحدّث الـ ack كل 10s)
  const progressTimer = startProgressUpdater(bot, chatId, ackMsg, tier, usedAfterBump);

  // call nano-banana
  const t0 = Date.now();
  const result = await generateImage(prompt);
  const elapsedMs = Date.now() - t0;

  if (progressTimer) clearInterval(progressTimer);

  if (result.error || (!result.buffer && !result.url)) {
    if (counted) await decrDailyImageCount(userId);
    L.warn("imageGen", "nano-banana failed", {
      userId, err: result.error?.slice(0, 100), elapsedMs,
    });
    redis.incr("tel:imageGen:fail").catch(() => {});

    const friendly = result.error === "timeout"
      ? `⏱ انتهى الوقت قبل اكتمال الصورة. حاول مرة أخرى.`
      : `❌ خطأ في توليد الصورة. حاول لاحقاً.`;

    if (ackMsg) {
      await bot.editMessageText(friendly, {
        chat_id: chatId, message_id: ackMsg.message_id,
      }).catch(() => bot.sendMessage(chatId, friendly).catch(() => {}));
    } else {
      await bot.sendMessage(chatId, friendly).catch(() => {});
    }
    return;
  }

  // success
  L.info("imageGen", "generated", {
    userId, elapsedMs, promptLen: prompt.length, apiTime: result.time_taken, tier,
  });
  redis.incr(NB_TOTAL_SUCCESS_KEY).catch(() => {});
  recordSuccessfulImage(userId).catch(() => {});
  onSuccessfulImage(userId).catch(() => {});

  // خزّن (prompt + url) تحت hash قصير عشان الأزرار تشتغل
  const hash = shortHash();
  const metaUrl = result.url || "";
  const meta: ImgMeta = { prompt, url: metaUrl };
  redis.set(imgMetaKey(hash), JSON.stringify(meta), "EX", IMG_META_TTL).catch(() => {});

  // remaining line
  let remainingLine: string;
  if (tier === "admin") {
    remainingLine = `\n\n👑 admin — بلا حد يومي`;
  } else {
    const used = await getDailyImageCount(userId);
    const remaining = Math.max(0, limit - used);
    const tierTag = tier === "premium" ? "⭐ Premium" : "مجاني";
    remainingLine = `\n\n🎫 المتبقّي اليوم: *${remaining}/${limit}* (${tierTag})`;
  }

  const seconds = (elapsedMs / 1000).toFixed(1);
  const providerTag = result.provider ? ` · ${result.provider}` : "";
  const caption =
    `🎨 *صورتك جاهزة — بلطف* (${seconds}s${providerTag})\n\n` +
    `📝 \`${escMd(prompt.slice(0, 200))}\`${remainingLine}`;

  const downloaded = result.buffer
    ? result.buffer
    : (metaUrl ? await downloadImage(metaUrl) : { error: "no_bytes" as const });
  if (Buffer.isBuffer(downloaded)) {
    try {
      await bot.sendPhoto(
        chatId,
        downloaded,
        {
          caption,
          parse_mode: "Markdown",
          reply_markup: buildImageKeyboard(hash),
        },
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
    }
  } else {
    L.warn("imageGen", "downloadImage failed, falling back to URL", {
      userId, err: downloaded.error,
    });
  }

  // fallback نهائي: URL بدون Markdown
  const fallback =
    `🎨 الصورة جاهزة — اضغط الرابط:\n${result.url}` +
    remainingLine.replace(/\*/g, "");
  if (ackMsg) {
    await bot.editMessageText(fallback, {
      chat_id: chatId, message_id: ackMsg.message_id,
    }).catch(() => bot.sendMessage(chatId, fallback).catch(() => {}));
  } else {
    await bot.sendMessage(chatId, fallback).catch(() => {});
  }
}

export async function handleImageCommand(
  bot:           TelegramBot,
  chatId:        number,
  userId:        string,
  promptRaw:     string,
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

  const hasAnyProvider =
    (NANO_BANANA_API_KEY && NANO_BANANA_API_KEY.length >= 4) ||
    (!!CLOUDFLARE_AI_API_TOKEN && !!CLOUDFLARE_AI_ACCOUNT_ID) ||
    !!GEMINI_API_KEY;
  if (!hasAnyProvider) {
    L.warn("imageGen", "no image provider configured");
    await bot.sendMessage(chatId,
      `⚠️ ميزة توليد الصور غير مفعّلة حالياً.`).catch(() => {});
    return;
  }

  const prompt = promptRaw.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_LEN);
  if (prompt.length < MIN_PROMPT_LEN) {
    const tier = await getUserTier(userId);
    const limit = tierLimit(tier);
    const limitText = tier === "admin"
      ? "بلا حد"
      : tier === "premium"
        ? `${limit} صور/يوم ⭐ Premium`
        : `${limit} صور/يوم مجاناً`;
    await bot.sendMessage(chatId,
      `🎨 *إنشاء صورة بالـ AI*\n` +
      `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n` +
      `الاستخدام: \`/img <وصف الصورة>\`\n\n` +
      `📌 *مثال:*\n` +
      `\`/img A red sports car drifting in a neon city\`\n\n` +
      `⏱ توليد الصورة يستغرق ~40 ثانية\n` +
      `🎫 لديك *${limitText}*`,
      { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  const tier = await getUserTier(userId);
  const limit = tierLimit(tier);

  // limit check (admins بلا حد)
  if (tier !== "admin") {
    const used = await getDailyImageCount(userId);
    if (used >= limit) {
      const upgradeBlock = tier === "regular"
        ? `\n\n⭐ *Premium = ${IMAGE_PREMIUM_DAILY_LIMIT} صور/يوم*\n` +
          `🌟 بـ ${PREMIUM_STARS_PRICE} Stars/شهر فقط`
        : ``;
      const keyboard: TelegramBot.SendMessageOptions = tier === "regular"
        ? {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: `⭐ ترقّ لـ Premium (${PREMIUM_STARS_PRICE} Stars)`, callback_data: "premium_buy" },
              ]],
            },
          }
        : { parse_mode: "Markdown" };

      await bot.sendMessage(chatId,
        `⛔ *وصلت الحد اليومي للصور*\n\n` +
        `استخدمت: *${used}/${limit}* صور اليوم\n` +
        `🕐 يتجدد عند منتصف ليل القاهرة${upgradeBlock}`,
        keyboard).catch(() => {});
      return;
    }
  }

  // 👀 reaction فوري — يحس أن البوت "شاف" الطلب
  reactRandom(bot, chatId, userMessageId || 0, REACTION_RECEIVED).catch(() => {});
  redis.zadd("user:lastSeen", Date.now(), userId).catch(() => {});

  await runGeneration(
    bot, chatId, userId, prompt, tier,
    `🎨 *جارٍ توليد الصورة...*`,
  );
}

// ══════════════════════════════════════════════
// CALLBACK HANDLER — أزرار تحت الصورة
// ══════════════════════════════════════════════
//
// data formats:
//   img:re:<hash>  → regenerate نفس الـ prompt
//   img:va:<hash>  → variation (prompt + modifier)
//   img:hd:<hash>  → ابعت الصورة كـ document (uncompressed)
//
export async function handleImageCallback(
  bot:      TelegramBot,
  chatId:   number,
  userId:   string,
  data:     string,
  queryId:  string,
): Promise<void> {
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "img") {
    await bot.answerCallbackQuery(queryId).catch(() => {});
    return;
  }
  const action = parts[1];
  const hash   = parts[2];

  // load meta
  let meta: ImgMeta | null = null;
  try {
    const raw = await redis.get(imgMetaKey(hash));
    if (raw) meta = JSON.parse(raw) as ImgMeta;
  } catch { /* swallow */ }

  if (!meta) {
    await bot.answerCallbackQuery(queryId, {
      text: "⏰ انتهت صلاحية الصورة (24 ساعة)",
      show_alert: false,
    }).catch(() => {});
    return;
  }

  // ── HD download — ابعت الصورة كـ document (uncompressed) ──
  if (action === "hd") {
    await bot.answerCallbackQuery(queryId, { text: "📥 جاري تجهيز HD..." }).catch(() => {});
    const dl = await downloadImage(meta.url);
    if (!Buffer.isBuffer(dl)) {
      await bot.sendMessage(chatId, `❌ تعذّر تحميل الصورة بالـ HD.`).catch(() => {});
      return;
    }
    try {
      await bot.sendDocument(
        chatId, dl,
        { caption: `📥 *النسخة الأصلية HD*`, parse_mode: "Markdown" },
        { filename: "image-hd.png", contentType: "image/png" },
      );
    } catch (e) {
      L.warn("imageGen", "sendDocument failed", { userId, err: String(e).slice(0, 200) });
      await bot.sendMessage(chatId, `❌ فشل إرسال الصورة كـ HD.`).catch(() => {});
    }
    return;
  }

  // ── regenerate / variation — يحتاج limit check + counter bump ──
  await bot.answerCallbackQuery(queryId, { text: "🎨 جاري التوليد..." }).catch(() => {});

  // maintenance / api key checks (نفس handleImageCommand)
  if (!isAdmin(userId)) {
    const maintenance = await redis.get(MAINTENANCE_KEY).catch(() => null);
    if (maintenance === "1") {
      await bot.sendMessage(chatId,
        `🔧 البوت في وضع الصيانة. سنعود قريباً.`).catch(() => {});
      return;
    }
  }
  if (!NANO_BANANA_API_KEY) {
    await bot.sendMessage(chatId,
      `⚠️ ميزة توليد الصور غير مفعّلة حالياً.`).catch(() => {});
    return;
  }

  const tier  = await getUserTier(userId);
  const limit = tierLimit(tier);
  if (tier !== "admin") {
    const used = await getDailyImageCount(userId);
    if (used >= limit) {
      await bot.sendMessage(chatId,
        `⛔ وصلت الحد اليومي للصور (${used}/${limit}).`).catch(() => {});
      return;
    }
  }

  // variation: نضيف modifier بسيط للـ prompt عشان نطلب composition مختلفة.
  // regenerate: نفس الـ prompt بالضبط (nano-banana عنده randomness في الـ output).
  const prompt = action === "va"
    ? `${meta.prompt}, different composition, alternative angle, varied colors`
    : meta.prompt;

  const ackPrefix = action === "va"
    ? `✨ *جاري توليد نسخة مختلفة...*`
    : `🔄 *جاري توليد صورة جديدة...*`;

  await runGeneration(bot, chatId, userId, prompt, tier, ackPrefix);
}
