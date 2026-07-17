// ══════════════════════════════════════════════
// VIDEO GENERATION — veo3 (veoaifree.com)
// ══════════════════════════════════════════════
//
// /video <prompt>        — يولّد فيديو portrait افتراضياً
// /video 16:9 <prompt>   — fixed landscape
// /video 9:16 <prompt>   — portrait (افتراضي)
// /video 1:1  <prompt>   — square
//
// flow على ثلاث خطوات (نفس ترتيب الـ python POC اللي ابعت)، مع
// تحسينات:
//   1) GET /veo-video-generator/ → نستخرج nonce من الـ HTML.
//      نحفظ كمان أي Set-Cookie cookies للـ requests التالية —
//      WordPress ajax nonces بتتربط بالـ session cookie عادةً.
//   2) POST /wp-admin/admin-ajax.php (action=full-video-generate)
//      → response فيها sceneId (نتعامل مع JSON أو fallback regex
//      بدل ما الـ POC بياخد أول رقم).
//   3) Polling loop: POST نفس endpoint (action=final-video-results)
//      كل 10s بعد أول 30s إلى أن نلاقي video URL أو نتجاوز
//      TIMEOUT_VIDEO_GEN. أحسن من sleep(60) ثم single poll لأن
//      veoaifree في الإنتاج بياخد بين 60-180s — single poll بيفشل
//      على tail latency.
//
// Stats: نفس نموذج imageGen — sorted set أعلى مستخدمين + lifetime
// success/fail counters + daily total. الـ admin panel يستهلكها عبر
// `getVideoGenStats`.
//
// Daily limit: VIDEO_DAILY_LIMIT (افتراضي 2/يوم). admins بلا حد.

import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { redis } from "./redis.js";
import { isAdmin } from "./guards.js";
import { reactRandom } from "./reactions.js";
import { REACTION_RECEIVED } from "./uiVariants.js";
import { escMd, cairoDateString, msUntilCairoMidnight } from "./text.js";
import {
  MAINTENANCE_KEY,
  VIDEO_DAILY_LIMIT,
  VEO3_ENABLED,
  VEO3_BASE_URL,
  VEO3_GENERATOR_PATH,
  VEO3_AJAX_PATH,
  TIMEOUT_VIDEO_GEN,
  TIMEOUT_VIDEO_HTTP_STEP,
} from "./config.js";

const MAX_PROMPT_LEN = 1000;
const MIN_PROMPT_LEN = 3;

// Polling cadence — مطابق للقيم في logic.js الخاصة بـ veoaifree:
//   - أول poll بعد 85s من بدء التوليد (JS بيعمل setTimeout 85000).
//   - polling كل 20s طالما الـ response فاضي ("still processing").
// نزود قليلاً عن قيم الـ JS عشان نمسك tail latency.
const POLL_INITIAL_DELAY_MS = 85_000;
const POLL_INTERVAL_MS      = 20_000;

// ── Aspect ratios ────────────────────────────
// keys مختصرة للمستخدم → القيم اللي بياخدها endpoint veoaifree.
const ASPECT_RATIOS: Record<string, string> = {
  "9:16":      "VIDEO_ASPECT_RATIO_PORTRAIT",
  "portrait":  "VIDEO_ASPECT_RATIO_PORTRAIT",
  "16:9":      "VIDEO_ASPECT_RATIO_LANDSCAPE",
  "landscape": "VIDEO_ASPECT_RATIO_LANDSCAPE",
  "1:1":       "VIDEO_ASPECT_RATIO_SQUARE",
  "square":    "VIDEO_ASPECT_RATIO_SQUARE",
};
const DEFAULT_ASPECT_KEY  = "9:16";
const DEFAULT_ASPECT_FULL = ASPECT_RATIOS[DEFAULT_ASPECT_KEY];

// ── Stats keys (admin panel) ─────────────────
const VID_TOP_USERS_KEY        = "vid:topUsers";
const VID_DAILY_TOTAL_PREFIX   = "vid:daily:total:";
const VID_TOTAL_SUCCESS_KEY    = "tel:videoGen:success";
const VID_TOTAL_FAIL_KEY       = "tel:videoGen:fail";

// ── UA rotation ──────────────────────────────
// بعض الـ WordPress installs بترفض fetch UA الافتراضي. نعمل rotation
// خفيف بحيث الـ source ما يشوفش string ثابت من سيرفر واحد لو سحبنا
// عدد كبير من الفيديوهات.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];
function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ── Daily limit helpers ──────────────────────
function videoDailyKey(userId: string): string {
  return `vid:daily:${userId}:${cairoDateString()}`;
}

async function bumpDailyVideoCount(userId: string): Promise<number> {
  const key = videoDailyKey(userId);
  try {
    const ttlSec = Math.max(60, Math.ceil(msUntilCairoMidnight() / 1000));
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, ttlSec).catch(() => {});
    }
    return count;
  } catch (e) {
    L.warn("videoGen", "bumpDailyVideoCount failed (fail-open)", { err: String(e).slice(0, 100) });
    return 0;
  }
}

async function getDailyVideoCount(userId: string): Promise<number> {
  try {
    const v = await redis.get(videoDailyKey(userId));
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

async function decrDailyVideoCount(userId: string): Promise<void> {
  try { await redis.decr(videoDailyKey(userId)); } catch { /* swallow */ }
}

// ── Stats helpers (for admin panel) ──────────
async function recordSuccessfulVideo(userId: string): Promise<void> {
  try {
    await redis.zincrby(VID_TOP_USERS_KEY, 1, userId);
  } catch { /* swallow */ }
  try {
    const key = `${VID_DAILY_TOTAL_PREFIX}${cairoDateString()}`;
    const count = await redis.incr(key);
    if (count === 1) {
      const ttlSec = Math.max(60, Math.ceil(msUntilCairoMidnight() / 1000));
      await redis.expire(key, ttlSec).catch(() => {});
    }
  } catch { /* swallow */ }
}

export interface VideoGenStats {
  totalSuccess: number;
  totalFail:    number;
  todayCount:   number;
  topUsers:     { userId: string; count: number }[];
}

// نفس signature getImageGenStats عشان admin panel يتعامل مع
// الاثنين بنفس النمط. يرجع zeros لو Redis تعطّل.
export async function getVideoGenStats(topN = 10): Promise<VideoGenStats> {
  const safeInt = async (key: string): Promise<number> => {
    try {
      const v = await redis.get(key);
      return v ? parseInt(v, 10) || 0 : 0;
    } catch { return 0; }
  };

  const [totalSuccess, totalFail, todayCount, topRaw] = await Promise.all([
    safeInt(VID_TOTAL_SUCCESS_KEY),
    safeInt(VID_TOTAL_FAIL_KEY),
    safeInt(`${VID_DAILY_TOTAL_PREFIX}${cairoDateString()}`),
    redis.zrevrange(VID_TOP_USERS_KEY, 0, Math.max(0, topN - 1), "WITHSCORES")
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

// ── HTTP helpers ─────────────────────────────
// نمرّر AbortController مشترك عشان نقدر نقطع كل الـ pipeline لو خبط
// الـ overall TIMEOUT_VIDEO_GEN.
function timedFetch(
  url: string,
  init: RequestInit,
  stepTimeoutMs = TIMEOUT_VIDEO_HTTP_STEP,
  overallSignal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (overallSignal) {
    if (overallSignal.aborted) ctrl.abort();
    else overallSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), stepTimeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal })
    .finally(() => {
      clearTimeout(timer);
      overallSignal?.removeEventListener("abort", onAbort);
    });
}

// نلتقط Set-Cookie من response عشان نمرّرها للـ POST اللي بعده.
// WordPress nonces بتتربط بالـ wp-settings/wordpress_test_cookie في
// بعض الإصدارات. لو ما فيش cookies، نمرّر سترينج فاضي.
function extractCookies(res: Response): string {
  // Node fetch يضع كل الـ Set-Cookie في getSetCookie() (Node 20+).
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  const all = anyHeaders.getSetCookie?.() ?? [];
  if (all.length === 0) return "";
  return all
    .map((c) => c.split(";", 1)[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

interface NonceResult {
  nonce:  string;
  cookie: string;
}

async function fetchNonce(
  ua: string, overallSignal: AbortSignal,
): Promise<NonceResult | null> {
  const url = `${VEO3_BASE_URL}${VEO3_GENERATOR_PATH}`;
  // POST في الـ POC، لكن GET بيرجع نفس الصفحة. نستخدم GET لأنه
  // الـ idiomatic + بيدّينا الـ cookies من غير side-effect.
  const res = await timedFetch(url, {
    method: "GET",
    headers: { "user-agent": ua, "accept": "text/html,*/*" },
  }, TIMEOUT_VIDEO_HTTP_STEP, overallSignal);
  if (!res.ok) {
    L.warn("videoGen", "fetchNonce non-200", { status: res.status });
    return null;
  }
  const body = await res.text();
  const m = body.match(/"nonce":"([a-f0-9]{6,32})"/i);
  if (!m) {
    L.warn("videoGen", "fetchNonce no nonce in body", { bodyLen: body.length });
    return null;
  }
  return { nonce: m[1], cookie: extractCookies(res) };
}

// extractSceneId — يقرأ الرد على full-video-generate.
// الـ endpoint بيرجع الـ sceneId كنص خام (مثل "2068233") مش JSON.
// نبحث عن أول tail رقمي طويل في الـ trimmed text. لو الرد عبارة عن
// رسالة خطأ نصية، نرجع null والـ caller يبلّغ عنها.
function extractSceneId(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // الرد المعتاد هو مجرد أرقام. لو فيه نص إضافي، ناخد أول tail رقمي
  // طويل (≥ 4 أرقام عشان ما نخدش زي "0" أو error code قصير).
  if (/^\d{4,}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/\b(\d{4,})\b/);
  return m ? m[1] : null;
}

// initialResponseSignalsTerminalError — في logic.js:
//   if (response.includes('In Progress'))   → user يستنى (popup)
//   if (response.includes('Error|failed|retry')) → fail
// "In Progress" مش رقم → ما هيعديش extractSceneId → بنرجع error مفيد
// عن طريق فحصها هنا.
function initialResponseSignalsTerminalError(text: string): string | null {
  const t = text.toLowerCase();
  if (/in.?progress/.test(t))     return "in_progress_other_user";
  if (/rate.?limit/.test(t))      return "rate_limit";
  if (/\b(error|failed|retry)\b/.test(t)) return text.slice(0, 120);
  return null;
}

// normalizeVideoUrl — الـ JS بيعمل id.replace('videos/', 'video/').
// والـ src النهائي بياخد الـ id مباشرةً في <video src="..."> فقد يكون:
//   - URL مطلق (https://...)
//   - مسار نسبي يبدأ بـ "/" أو من غير "/"
// نطبّق نفس normalize ثم نرجع URL مطلق دائماً (Telegram محتاج كده).
// نرجع null لو الـ string ما يشبهش URL/path (مثل HTML أو error message).
function normalizeVideoUrl(raw: string, baseUrl: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  // نشيل أي علامات اقتباس / HTML tags لو الـ server رجع html.
  s = s.replace(/^[\s"'<>]+|[\s"'<>]+$/g, "");
  if (!s) return null;
  // sanity: video URL/path ما فيهاش spaces داخلية ولا بتكون طويلة جداً.
  // الـ URLs النموذجية أقل من 500 حرف؛ أي رد أطول من كده غالباً HTML
  // error page أو رسالة وصفية.
  if (s.length > 500 || /\s/.test(s)) return null;
  s = s.replace(/^videos\//, "video/");
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/"))  return `${baseUrl}${s}`;
  return `${baseUrl}/${s}`;
}

// pollResponseSignalsError — رسائل تنتهي بفشل في الـ poll.
// الـ JS بيعمل: if response > 15 chars + يحتوي Rate Limit/Error/retry → fail.
// كمان: الرد قد يكون HTML من Cloudflare لو الـ origin timed out (524) —
// ده مش error نهائي بل transient، فنرجع null عشان الـ poll يكمّل.
function pollResponseSignalsError(text: string): string | null {
  // HTML response = Cloudflare/WP error page → transient، continue polling.
  if (/^<!?(?:doctype|html|head|body)\b|<\/html>/i.test(text.trim())) return null;
  // قصير جداً ولا URL → غالباً path. ما نوقفش.
  if (text.length < 5 || /^https?:\/\//i.test(text)) return null;
  const t = text.toLowerCase();
  if (/rate.?limit/.test(t)) return "rate_limit";
  if (/\b(error|failed|retry)\b/.test(t)) return text.slice(0, 120);
  return null;
}

// ── Main pipeline ────────────────────────────
interface Veo3Result {
  url?:    string;
  error?:  string;
  aspect?: string;
}

async function callVeo3(
  prompt: string, aspectFull: string,
): Promise<Veo3Result> {
  const ua = pickUserAgent();
  const ajaxUrl = `${VEO3_BASE_URL}${VEO3_AJAX_PATH}`;
  const referer = `${VEO3_BASE_URL}${VEO3_GENERATOR_PATH}`;
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), TIMEOUT_VIDEO_GEN);

  try {
    // ── Step 1: nonce ──
    const nonceRes = await fetchNonce(ua, overall.signal);
    if (!nonceRes) return { error: "no_nonce" };

    // ── Step 2: start generation ──
    const startBody = new URLSearchParams({
      action:          "veo_video_generator",
      nonce:           nonceRes.nonce,
      prompt,
      totalVariations: "1",
      aspectRatio:     aspectFull,
      actionType:      "full-video-generate",
    });
    const startRes = await timedFetch(ajaxUrl, {
      method: "POST",
      headers: {
        "accept":            "*/*",
        "content-type":      "application/x-www-form-urlencoded; charset=UTF-8",
        "origin":            VEO3_BASE_URL,
        "referer":           referer,
        "user-agent":        ua,
        "x-requested-with":  "XMLHttpRequest",
        ...(nonceRes.cookie ? { "cookie": nonceRes.cookie } : {}),
      },
      body: startBody.toString(),
    }, TIMEOUT_VIDEO_HTTP_STEP, overall.signal);

    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => "");
      return { error: `start_http_${startRes.status}: ${txt.slice(0, 120)}` };
    }
    const startText = await startRes.text();
    const terminalErr = initialResponseSignalsTerminalError(startText);
    if (terminalErr) return { error: `start_terminal: ${terminalErr}` };
    const sceneId = extractSceneId(startText);
    if (!sceneId) return { error: `no_scene_id: ${startText.slice(0, 120)}` };

    // ── Step 3: poll for final result ──
    // نسيب الـ source ياخد وقته الأولي قبل أول poll عشان ما نضربش
    // الـ endpoint بسؤال "خلصت؟" متكرر بدون فايدة. لو الـ overall
    // timeout قطع المنتظِر — نخرج بـ error: timeout.
    await sleepAbortable(POLL_INITIAL_DELAY_MS, overall.signal);

    while (!overall.signal.aborted) {
      const pollBody = new URLSearchParams({
        action:     "veo_video_generator",
        nonce:      nonceRes.nonce,
        sceneData:  sceneId,
        actionType: "final-video-results",
      });
      const pollRes = await timedFetch(ajaxUrl, {
        method: "POST",
        headers: {
          "accept":            "*/*",
          "content-type":      "application/x-www-form-urlencoded; charset=UTF-8",
          "origin":            VEO3_BASE_URL,
          "referer":           referer,
          "user-agent":        ua,
          "x-requested-with":  "XMLHttpRequest",
          ...(nonceRes.cookie ? { "cookie": nonceRes.cookie } : {}),
        },
        body: pollBody.toString(),
      }, TIMEOUT_VIDEO_HTTP_STEP, overall.signal).catch((e) => {
        // poll واحدة فشلت ≠ end of world. نسجّل ونكمّل الـ loop.
        L.debug("videoGen", "poll fetch failed (will retry)",
          { err: String(e).slice(0, 80) });
        return null as unknown as Response;
      });

      if (pollRes && pollRes.ok) {
        const pollText = (await pollRes.text()).trim();
        // logic.js: response.trim() == "" → still processing → wait + retry.
        if (pollText.length > 0) {
          // رسائل فشل صريحة (Rate Limit / Error / failed / retry).
          const err = pollResponseSignalsError(pollText);
          if (err) return { error: `poll_terminal: ${err}` };
          // JSON responses: { video, url, video_url, result }
          let candidate = pollText;
          try {
            if (pollText.startsWith("{") || pollText.startsWith("[")) {
              const j = JSON.parse(pollText) as Record<string, unknown>;
              const pick =
                (j.video as string) ||
                (j.url as string) ||
                (j.video_url as string) ||
                (j.result as string) ||
                (typeof j.data === "string" ? j.data : "") ||
                "";
              if (pick) candidate = pick;
            }
          } catch { /* not JSON */ }
          const url = normalizeVideoUrl(candidate, VEO3_BASE_URL);
          if (url) return { url };
        }
      }
      await sleepAbortable(POLL_INTERVAL_MS, overall.signal);
    }
    return { error: "timeout" };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("aborted")) return { error: "timeout" };
    return { error: msg.slice(0, 200) };
  } finally {
    clearTimeout(overallTimer);
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Prompt + aspect parsing ──────────────────
// يقبل: "<prompt>" أو "9:16 <prompt>" أو "portrait <prompt>" ...
function parseAspectAndPrompt(input: string): { prompt: string; aspectFull: string; aspectKey: string } {
  const trimmed = input.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace > 0) {
    const head = trimmed.slice(0, firstSpace).toLowerCase();
    const rest = trimmed.slice(firstSpace + 1).trim();
    if (rest && Object.prototype.hasOwnProperty.call(ASPECT_RATIOS, head)) {
      return { prompt: rest, aspectFull: ASPECT_RATIOS[head], aspectKey: head };
    }
  }
  return { prompt: trimmed, aspectFull: DEFAULT_ASPECT_FULL, aspectKey: DEFAULT_ASPECT_KEY };
}

// ── Command handler ──────────────────────────
export async function handleVideoCommand(
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

  // ── Feature gate ──
  if (!VEO3_ENABLED) {
    L.info("videoGen", "veo3 disabled by config");
    await bot.sendMessage(chatId,
      `⚠️ ميزة توليد الفيديو غير مفعّلة حالياً.`).catch(() => {});
    return;
  }

  // ── Prompt validation ──
  const parsed = parseAspectAndPrompt(promptRaw.replace(/\s+/g, " "));
  const prompt = parsed.prompt.slice(0, MAX_PROMPT_LEN);
  if (prompt.length < MIN_PROMPT_LEN) {
    await bot.sendMessage(chatId,
      `🎬 *إنشاء فيديو بالـ AI (veo3)*\n` +
      `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n` +
      `الاستخدام: \`/video <وصف الفيديو>\`\n\n` +
      `📌 *أمثلة:*\n` +
      `\`/video A red sports car drifting in a neon city\`\n` +
      `\`/video 16:9 sunset over the pyramids, cinematic\`\n` +
      `\`/video 1:1 a cat playing piano, studio light\`\n\n` +
      `📐 *النِسَب:* \`9:16\` (افتراضي) · \`16:9\` · \`1:1\`\n` +
      `⏱ التوليد بياخد حوالي *1-3 دقائق*\n` +
      `🎫 لديك *${VIDEO_DAILY_LIMIT}* فيديو/يوم مجاناً`,
      { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  // ── Daily limit (admins بلا حد) ──
  if (!isAdmin(userId)) {
    const used = await getDailyVideoCount(userId);
    if (used >= VIDEO_DAILY_LIMIT) {
      await bot.sendMessage(chatId,
        `⛔ *وصلت الحد اليومي للفيديو*\n\n` +
        `استخدمت: *${used}/${VIDEO_DAILY_LIMIT}* فيديو اليوم\n` +
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
    await bumpDailyVideoCount(userId);
    counted = true;
  }

  // ── ack message — نظهر progress placeholder ──
  let ackMsg: TelegramBot.Message | null = null;
  try {
    ackMsg = await bot.sendMessage(chatId,
      `🎬 جارٍ توليد الفيديو...\n_قد يستغرق حتى 3 دقائق_ ⏳`,
      { parse_mode: "Markdown" });
  } catch { /* non-fatal */ }

  // ── call veo3 ──
  const t0 = Date.now();
  const result = await callVeo3(prompt, parsed.aspectFull);
  const elapsedMs = Date.now() - t0;

  if (result.error || !result.url) {
    // refund العداد عشان المستخدم ما يخسرش credit على فشلنا
    if (counted) await decrDailyVideoCount(userId);

    L.warn("videoGen", "veo3 failed", {
      userId,
      err: result.error?.slice(0, 100),
      elapsedMs,
    });
    redis.incr(VID_TOTAL_FAIL_KEY).catch(() => {});

    let friendly = `❌ تعذّر توليد الفيديو. حاول لاحقاً.`;
    const e = result.error || "";
    if (e === "timeout") friendly = `⏱ انتهى الوقت قبل اكتمال الفيديو (أكثر من 5 دقائق). حاول مرة أخرى بوصف أقصر.`;
    else if (e.includes("no_nonce")) friendly = `⚠️ مصدر الفيديو غير متاح حالياً. جرّب بعد قليل.`;
    else if (e.includes("rate_limit") || e.includes("In Progress") || e.includes("in_progress"))
      friendly = `⏳ الخدمة مشغولة الآن. انتظر دقيقة وأعد المحاولة.`;
    else if (e.includes("no_scene_id")) friendly = `⚠️ لم يبدأ التوليد — أعد المحاولة بوصف إنجليزي أوضح.`;
    L.warn("videoGen", "user-facing fail", { err: e.slice(0, 120) });

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

  // ── success — أرسل الفيديو ──
  L.info("videoGen", "generated", {
    userId,
    elapsedMs,
    promptLen: prompt.length,
    aspect:    parsed.aspectKey,
  });
  redis.incr(VID_TOTAL_SUCCESS_KEY).catch(() => {});
  recordSuccessfulVideo(userId).catch(() => {});

  // عدد المتبقّي اليوم (admins يرون ∞)
  let remainingLine = "";
  if (!isAdmin(userId)) {
    const used = await getDailyVideoCount(userId);
    const remaining = Math.max(0, VIDEO_DAILY_LIMIT - used);
    remainingLine = `\n\n🎫 المتبقّي اليوم: *${remaining}/${VIDEO_DAILY_LIMIT}*`;
  } else {
    remainingLine = `\n\n👑 admin — بلا حد يومي`;
  }

  const seconds = (elapsedMs / 1000).toFixed(0);
  const caption =
    `🎬 *الفيديو جاهز* (${seconds}s · ${parsed.aspectKey})\n\n` +
    `📝 \`${escMd(prompt.slice(0, 200))}\`${remainingLine}`;

  try {
    await bot.sendVideo(chatId, result.url, {
      caption,
      parse_mode: "Markdown",
    });
    if (ackMsg) {
      bot.deleteMessage(chatId, ackMsg.message_id).catch(() => {});
    }
  } catch (e) {
    L.warn("videoGen", "sendVideo failed, falling back to URL", {
      userId, err: String(e).slice(0, 100),
    });
    // fallback: ابعت الـ URL كنص لو تيليغرام رفض الفيديو
    const fallback =
      `🎬 *الفيديو جاهز* — اضغط الرابط:\n${result.url}${remainingLine}`;
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
