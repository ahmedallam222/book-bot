import TelegramBot from "node-telegram-bot-api";
import { storage } from "../storage.js";
import { L } from "./logger.js";
import { enqueue } from "./queue.js";
import { isBanned, isAdmin, setLastBook } from "./guards.js";
import { isRateLimited, isSearchRateLimited, RATE_LIMIT_MAX, SEARCH_RATE_MAX } from "./rateLimit.js";
import { normalizeForCache, escMd, urlFilenameRelevance, cleanSearchQuery, canonicalizeForCache, buildResetTime } from "./text.js";
import { searchWithFuzzyFallback } from "./fuzzy.js";
import { isFirecrawlDown } from "./engine.js";
import { warmRelatedCache } from "./suggestions.js";
import { getLlamaSuggestions } from "./aiProviders/llamaSuggestions.js";
import { buildDidYouMeanMessage, kbDidYouMean } from "./didYouMean.js";
import {
  correctTransliteration,
  TEL_TLIT_RETRY_RECOVERED,
} from "./aiProviders/llamaTransliteration.js";
import { findValidPdfUrls } from "./verify.js";
import { downloadAndSend } from "./download.js";
import { isBlacklisted } from "./blacklist.js";
import { hasUninformativeFilename } from "./pdfValidator.js";
import { parseTelegramUrl } from "./telegramFallback.js";
import { recordFailure, removeFailure, failureKey } from "./failureRetry.js";
import { recordDelivery } from "./deliveryMetrics.js";
import { lightNormalizeQuery } from "./queryNormalize.js";
import { editMsg, deleteMsg, buildProgress, tip, buildSuccessMsg, buildNoResults, buildLinksOnly, buildDailyLimit, buildRateLimitMsg, buildQueueAccepted, buildPendingMsg, buildTurnNotification, buildPaidBookMessage, buildTooLargeMsg } from "./ui.js";
import {
  REACTION_RECEIVED, REACTION_SUCCESS, REACTION_CACHE_HIT,
  REACTION_NO_RESULT, REACTION_ERROR,
} from "./uiVariants.js";
import { armProgressWatchdog, clearProgressWatchdog } from "./progressWatchdog.js";
import { kbAfterSuccess, kbAfterFail, kbMain, kbNoResults, kbQueued } from "./keyboards.js";
import { getUserNote, isPremium, computeDailyLimit } from "./userSettings.js";
import { redis } from "./redis.js";
import {
  MAINTENANCE_KEY, BOT_ANNOUNCE_KEY, PREMIUM_SET_KEY,
  DAILY_LIMIT, PREMIUM_LIMIT, BANNED_USERS, UNRELIABLE_DOMAINS,
  MISTRAL_NO_STREAK_LIMIT,
  MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST,
  MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN,
  LOW_SUCCESS_RATE_PENALTY_THRESHOLD,
  RESCUE_MIN_CANDIDATES,
  RESCUE_MAX_FALLBACKS,
  RESCUE_BEST_PDF_THRESHOLD,
  RESCUE_FALLBACK_THRESHOLD,
} from "./config.js";
import { trackSearch, trackDownload, getSourceStatsCached, trackFunnel, trackSourceAttempt, trackSourceMistralReject, sanitizeDomainKey } from "./analytics.js";
import { RequestTrace, claimFunnelSlot } from "./telemetry.js";
import { react, reactRandom } from "./reactions.js";
import type { QueueJob } from "./types.js";
import {
  updateStreakOnDownload, formatStreakLine,
  buildMilestoneMessage, buildBrokenStreakMessage,
  type StreakUpdate,
} from "./streak.js";
import { checkAndAwardBadges, buildNewBadgeMessage, tryAwardBadge } from "./badges.js";
import { onSuccessfulDownload, tryUseStreakShield } from "./retention.js";
import { recordInterest } from "./interests.js";
import { getRelatedBooks, pickReadingTip, buildDiscoverFooter } from "./discover.js";
import { activateReferralOnFirstDownload, sendReferralNotifications } from "./referral.js";

// buildResetTime مستوردة من text.ts

// ══════════════════════════════════════════════
// ENTRY POINT — Guards → Enqueue
// ══════════════════════════════════════════════


// Round-robin URLs by domain so one noisy host cannot monopolize the first
// N attempts (e.g. five t.me hits before a good hindawi PDF).

// Latency class for attempt ordering (lower = try first).
// Cheap direct sources before Playwright-heavy hosts so we spend the
// job budget on deliverable candidates first.
function latencyClassForUrl(url: string): number {
  const u = (url || "").toLowerCase();
  if (u.includes("t.me/") || u.startsWith("tg://")) return 1; // MTProto, usually fast
  if (u.includes("downloads.hindawi.org") || u.includes("hindawi.org")) return 0; // direct PDFs
  if (u.includes("archive.org")) return 3; // often slow / skipped
  if (u.includes("noor-book.com")) return 4; // Playwright
  if (u.includes("welib.st") || u.includes("welib.org") || u.includes("welib-public")) return 5; // Playwright+wait
  if (u.includes("foulabook") || u.includes("mktbtypdf") || u.includes("kotobati")) return 2;
  return 2; // default mid
}

function diversifyUrlsByDomain(urls: string[]): string[] {
  if (urls.length <= 2) return urls;
  const buckets = new Map<string, string[]>();
  const order: string[] = [];
  for (const u of urls) {
    let host = "";
    try { host = new URL(u.startsWith("tg://") ? "https://t.me.local" : u).hostname.toLowerCase(); } catch {
      host = (u.split("/")[2] || "unknown").toLowerCase();
    }
    // collapse telegram synthetic hosts
    if (u.includes("t.me/") || u.startsWith("tg://")) host = "t.me";
    if (!buckets.has(host)) {
      buckets.set(host, []);
      order.push(host);
    }
    buckets.get(host)!.push(u);
  }
  if (buckets.size <= 1) return urls;
  const out: string[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const h of order) {
      const arr = buckets.get(h)!;
      if (arr.length > 0) {
        out.push(arr.shift()!);
        progress = true;
      }
    }
  }
  return out;
}

export async function handleBookRequest(
  bot: TelegramBot,
  chatId: number,
  userId: string,
  bookName: string,
  token: string,
  userName?: string | null,
  userMessageId?: number,
  wantsSummary?: boolean,
): Promise<void> {
  // ── دمج كل الفحوصات الأولية في استعلامين متوازيين بدل 7+ متسلسلة ──
  // Premium check needs 3 keys (Set membership + exp TTL + manual flag) لكي
  // ندعم انتهاء الاشتراك الصحيح + lazy cleanup. كلهم في نفس الـ pipeline
  // عشان نحافظ على round-trip واحد. شاهد server/bot/userSettings.ts للتوثيق.
  let bannedResult:        [Error|null, unknown]|undefined;
  let maintenanceResult:   [Error|null, unknown]|undefined;
  let premiumSetResult:    [Error|null, unknown]|undefined;
  let premiumExpResult:    [Error|null, unknown]|undefined;
  let premiumManualResult: [Error|null, unknown]|undefined;
  let limitOverrideResult: [Error|null, unknown]|undefined;
  let pipelineOk = false;

  try {
    const pipelineRes = await redis.pipeline()
      .sismember("bans", userId)
      .get(MAINTENANCE_KEY)
      .sismember(PREMIUM_SET_KEY, userId)
      .exists(`premium:exp:${userId}`)
      .exists(`premium:manual:${userId}`)
      .get(`ulimit:${userId}`)
      .exec();
    if (pipelineRes) {
  // Light dialect/typo normalize (conservative)
  {
    const normed = lightNormalizeQuery(bookName);
    if (normed && normed !== bookName) {
      L.info("bot", "query light-normalized", {
        from: bookName.slice(0, 40), to: normed.slice(0, 40),
      });
      redis.incr("tel:query:light_normalized").catch(() => {});
      bookName = normed;
    }
  }

      [bannedResult, maintenanceResult, premiumSetResult, premiumExpResult,
       premiumManualResult, limitOverrideResult] =
        pipelineRes as [Error|null, unknown][];
      pipelineOk = true;
    }
  } catch {
    // Redis خطأ كامل — نمنع المعالجة احتياطاً
    L.warn("bot", `Redis pipeline failed for user ${userId} — aborting request`);
    await bot.sendMessage(chatId, `⚠️ خطأ مؤقت في الخادم. حاول مرة أخرى.`).catch(() => {});
    return;
  }

  // ── Ban ───────────────────────────────────────
  // BANNED_USERS: Set مُهيَّأة مرة واحدة عند بدء التطبيق من config.ts
  // بدل: (process.env.BANNED_IDS||"").split(",")... في كل طلب — تكلفة parsing زائدة
  const isBannedUser = (bannedResult?.[1] as number) === 1 ||
    BANNED_USERS.has(userId);
  if (isBannedUser) {
    await bot.sendMessage(chatId, `🚫 تم حظرك من استخدام هذا البوت.`).catch(() => {});
    return;
  }

  // ── Maintenance ───────────────────────────────
  if ((maintenanceResult?.[1] as string) === "1" && !isAdmin(userId)) {
    await bot.sendMessage(chatId, `🔧 *البوت في وضع الصيانة حالياً*\n\nسنعود قريباً! ⏳`, { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  // ── Rate limits (sliding window - Lua atomic) ─
  if (!isAdmin(userId)) {
    const [rateLimited, searchRateLimited] = await Promise.all([
      isRateLimited(userId),
      isSearchRateLimited(userId),
    ]);
    if (rateLimited) {
      // BUG-5 FIX: كانت رسالة rate limit تُرسَل بدون أزرار — المستخدم يقرأ الرسالة ولا يعرف ماذا يفعل
      // الإضافة: كبورد القائمة الرئيسية لتسهيل التنقل بعد انتهاء حالة الـ rate limit
      await bot.sendMessage(chatId, buildRateLimitMsg(RATE_LIMIT_MAX), { parse_mode: "Markdown", reply_markup: kbMain() }).catch(() => {});
      return;
    }
    if (searchRateLimited) {
      await bot.sendMessage(chatId, buildRateLimitMsg(SEARCH_RATE_MAX), { parse_mode: "Markdown", reply_markup: kbMain() }).catch(() => {});
      return;
    }
  }

  // ── Daily limit ───────────────────────────────
  // Premium = في الـ Set AND (اشتراك مدفوع ساري OR منحة Admin يدوية)
  // لو في الـ Set بدون exp ولا manual → اشتراك انتهى → lazy cleanup
  const inPremiumSet = (premiumSetResult?.[1]    as number) === 1;
  const hasExp       = (premiumExpResult?.[1]    as number) === 1;
  const hasManual    = (premiumManualResult?.[1] as number) === 1;
  const isPrem       = inPremiumSet && (hasExp || hasManual);
  if (inPremiumSet && !hasExp && !hasManual) {
    // Stale — اشتراك مدفوع انتهى TTL بتاعه. fire-and-forget cleanup
    redis.srem(PREMIUM_SET_KEY, userId).catch(() => {});
    L.info("premium", "Lazy cleanup: removed expired user from set", { userId });
  }
  // الـ ULIMIT override جاي من الـ pipeline الأصلي → نحسب الحد بدون أي Redis call إضافي.
  // قبل الإصلاح: getUserDailyLimit(userId) كانت تعيد استدعاء isPremium + redis.get(ulimit) من تاني.
  const limitVal     = limitOverrideResult?.[1] as string | null;
  // IMP-1 FIX: parseInt قد يُعيد NaN إذا كانت قيمة Redis تالفة
  // NaN > 0 = false → يُعامَل كـ unlimited → المستخدم لا يُحجب أبداً
  // الحل: إضافة isNaN check مع fallback للقيمة الصحيحة
  const parsedLimit = limitVal !== null && limitVal !== undefined ? parseInt(limitVal as string, 10) : NaN;
  const dailyLimit  = !isNaN(parsedLimit)
    ? parsedLimit
    : isPrem ? PREMIUM_LIMIT : DAILY_LIMIT;

  // getDailyDownloadCount من storage (PostgreSQL) — لا يمكن pipeline مع Redis
  let dlCount = 0;
  try { dlCount = await storage.getDailyDownloadCount(userId); } catch {}

  if (dailyLimit > 0 && dlCount >= dailyLimit && !isAdmin(userId)) {
    await bot.sendMessage(
      chatId,
      buildDailyLimit(dlCount, dailyLimit, buildResetTime(), isPrem),
      { parse_mode: "Markdown", reply_markup: kbMain() }
    );
    return;
  }

  // ── Enqueue ───────────────────────────────────
  const priority = isAdmin(userId) ? "high" : isPrem ? "high" : "normal";
  const result   = await enqueue(userId, chatId, bookName, token, priority, userName, userMessageId, wantsSummary);

  if (!result.ok) {
    if (result.reason === "user_limit") {
      await bot.sendMessage(chatId, buildPendingMsg(), { parse_mode: "Markdown" });
    }
    return;
  }

  // ── Track search — فقط بعد قبول الطلب فعلياً ──
  // BUG FIX: كان قبل enqueue → المستخدمون المحجوبون بـ user_limit يُحسَبون في الإحصاءات
  trackSearch(userId).catch(() => {});

  const pos    = result.position ?? 1;
  const isHighPriority = priority === "high"; // يشمل admins + premium

  await bot.sendMessage(
    chatId,
    buildQueueAccepted(bookName, pos, isHighPriority),
    // BUG-4 FIX: كان يُرسَل بدون reply_markup → المستخدم لا يرى أزرار الإلغاء/الحالة inline
    // kbQueued معرَّفة في keyboards.ts منذ البداية لكن لم تكن تُستخدَم أبداً هنا
    // الآن: المستخدم يرى زر "إلغاء طلبي" و"حالة الطابور" مباشرة تحت رسالة القبول
    { parse_mode: "Markdown", reply_markup: kbQueued(pos) }
  ).catch(() => {});

  L.info("queue", `Request accepted`, { userId, book: bookName.slice(0, 50), priority, pos: result.position });
}

// ══════════════════════════════════════════════
// PROCESSOR — يُستدعى من Worker
// ══════════════════════════════════════════════

/**
 * trackFunnelOnce: يعدّ الـ funnel مرة واحدة فقط لكل job
 * حتى لو retry — claimFunnelSlot يستخدم Redis NX
 */
async function trackFunnelOnce(
  jobId: string,
  opts: Parameters<typeof trackFunnel>[0]
): Promise<void> {
  const isFirst = await claimFunnelSlot(jobId);
  if (isFirst) trackFunnel(opts).catch(() => {});
}

export async function processBookRequest(bot: TelegramBot, job: QueueJob): Promise<void> {
  const { userId, chatId, bookName, token, userName } = job;
  const t0    = Date.now();
  const trace = new RequestTrace(job.id, userId, bookName, job.retries);
  trace.phase("request_started", { book: bookName.slice(0, 50), priority: job.priority });

  // BUG-FIX: قبل ده كان فيه 3 isPremium calls على نفس الـ userId في requesti واحد:
  //   (1) handleBookRequest pipeline (parent caller)  (2) Promise.all هنا  (3) getUserDailyLimit
  // الآن نقرا isPrem + ulimit من Redis مرة واحدة هنا، ونحسب dailyLimit بشكل synchronous.
  const [isPrem, ulimitOverride, dlCountRaw] = await Promise.all([
    isPremium(userId).catch(() => false),
    redis.get(`ulimit:${userId}`).catch(() => null),
    storage.getDailyDownloadCount(userId).catch(() => 0),
  ]);
  const dailyLimit = computeDailyLimit(isPrem, ulimitOverride);
  const dlCount    = dlCountRaw;

  if (dailyLimit > 0 && dlCount >= dailyLimit && !isAdmin(userId)) {
    await bot.sendMessage(
      chatId,
      buildDailyLimit(dlCount, dailyLimit, buildResetTime(), isPrem),
      { parse_mode: "Markdown", reply_markup: kbMain() }
    ).catch(() => {});
    return;
  }

  // Feature 1: إشعار "وصل دورك" — فقط إذا انتظر المستخدم في الطابور > 5 ثوانٍ
  const waitMs = job.startedAt ? job.startedAt - job.createdAt : 0;
  if (waitMs > 5000) {
    const waitSec = Math.round(waitMs / 1000);
    await bot.sendMessage(
      chatId,
      buildTurnNotification(bookName, waitSec),
      { parse_mode: "Markdown" }
    ).catch(() => {});
  }

  // FIX: msgId=0 آمن — editMsg وdeleteMsg كلاهما يتحققان من msgId قبل العمل
  let msgId = 0;
  // Typing indicator while we send the initial progress message —
  // makes the bot feel responsive even before the first edit fires.
  bot.sendChatAction(chatId, "typing").catch(() => {});
  try {
    const qm = await bot.sendMessage(chatId, buildProgress(0, bookName), { parse_mode: "Markdown" });
    msgId = qm.message_id;
    armProgressWatchdog(token, chatId, msgId, 0, bookName);
  } catch {}

  storage.getOrCreateUser(userId).catch(() => {});

  try {
    const servedFromCache = await serveFromCache(bot, chatId, userId, bookName, token, userName, dlCount, dailyLimit, isPrem, t0, trace);
    if (servedFromCache) {
      await deleteMsg(token, chatId, msgId);
      if (job.userMessageId) reactRandom(bot, chatId, job.userMessageId, REACTION_CACHE_HIT).catch(() => {});
      await trace.finish("sent_from_cache");
      trackFunnelOnce(job.id, {
        searchFound:   true,
        verifyChecked: 0,
        verifyValid:   0,
        sendMode:      "direct",
        sendSuccess:   true,
      });
      await sendAnnouncement(bot, chatId, userId);
      // PR G — auto-summary trigger after cache hit. The
      // sourceUrl is whatever the cached entry held (may be empty
      // for legacy file_id-only cache); runSummaryFlow falls back
      // to text-only providers when no PDF URL is available.
      if (job.wantsSummary) {
        const cachedEntry = await storage.getCachedBook(bookName).catch(() => null);
        await maybeAutoSummary(bot, chatId, userId, bookName, cachedEntry?.sourceUrl ?? undefined, true);
      }
      return;
    }
    const fullSearchResult = await performFullSearch(bot, chatId, userId, bookName, token, userName, msgId, dlCount, dailyLimit, isPrem, t0, trace, job.id, job.userMessageId);
    await sendAnnouncement(bot, chatId, userId);
    if (job.wantsSummary && fullSearchResult?.sent) {
      await maybeAutoSummary(bot, chatId, userId, bookName, fullSearchResult.sourceUrl, true);
    }
  } catch (e) {
    L.error("worker", `processBookRequest error`, { userId, book: bookName.slice(0, 50), err: String(e).slice(0, 200) });
    await deleteMsg(token, chatId, msgId);

    const err = String(e).toLowerCase();
    let msg = "❌ *حدث خطأ غير متوقع.* حاول مرة أخرى.";
    if (err.includes("timeout") || err.includes("abort"))
      msg = "⏱️ *انتهت مهلة الاتصال.* الشبكة بطيئة.";
    else if (err.includes("network") || err.includes("fetch"))
      msg = "🌐 *مشكلة في الشبكة.* تحقق من الاتصال.";
    else if (err.includes("too large") || err.includes("file_size"))
      msg = "📦 *الملف كبير جداً* (أكثر من 50 MB).";

    await bot.sendMessage(chatId, msg, {
      parse_mode:   "Markdown",
      reply_markup: kbAfterFail(bookName, []),
      // Reply-quote so the user knows which request errored (groups).
      ...(job.userMessageId
        ? { reply_to_message_id: job.userMessageId, allow_sending_without_reply: true }
        : {}),
    }).catch(() => {});

    if (job.userMessageId) reactRandom(bot, chatId, job.userMessageId, REACTION_ERROR).catch(() => {});

    // Record so the auto-retry worker can re-attempt later — once the
    // network/Firecrawl recovers, the user gets the book without
    // having to ask again. Cheap fire-and-forget; failures here are
    // logged but never propagate.
    if (job.userMessageId) {
      recordFailure({
        userId:        userId,
        chatId:        chatId,
        userMessageId: job.userMessageId,
        userName:      userName ?? null,
        bookName:      bookName,
        reason:        "error",
      }).catch(() => {});
    }

    trace.finish("error").catch(() => {});
    // FIX BUG-7: كان يُعيد throw بعد إرسال رسالة الخطأ للمستخدم
    // هذا يسبب: Worker يُعيد المحاولة → إما يصل الكتاب بدون سياق، أو رسالة خطأ ثانية
    // الحل: لا نُعيد throw — المستخدم أُخبر بالخطأ، الـ job يُكمَل بشكل طبيعي
    // الـ Worker سيستدعي completeJob ويُنقص الـ pending counter
  }
}

// ── Cache Hit Re-Validation (FIX-WRONG-FILE BUG-3) ──────────────
//
// Treat a cache hit as suspect if either:
//   (a) the cached.bookName tokens overlap < 40% with the requested
//       bookName tokens (after canonicalization), OR
//   (b) the cached.sourceUrl filename is opaque AND its filename
//       relevance to the requested bookName is < 0.10 — i.e. nothing
//       in the URL signals it's the right book either.
//
// We deliberately keep both checks lenient: legitimate cache hits
// (perfect query match → 100% overlap, score 1.0) always pass.
function cacheHitMatchesQuery(
  requestedBook: string,
  cachedBookName: string,
  sourceUrl: string,
): boolean {
  const reqTokens = canonicalizeForCache(requestedBook)
    .split(/\s+/).filter((w) => w.length >= 3);
  const cachedTokens = new Set(
    canonicalizeForCache(cachedBookName)
      .split(/\s+/).filter((w) => w.length >= 3),
  );
  if (reqTokens.length === 0 || cachedTokens.size === 0) {
    // not enough signal — let the validator on re-download decide
    return true;
  }
  const matched = reqTokens.filter((w) => cachedTokens.has(w)).length;
  const overlap = matched / reqTokens.length;
  if (overlap >= 0.80) return true;

  // Low overlap — only allow if URL filename gives independent signal
  const filenameScore = sourceUrl ? urlFilenameRelevance(requestedBook, sourceUrl) : 0;
  if (filenameScore >= 0.80) return true;

  return false;
}

// ── Cache Serve ───────────────────────────────

async function serveFromCache(
  bot: TelegramBot, chatId: number, userId: string, bookName: string,
  token: string, userName: string | null | undefined,
  dlCount: number, dailyLimit: number, isPrem: boolean, t0: number,
  trace: RequestTrace
): Promise<boolean> {
  // BUG-7 FIX: await A || await B ينتظر A كاملاً قبل B — نُشغّل الاثنين بالتوازي
  const normalizedName = normalizeForCache(bookName);
  let cached: Awaited<ReturnType<typeof storage.getCachedBook>>;
  if (normalizedName === bookName) {
    cached = await storage.getCachedBook(bookName).catch(() => null);
  } else {
    const [a, b] = await Promise.all([
      storage.getCachedBook(bookName).catch(() => null),
      storage.getCachedBook(normalizedName).catch(() => null),
    ]);
    cached = a ?? b;
  }
  if (!cached) return false;

  // FIX-WRONG-FILE (BUG-3): re-validate cache hit before serving.
  //
  // Cache writes have anti-poison guards (filename score, opaque URL),
  // but cache READS were blind: any poisoned entry that slipped through
  // (or pre-dates a guard) would keep delivering the wrong file to
  // every subsequent matching query until TTL/manual purge.
  //
  // Sanity checks (any failure → treat as miss, fall through to full
  // search; we keep the entry so a later valid sourceUrl can still
  // refresh it via the re-cache path below):
  //   1. cached.bookName (the title we actually delivered last time)
  //      shares ≥ 40% of tokens with the current bookName, normalized.
  //   2. cached.sourceUrl filename relevance is acceptable
  //      (≥ 0.10) OR the URL is non-opaque (so the validator/Mistral
  //      will catch a mismatch on re-download).
  //
  // Both checks are cheap (string ops only). They only run on cache
  // hit — the common case is no-op (perfect match → score = 1.0).
  if (!cacheHitMatchesQuery(bookName, cached.bookName, cached.sourceUrl ?? "")) {
    L.warn("cache", "cache hit looked suspicious — falling through to full search", {
      query:      bookName.slice(0, 50),
      cachedName: cached.bookName.slice(0, 50),
      sourceUrl:  (cached.sourceUrl ?? "").slice(0, 80),
    });
    redis.incr("tel:cache:hit_revalidated_skip").catch(() => {});
    return false;
  }

  if (cached.telegramFileId) {
    try {
      const escHtmlLocal = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await bot.sendDocument(chatId, cached.telegramFileId, {
        caption: `📚 <b>${escHtmlLocal(cached.bookName)}</b>\n\n⚡ من رفيق`,
        parse_mode: "HTML",
      });
      // FIX-3: دمج 3 عمليات increment في Promise.all بدل 3 fire-and-forget منفصلة
      Promise.all([
        storage.incrementCacheServed(cached.id),
        storage.incrementDailyDownload(userId),
        storage.incrementUserDownloads(userId),
      ]).catch(() => {});
      logSearch(userId, userName, bookName, true, true, 1);
      setLastBook(userId, bookName).catch(() => {});
      warmRelatedCache(bookName).catch(() => {});
      // Pass cached.bookName as canonical title — أحدث صياغة كنسية للكتاب
      // ده بيدمج كل المستخدمين اللي طلبوا نفس الكتاب بصيغ مختلفة في leaderboard entry واحد.
      trackDownload(userId, bookName, true, true, undefined, Date.now() - t0, cached.bookName).catch(() => {});
      // Clear any stale failure record so the retry worker doesn't
      // re-deliver the same book with an "وجدتُ الكتاب الآن" apology.
      removeFailure(failureKey(userId, chatId, bookName)).catch(() => {});
      await sendSuccessMessage(bot, chatId, userId, dlCount + 1, dailyLimit, bookName, cached.sourceUrl || "", undefined, true, false, isPrem);
      recordDelivery(Date.now() - t0, "ok_cache").catch(() => {});
      return true;
    } catch {
      L.warn("cache", `file_id expired for "${bookName}", trying sourceUrl`);
    }
  }

  if (cached.sourceUrl) {
    try {
      const qr = await downloadAndSend(bot, chatId, cached.sourceUrl, bookName, token);
      if (qr.ok) {
        if (qr.fileId) {
          storage.cacheBook({
            bookQuery: bookName, bookQueryNormalized: normalizeForCache(bookName),
            telegramFileId: qr.fileId, fileName: `${bookName}.pdf`, bookName, sourceUrl: cached.sourceUrl,
          }).catch(() => {});
        } else {
          // BUG FIX: نجح التحميل لكن بدون fileId — احذف الـ entry القديمة الفاسدة
          storage.deleteCachedBook(cached.id).catch(() => {});
        }
        Promise.all([
          storage.incrementCacheServed(cached.id),
          storage.incrementDailyDownload(userId),
          storage.incrementUserDownloads(userId),
        ]).catch(() => {});
        logSearch(userId, userName, bookName, true, true, 1);
        setLastBook(userId, bookName).catch(() => {});
        warmRelatedCache(bookName).catch(() => {});
        // Pass cached.bookName as canonical title — راجع التعليق أعلاه.
        trackDownload(userId, bookName, true, true, cached.sourceUrl?.split("/")[2], Date.now() - t0, cached.bookName).catch(() => {});
        // Clear any stale failure record — see comment on file_id path.
        removeFailure(failureKey(userId, chatId, bookName)).catch(() => {});
        await sendSuccessMessage(bot, chatId, userId, dlCount + 1, dailyLimit, bookName, cached.sourceUrl, qr.sizeMB, true, false, isPrem);
      recordDelivery(Date.now() - t0, "ok_cache").catch(() => {});
        return true;
      }
    } catch (e) {
      L.warn("cache", `sourceUrl failed`, { book: bookName.slice(0, 50), err: String(e).slice(0, 80) });
    }
  }

  // كلا المصدرين فشلا — احذف الـ cache entry الفاسدة
  // BUG FIX: لا نُسجّل logSearch هنا — performFullSearch سيُسجّله بعد إعادة المحاولة
  // (الكود القديم كان يُسجّل مرتين: مرة هنا ومرة في performFullSearch)
  storage.deleteCachedBook(cached.id).catch(() => {});
  return false;
}

// ── Full Search ───────────────────────────────

async function performFullSearch(
  bot: TelegramBot, chatId: number, userId: string, bookName: string,
  token: string, userName: string | null | undefined,
  msgId: number, dlCount: number, dailyLimit: number, isPrem: boolean, t0: number,
  trace: RequestTrace,
  jobId: string,
  userMessageId?: number
): Promise<{ sent: boolean; sourceUrl?: string }> {
  await editMsg(token, chatId, msgId, buildProgress(1, bookName, tip(isPrem)));
  armProgressWatchdog(token, chatId, msgId, 1, bookName);

  const { results: rawResults, usedFuzzy } = await searchWithFuzzyFallback(bookName);

  // ── Auto-retry بالاستعلام المنظف ──────────────
  // لو المستخدم كتب "تحميل رواية X pdf" → نجرب "X" تلقائياً
  let results = rawResults;
  let cleanedQuery = bookName;
  if (results.length === 0) {
    const q = cleanSearchQuery(bookName);
    if (q !== bookName && q.length >= 2) {
      cleanedQuery = q;
      const { results: retryResults } = await searchWithFuzzyFallback(q);
      if (retryResults.length > 0) {
        results = retryResults;
        L.info("bot", `Auto-retry with cleaned query succeeded`, {
          original: bookName.slice(0, 50),
          cleaned: q.slice(0, 50),
          results: retryResults.length,
        });
        await editMsg(token, chatId, msgId, buildProgress(2, q, `💡 جربت: _"${escMd(q)}"_`));
        armProgressWatchdog(token, chatId, msgId, 2, q);
      }
    }
  }

  // ── Llama transliteration retry (audit follow-up #2, 2026-05-09) ──
  // If both the raw query and the cleanSearchQuery-stripped query came
  // up empty, ask Llama whether the user garbled a foreign-name
  // transliteration (e.g. "وتيدصي درايدن" → "ويندي درايدن"). On a
  // meaningful correction we retry the search once. Cached 7 days so
  // popular bad queries don't re-burn neurons.
  // Module: server/bot/aiProviders/llamaTransliteration.ts
  if (results.length === 0) {
    const tlit = await correctTransliteration(bookName).catch(() => null);
    if (tlit && tlit.changed) {
      const { results: tlitResults } = await searchWithFuzzyFallback(tlit.corrected);
      if (tlitResults.length > 0) {
        results = tlitResults;
        cleanedQuery = tlit.corrected;
        redis.incr(TEL_TLIT_RETRY_RECOVERED).catch(() => {});
        L.info("bot", `Auto-retry with Llama-corrected query succeeded`, {
          original:  bookName.slice(0, 50),
          corrected: tlit.corrected.slice(0, 50),
          results:   tlitResults.length,
        });
        await editMsg(
          token, chatId, msgId,
          buildProgress(2, tlit.corrected, `💡 صححت لـ: _"${escMd(tlit.corrected)}"_`),
        );
        armProgressWatchdog(token, chatId, msgId, 2, tlit.corrected);
      }
    }
  }
  trace.phase("search_done", {
    results:   results.length,
    usedFuzzy: usedFuzzy || false,
    ms:        Date.now() - t0,
  });

  if (results.length === 0) {
    await deleteMsg(token, chatId, msgId);
    clearProgressWatchdog(msgId);
    if (userMessageId) reactRandom(bot, chatId, userMessageId, REACTION_NO_RESULT).catch(() => {});
    logSearch(userId, userName, bookName, false, false, 0);
    trackDownload(userId, bookName, false, false, undefined, Date.now() - t0).catch(() => {});
    trackFunnelOnce(jobId, { searchFound: false, verifyChecked: 0, verifyValid: 0, sendMode: null, sendSuccess: false });
    await trace.finish("no_results");

    // Track for auto-retry. If a fix lands or a source comes back
    // online within RETRY_TTL_DAYS, the worker will replay this
    // search and deliver the PDF as a quoted reply.
    if (userMessageId) {
      recordFailure({
        userId:        userId,
        chatId:        chatId,
        userMessageId: userMessageId,
        userName:      userName ?? null,
        bookName:      bookName,
        reason:        "no_results",
      }).catch(() => {});
    }

    {
      const dym = await buildDidYouMeanMessage(bookName, /* apologetic */ true);
      await bot.sendMessage(
        chatId,
        dym.text,
        {
          parse_mode:   "Markdown",
          reply_markup: dym.suggestions.length > 0
            ? kbDidYouMean(bookName, dym.suggestions)
            : kbNoResults(bookName),
          ...(userMessageId
            ? { reply_to_message_id: userMessageId, allow_sending_without_reply: true }
            : {}),
        },
      );
    }
    return { sent: false };
  }

  if (usedFuzzy) {
    await editMsg(token, chatId, msgId, buildProgress(2, bookName, "💡 لم أجد تطابقاً تاماً — أجرّب أقرب نتيجة"));
    armProgressWatchdog(token, chatId, msgId, 2, bookName);
  }

  await editMsg(token, chatId, msgId, buildProgress(3, bookName, `📄 وجدت *${results.length}* نتيجة\n\n${tip(isPrem)}`));
  armProgressWatchdog(token, chatId, msgId, 3, bookName);

  const allPdfUrls: string[] = [];
  const pageUrlFallbacks: string[] = [];
  const downloadablePageFallbacks: string[] = [];
  // BUG FIX: استخدام Set لتجنب تكرار نفس URL في كلا القائمتين
  // قبل: نفس URL يمكن أن يُضاف أكثر من مرة إذا أعادته مصادر متعددة
  const seenPdfUrls   = new Set<string>();
  const seenPageUrls  = new Set<string>();
  const seenDownloadPages = new Set<string>();
  // url → search-result HTML <title> from Firecrawl. Threaded to
  // downloadAndSend → validatePdfContent so the validator can title-gate
  // even on trusted domains and recover the title when PDF /Title is
  // unreadable. Strip URL-only fallbacks (engine.ts uses url as title
  // when the page has no <title> tag).
  const urlSearchTitle = new Map<string, string>();
  // url → known file size (Telegram search). Used to prefer smaller PDFs
  // in the download order and to surface openable t.me links when too large.
  const urlFileSize = new Map<string, number>();
  // Count results flagged as paid/protected by classifyAccess() in
  // engine.ts. When all download attempts fail AND the search returned
  // ANY paid signals, we tell the user the book is paid rather than
  // sending the generic "no PDF" message that misleads them.
  let paidSignalCount = 0;
  for (const r of results) {
    const cleanTitle = (r.title && !r.title.startsWith("http")) ? r.title : "";
    if (r.access === "protected_page") paidSignalCount++;
    if (r.directPdfUrl) {
      if (!seenPdfUrls.has(r.directPdfUrl)) {
        seenPdfUrls.add(r.directPdfUrl);
        allPdfUrls.push(r.directPdfUrl);
      }
      // Don't overwrite a title from an earlier result for the same URL
      // — first match wins (typically the highest-scored search hit).
      if (cleanTitle && !urlSearchTitle.has(r.directPdfUrl)) {
        urlSearchTitle.set(r.directPdfUrl, cleanTitle);
      }
      if (typeof r.fileSize === "number" && r.fileSize > 0 && !urlFileSize.has(r.directPdfUrl)) {
        urlFileSize.set(r.directPdfUrl, r.fileSize);
      }
    } else if (r.url && r.access === "download_page") {
      if (!seenDownloadPages.has(r.url)) {
        seenDownloadPages.add(r.url);
        downloadablePageFallbacks.push(r.url);
      }
      if (cleanTitle && !urlSearchTitle.has(r.url)) {
        urlSearchTitle.set(r.url, cleanTitle);
      }
    } else if (r.url) {
      if (!seenPageUrls.has(r.url)) {
        seenPageUrls.add(r.url);
        pageUrlFallbacks.push(r.url);
      }
      if (cleanTitle && !urlSearchTitle.has(r.url)) {
        urlSearchTitle.set(r.url, cleanTitle);
      }
    }
  }
  // findValidPdfUrls تفلتر الـ blacklist داخلياً — لا داعي لفحص مسبق
  const uniquePdfs = [...allPdfUrls]; // already deduped via seenPdfUrls

  await editMsg(token, chatId, msgId, buildProgress(4, bookName, tip(isPrem)));
  armProgressWatchdog(token, chatId, msgId, 4, bookName);

  const verifyBatch = await findValidPdfUrls(uniquePdfs);
  let validUrls = verifyBatch.urls;
  const verifyStats = verifyBatch.stats;
  trace.phase("verify_done", {
    blacklisted: verifyStats.blacklisted,
    checked:     verifyStats.checked,
    valid:       verifyStats.valid,
    ms:          Date.now() - t0,
  });
  // BUG-A FIX (الثقب الأكبر): الكود القديم:
  //   if (validUrls.length === 0 && uniquePdfs.length > 0) validUrls = uniquePdfs.slice(0,5)
  // المشكلة: إذا كان uniquePdfs.length === 0 (لا روابط PDF في الـ markdown أصلاً)
  //   → الشرط خاطئ → validUrls يبقى [] → حلقة التحميل لا تعمل → فشل فوري
  //   هذا يحدث لكثير من مواقع الكتب العربية التي تخفي رابط التحميل خلف JS
  //
  // الحل 3 مستويات:
  //   1. روابط PDF المُتحقَّق منها (أفضل)
  //   2. روابط PDF الخام غير المُتحقَّق منها (fallback معتاد)
  //   3. صفحات HTML المحتملة — download.ts يستخرج PDF منها تلقائياً (fallback أخير)
  if (validUrls.length === 0 && uniquePdfs.length > 0) {
    // Fallback 2: روابط PDF الخام (فشلت verify لكن قد تنجح عند التحميل الفعلي)
    validUrls = [...uniquePdfs.slice(0, 5)];
  } else if (validUrls.length === 0 && uniquePdfs.length === 0 && downloadablePageFallbacks.length > 0) {
    L.info("bot", `No direct PDF URLs — trying ${Math.min(3, downloadablePageFallbacks.length)} download pages as last resort`, {
      book: bookName.slice(0, 50),
    });
    validUrls = [...new Set(downloadablePageFallbacks)].slice(0, 3);
  }

  // Fallback paths skip findValidPdfUrls — re-check blacklist so we don't
  // burn a download attempt (and the user's patience) on known-bad URLs.
  if (validUrls.length > 0) {
    const blFlags = await Promise.all(validUrls.map((u) => isBlacklisted(u).catch(() => false)));
    const before = validUrls.length;
    validUrls = validUrls.filter((_, i) => !blFlags[i]);
    if (validUrls.length < before) {
      L.info("bot", "Filtered blacklisted candidates before download loop", {
        book: bookName.slice(0, 50),
        removed: before - validUrls.length,
        remaining: validUrls.length,
      });
      redis.incrby("tel:dl:preloop_blacklist_filtered", before - validUrls.length).catch(() => {});
    }
  }

  // ── ترتيب URLs الذكي — 3 معايير مدمجة ──────────────────────────────
  // FIX-WRONG-FILE: الترتيب القديم كان يعتمد فقط على أداء المصدر التاريخي
  // هذا يسبب إرسال ملفات خاطئة (مثل TT-79.pdf) حتى لو المصدر "موثوق"
  // الحل: دمج 3 معايير:
  //   (1) صلة اسم الملف بالكتاب المطلوب (الأهم — يمنع إرسال ملف خاطئ)
  //   (2) أداء المصدر التاريخي من analytics
  //   (3) عقوبة الموثوقية: hard لـ UNRELIABLE_DOMAINS، soft للمصادر
  //       اللي success rate < LOW_SUCCESS_RATE_PENALTY_THRESHOLD (مثل
  //       Hindawi 16% أو foulabook 25%) عشان يطلعوا بعد المصادر الأقوى.
  if (validUrls.length > 1) {
    // Kept inside the multi-URL guard so single-/zero-candidate
    // requests don't pay for `redis.keys("stats:source:*")` +
    // N×HGETALL (code review on #32 caught this when the init was
    // briefly hoisted).
    // نستخدم trustRate (ok / (ok+fail+mistralRejected)) بدل successRate
    // البسيط (ok / (ok+fail)). الفرق: لو مصدر بيرجع PDFs بنجاح بس Mistral
    // بيرفضها كلها (يعني search-ranker بياخد wrong-book URLs)، ده fail
    // فعلي من منظور المستخدم. مثال: Hindawi عنده successRate=27% لكن
    // trustRate=17% — والـ trustRate هو الإشارة الصحيحة للـ ranker.
    let srcRateMap = new Map<string, number>();
    try {
      // النسخة الـ cached (30s TTL) عشان كل full-search متعدد المصادر
      // ما يدفعش تكلفة SCAN + N×HGETALL على Redis. الـ trustRate كميّة
      // تراكمية فالـ staleness بسيطة لا تؤثر على ترتيب URLs.
      const srcStats = await getSourceStatsCached();
      srcRateMap = new Map(srcStats.map((s) => [s.domain, s.trustRate]));
    } catch {}

    validUrls.sort((a, b) => {
      const scoreUrl = (url: string): number => {
        const domain = sanitizeDomainKey(url.split("/")[2] || "");
        // (1) صلة اسم الملف — 0 لـ 1، وزن 50%
        const filenameScore = urlFilenameRelevance(bookName, url);
        // (2) أداء المصدر التاريخي — 0 لـ 1، وزن 30%
        const sourceRate = srcRateMap.get(domain) ?? 0.5;
        // (3) عقوبة الموثوقية — وزن 20%
        //   * UNRELIABLE_DOMAINS (block-list ثابت): -1 (عقوبة قوية ثابتة)
        //   * Low actual rate (لدينا ≥1 attempt + < threshold): -0.5 (soft)
        //   * Otherwise: +1 (محايد/إيجابي)
        let reliablePenalty: number;
        if (UNRELIABLE_DOMAINS.some(d => domain.includes(d))) {
          reliablePenalty = -1;
        } else if (
          LOW_SUCCESS_RATE_PENALTY_THRESHOLD > 0 &&
          srcRateMap.has(domain) &&
          sourceRate < LOW_SUCCESS_RATE_PENALTY_THRESHOLD
        ) {
          reliablePenalty = -0.5;
        } else {
          reliablePenalty = 1;
        }
        // (4) size preference when known (Telegram): smaller = better under bot cap
        const sz = urlFileSize.get(url) ?? 0;
        let sizeBoost = 0;
        if (sz > 0) {
          if (sz <= 5 * 1024 * 1024) sizeBoost = 0.15;
          else if (sz <= 20 * 1024 * 1024) sizeBoost = 0.06;
          else if (sz <= 35 * 1024 * 1024) sizeBoost = 0.0;
          else sizeBoost = -0.08;
        }
        // (5) latency class: invert so lower class (faster) scores higher
        const lat = latencyClassForUrl(url);
        const latencyBoost = Math.max(0, 1 - lat * 0.18); // 0→1.0, 1→0.82, 5→0.1
        // (6) FIX-DELIVERY: opaque digit-only filenames (Hindawi /books/123.pdf)
        // have zero title signal — they burn domain caps on wrong books.
        // Deprioritize unless search-title relevance rescues them.
        const opaque = hasUninformativeFilename(url);
        const searchT = urlSearchTitle.get(url) || "";
        let titleBoost = 0;
        if (searchT) {
          const titleAsUrl = `https://x/${encodeURIComponent(searchT)}.pdf`;
          titleBoost = urlFilenameRelevance(bookName, titleAsUrl);
        }
        const opaquePenalty = opaque && filenameScore < 0.15 && titleBoost < 0.35 ? -0.45 : 0;
        const effectiveName = Math.max(filenameScore, titleBoost * 0.9);
        return (
          effectiveName * 0.48 +
          sourceRate * 0.16 +
          reliablePenalty * 0.10 +
          sizeBoost * 0.10 +
          latencyBoost * 0.10 +
          opaquePenalty
        );
      };
      return scoreUrl(b) - scoreUrl(a);
    });

    // Domain diversity: after score sort, interleave hosts so attempt #1..N
    // sample different sources (reduces found_no_send from one bad domain).
    // Stable secondary key: prefer lower latency class within interleave.
    validUrls = diversifyUrlsByDomain(validUrls);
    // FIX-DELIVERY: previous micro-pass re-sorted head by latency only,
    // which floated Hindawi numeric PDFs (latency class 0) above
    // high-relevance candidates and burned the domain cap on wrong books.
    // Keep diversity order; only swap within the same host to prefer
    // higher filename/title relevance.
    {
      const head = validUrls.slice(0, 8);
      const rest = validUrls.slice(8);
      const scored = (u: string): number => {
        const fn = urlFilenameRelevance(bookName, u);
        const st = urlSearchTitle.get(u) || "";
        const tb = st ? urlFilenameRelevance(bookName, `https://x/${encodeURIComponent(st)}.pdf`) : 0;
        const opaque = hasUninformativeFilename(u) ? -0.3 : 0;
        return Math.max(fn, tb) + opaque - latencyClassForUrl(u) * 0.02;
      };
      // Stable domain-interleave already applied; re-order within each
      // domain bucket by score, then re-interleave.
      const buckets = new Map<string, string[]>();
      const order: string[] = [];
      for (const u of head) {
        let host = "";
        try { host = new URL(u.startsWith("tg://") ? "https://t.me.local" : u).hostname.toLowerCase(); } catch {
          host = (u.split("/")[2] || "unknown").toLowerCase();
        }
        if (u.includes("t.me/") || u.startsWith("tg://")) host = "t.me";
        if (!buckets.has(host)) { buckets.set(host, []); order.push(host); }
        buckets.get(host)!.push(u);
      }
      for (const h of order) {
        buckets.get(h)!.sort((a, b) => scored(b) - scored(a));
      }
      const out: string[] = [];
      let progress = true;
      while (progress) {
        progress = false;
        // Prefer hosts whose next URL has higher score (not just first-seen order)
        const ready = order
          .filter(h => (buckets.get(h)?.length ?? 0) > 0)
          .sort((ha, hb) => scored(buckets.get(hb)![0]) - scored(buckets.get(ha)![0]));
        for (const h of ready) {
          const arr = buckets.get(h)!;
          if (arr.length) { out.push(arr.shift()!); progress = true; break; }
        }
      }
      validUrls = [...out, ...rest];
    }

    // الحماية في pdfValidator — يقرأ metaTitle من PDF بعد التحميل

    // تحذير في الـ logs إذا أفضل رابط متبقٍّ له صلة منخفضة جداً بالكتاب
    const bestFilenameScore = urlFilenameRelevance(bookName, validUrls[0]);
    if (bestFilenameScore < 0.15) {
      L.warn("bot", `All URLs have low filename relevance — possible wrong-file risk`, {
        book: bookName.slice(0, 50),
        bestUrl: validUrls[0].slice(0, 80),
        score: bestFilenameScore.toFixed(2),
      });
    }
  }

  // ── RESCUE-LOW-RELEVANCE: augment with download_page fallbacks ──
  // BUG (real prod failure for "في قلبي أنثى عبرية" / Khawla Hamdi):
  // Firecrawl returned 20 results. Only 1 had a directly extractable
  // PDF link — a junk scholar.archive.org wayback URL pointing to an
  // English academic paper *about* the novel, not the novel itself.
  // The other 19 included multiple high-relevance ketabpedia /
  // foulabook / noor-book download pages that were all dropped
  // because validUrls.length > 0 (the existing fallback chain only
  // uses downloadablePageFallbacks when validUrls AND uniquePdfs are
  // both empty). The user got a generic "لا أملك نتيجة موثوقة"
  // for a bestseller available on every Arabic book site.
  //
  // Fix: when the top PDF candidate has weak filename relevance to
  // the book name (URL- or title-based), append up to 3 download_page
  // fallbacks whose title strongly matches the book. download.ts
  // already knows how to extract a PDF from a download_page (it does
  // exactly that in the no-PDF fallback path above); we just give it
  // more shots before declaring failure.
  // Thresholds from config (overridable via env) — see RESCUE_* in config.ts
  if (
    downloadablePageFallbacks.length > 0
  ) {
    // URL-based score is fragile for trailing-slash URLs (path's
    // last segment is empty); fall back to title-based scoring using
    // the search-result <title> we already captured. Same trick as
    // engine.ts's scoreResult: synthesize a fake URL from the title
    // so we can reuse urlFilenameRelevance for word-overlap math.
    const scoreWithTitleFallback = (u: string): number => {
      const urlScore = urlFilenameRelevance(bookName, u);
      const t = urlSearchTitle.get(u);
      if (!t) return urlScore;
      const titleAsUrl = `https://x/${encodeURIComponent(t)}.pdf`;
      return Math.max(urlScore, urlFilenameRelevance(bookName, titleAsUrl));
    };

    const bestPdfScore = validUrls.length > 0
      ? scoreWithTitleFallback(validUrls[0])
      : 0;
    // Rescue when: (a) top PDF is weak relevance, OR (b) too few candidates
    // (production: 14–21 hits → 1 PDF → one permanent fail = dead request).
    const needRescue =
      bestPdfScore < RESCUE_BEST_PDF_THRESHOLD ||
      validUrls.length < RESCUE_MIN_CANDIDATES;
    if (needRescue) {
      const want = Math.max(
        RESCUE_MAX_FALLBACKS,
        RESCUE_MIN_CANDIDATES - validUrls.length,
      );
      const scoreFloor = validUrls.length < RESCUE_MIN_CANDIDATES
        ? Math.min(RESCUE_FALLBACK_THRESHOLD, 0.25) // looser when starved for candidates
        : RESCUE_FALLBACK_THRESHOLD;
      const augmented = [...new Set(downloadablePageFallbacks)]
        .filter((u) => !validUrls.includes(u))
        .map((u) => ({ url: u, score: scoreWithTitleFallback(u) }))
        .filter(({ score }) => score >= scoreFloor)
        .sort((a, b) => b.score - a.score)
        .slice(0, want);
      if (augmented.length > 0) {
        L.info(
          "bot",
          `rescue_candidates — augmenting ${validUrls.length} PDF candidate(s) with ${augmented.length} download_page fallback(s)`,
          {
            book:           bookName.slice(0, 50),
            bestPdfScore:   bestPdfScore.toFixed(2),
            reason:         bestPdfScore < RESCUE_BEST_PDF_THRESHOLD ? "low_relevance" : "too_few",
            fallbackScores: augmented.map((a) => a.score.toFixed(2)),
          },
        );
        validUrls.push(...augmented.map((a) => a.url));
        // Re-diversify after append so new domains interleave
        validUrls = diversifyUrlsByDomain(validUrls);
        redis.incr("tel:dl:rescue_augmented").catch(() => {});
      }
    }
  }

  await editMsg(token, chatId, msgId, buildProgress(5, bookName, tip(isPrem)));
  armProgressWatchdog(token, chatId, msgId, 5, bookName);

  const chatActionInterval = setInterval(() => {
    bot.sendChatAction(chatId, "upload_document").catch(() => {});
  }, 4000);
  bot.sendChatAction(chatId, "upload_document").catch(() => {});

  let sent = false, sentFileId: string | undefined, sentSizeMB: string | undefined;
  let sentSourceUrl = "", sentDomain = "", sentSendMode: "direct" | "local" = "local";
  // BUG-R4 FIX: isSuspectFile يُحسَب مرة واحدة خارج الحلقة ويُعاد استخدامه
  // قبل: يُحسَب مرتين (داخل الحلقة + بعدها) — نتيجتان قد تختلفان لو تغيّر المنطق
  let sentFilenameScore = 0.5; // neutral حتى يُضبط بعد التحميل الناجح

  // Mistral early-stop: count consecutive NO verdicts and skip Mistral
  // for remaining candidates once the streak crosses
  // MISTRAL_NO_STREAK_LIMIT.
  //
  // FIX-WRONG-FILE (NIT-2): the streak is now tracked PER DOMAIN, not
  // global. Previously, 3 NOs on Hindawi would short-circuit Mistral
  // for a subsequent (potentially correct) candidate from foulabook,
  // causing it to be rejected by the local-only fallback. Per-domain
  // ensures only the same source's repeated bad rankings disable
  // Mistral, while a different source still gets a fresh evaluation.
  // The global streak is kept for telemetry only.
  let globalMistralNoStreak = 0;
  const mistralNoStreakByDomain = new Map<string, number>();

  // Download attempt accounting (find-to-send loss mitigation).
  // - `attemptedDownloads` counts URLs we've actually tried (including
  //   internal retry-after-back-off, which we treat as one attempt).
  // - `attemptsByDomain` enforces the per-host cap so a low-success
  //   source can't crowd the loop with all of its URLs while higher-
  //   ranked alternatives go untried.
  // See config.ts MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST and
  // MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN. 0 disables the corresponding cap.
  let attemptedDownloads = 0;
  const attemptsByDomain = new Map<string, number>();
  const contentRejectsByDomain = new Map<string, number>();
  let globalCapReached = false;
  let domainCapHits = 0;
  let tooLargeHits = 0;

  try {
    for (const pdfUrl of validUrls) {
      const dlDomain   = sanitizeDomainKey(pdfUrl.split("/")[2] || "");

      // Global cap: stop trying entirely. Future URLs are abandoned;
      // the request falls through to the "links_only" / paid-book
      // path so the user gets a useful response instead of a timeout.
      if (
        MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST > 0 &&
        attemptedDownloads >= MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST
      ) {
        globalCapReached = true;
        L.info("bot", "global download cap reached — abandoning remaining candidates", {
          book: bookName.slice(0, 50),
          attempted: attemptedDownloads,
          remaining: validUrls.length - attemptedDownloads,
          cap: MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST,
        });
        redis.incr("tel:dl:global_cap_reached").catch(() => {});
        trace.phase("download_global_cap_reached", {
          attempted: attemptedDownloads,
          remaining: validUrls.length - attemptedDownloads,
        });
        break;
      }

      // Per-domain cap: skip this URL but keep iterating so we reach
      // URLs from other domains. Common case is 5 Hindawi URLs in a
      // row — historically all 5 got tried; now we stop after 2.
      const domainAttempts = attemptsByDomain.get(dlDomain) ?? 0;
      if (
        MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN > 0 &&
        dlDomain &&
        domainAttempts >= MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN
      ) {
        domainCapHits++;
        L.info("bot", "per-domain download cap reached — skipping URL", {
          book: bookName.slice(0, 50),
          domain: dlDomain,
          attempted: domainAttempts,
          cap: MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN,
          url: pdfUrl.slice(0, 80),
        });
        redis.incr("tel:dl:per_domain_capped").catch(() => {});
        continue;
      }

      attemptsByDomain.set(dlDomain, domainAttempts + 1);
      attemptedDownloads++;

      const domainStreak = mistralNoStreakByDomain.get(dlDomain) ?? 0;
      const skipMistral = MISTRAL_NO_STREAK_LIMIT > 0 &&
                          domainStreak >= MISTRAL_NO_STREAK_LIMIT;
      if (skipMistral) {
        L.info("bot", "Mistral early-stop active for this domain", {
          book: bookName.slice(0, 50),
          domain: dlDomain,
          domainStreak,
          globalStreak: globalMistralNoStreak,
          url: pdfUrl.slice(0, 80),
        });
      }
      trace.phase("download_started", { url: pdfUrl.slice(0, 80), domain: dlDomain });
      const srcTitle = urlSearchTitle.get(pdfUrl) ?? "";
      let result = await downloadAndSend(bot, chatId, pdfUrl, bookName, token, false, skipMistral, srcTitle);
      // BUG FIX: كان يُعيد المحاولة حتى عند rejectedContent=true
      // عندما يُرفض الـ PDF بسبب عدم تطابق المحتوى، إعادة التحميل ستُعطي نفس الـ bytes
      // → نفس النتيجة → هدر 90 ثانية + استهلاك bandwidth بلا فائدة
      // الحل: تجاوز الـ retry إذا كان الرفض بسبب المحتوى أو إذا كان permanent
      if (!result.ok && !result.permanent && !result.rejectedContent) {
        await sleep(500); // M4 FIX: 500ms كافٍ للـ back-off — 2000ms كانت تعطّل الـ worker
        result = await downloadAndSend(bot, chatId, pdfUrl, bookName, token, false, skipMistral, srcTitle);
      }
      if (!result.ok) {
        // BUG FIX: Mistral content-mismatch ≠ source failure.
        // The source successfully delivered a real PDF; the search ranker
        // just picked a wrong-book URL on this domain. Counting it as a
        // source `fail` would (and historically did) auto-disable healthy
        // libraries like Hindawi (1 ok / 29 fail = 3% rate, where most of
        // those "fails" were Mistral rejections of unrelated candidate PDFs).
        // Track these separately so operators retain visibility without
        // poisoning the auto-disable signal.
        if (result.rejectedContent) {
          trackSourceMistralReject(dlDomain).catch(() => {});
          // FIX-DELIVERY: local title_mismatch / Mistral NO both mean this
          // domain's remaining candidates for THIS query are likely wrong
          // books (especially Hindawi numeric IDs). After 2 content rejects
          // from the same host, burn the rest of its cap immediately so we
          // spend attempts on other domains.
          const crej = (contentRejectsByDomain.get(dlDomain) ?? 0) + 1;
          contentRejectsByDomain.set(dlDomain, crej);
          if (crej >= 2 && MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN > 0) {
            attemptsByDomain.set(dlDomain, MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN);
            L.info("bot", "early domain abandon after content rejects", {
              book: bookName.slice(0, 50),
              domain: dlDomain,
              contentRejects: crej,
            });
            redis.incr("tel:dl:early_domain_abandon").catch(() => {});
          }
        } else {
          trackSourceAttempt(dlDomain, false).catch(() => {});
        }
        // 2026-05-08: trace.phase parity with download_done. Without this
        // the `links_only` outcome traces only show `download_started`
        // for every attempt and no terminal phase — operators have to
        // infer reasons from logger output. Categorize so funnel views
        // can split timeout vs HTTP vs Mistral vs heuristic rejects.
        if (result.tooLarge) tooLargeHits++;
        const failReason = result.tooLarge
          ? "too_large"
          : result.rejectedContent
            ? (result.mistralRejected ? "mistral_no" : "heuristic_reject")
            : (result.permanent ? "permanent_error" : "transient_error");
        trace.phase("download_failed", {
          url: pdfUrl.slice(0, 80),
          domain: dlDomain,
          reason: failReason,
          ms: Date.now() - t0,
        });
        redis.incr(`tel:dl:fail_reason:${failReason}`).catch(() => {});
      }
      // Track only Mistral-driven rejections; HTTP failures, timeouts, or
      // heuristic-only rejects don't count toward the streak (they're not
      // signals about Mistral disagreeing with the search ranker).
      if (result.mistralRejected) {
        globalMistralNoStreak++;
        mistralNoStreakByDomain.set(dlDomain, domainStreak + 1);
      } else if (result.ok) {
        globalMistralNoStreak = 0;
        mistralNoStreakByDomain.clear();
      }
      if (result.ok) {
        sent          = true;
        sentFileId    = result.fileId;
        sentSizeMB    = result.sizeMB;
        sentSourceUrl = pdfUrl;
        sentDomain    = dlDomain; // already sanitized for stat key consistency
        sentSendMode = result.sendMode ?? "local";

        // FIX-WRONG-FILE: تحقق من صلة الملف المُرسَل بالكتاب المطلوب
        // إذا اسم الملف له صلة منخفضة جداً (< 0.05) → لا نُضيفه للكاش
        // لأنه على الأرجح ملف خاطئ — نحمي المستخدمين القادمين من نفس الخطأ
        sentFilenameScore = urlFilenameRelevance(bookName, pdfUrl);
        const isSuspectFile = sentFilenameScore < 0.05;
        if (isSuspectFile) {
          L.warn("bot", `Sent file with low filename relevance — NOT caching`, {
            book: bookName.slice(0, 50), url: pdfUrl.slice(0, 80), score: sentFilenameScore.toFixed(2),
          });
        }

        trace.phase("download_done", {
          mode:     sentSendMode,
          domain:   sentDomain,
          size:     result.sizeMB ?? "?",
          ms:       Date.now() - t0,
          filenameScore: sentFilenameScore,
        });
        // لا نُضيف للكاش إذا كان الملف مشبوهاً.
        // PR #33: نرفض كذلك الـ cache write للروابط بأسماء ملفات معتمة
        // (digit-only — مثل Hindawi /books/<id>.pdf). لو الـ validator
        // قبلهم بسبب bypass، نضمن أن الـ entry ما تتخزن لأن الـ cache
        // hit بيرسل الـ telegramFileId مباشرة بدون أيّ re-validation —
        // فلو كان غلط، يتسبب في "wrong-file delivered to many users"
        // (10 entries مسممة شُوهدت في production 2026-05-03).
        // FIX-SPEED: cache file_id even for opaque Telegram/Hindawi URLs once
        // pdfValidator has accepted the content for THIS book query. Skipping
        // them forced multi-minute re-uploads on every request for bestsellers.
        // Wrong-book risk is mitigated by: validation gate + isSuspectFile.
        const opaqueUrl = hasUninformativeFilename(pdfUrl);
        if (sentFileId && !isSuspectFile) {
          storage.cacheBook({
            bookQuery: bookName, bookQueryNormalized: normalizeForCache(bookName),
            telegramFileId: sentFileId, fileName: `${bookName}.pdf`, bookName, sourceUrl: pdfUrl,
          }).catch(() => {});
          if (opaqueUrl) {
            redis.incr("tel:cache:opaque_url_cached").catch(() => {});
          }
          // Instant re-send map for telegram channel messages
          try {
            const parsed = parseTelegramUrl(pdfUrl);
            if (parsed && sentFileId) {
              const fk = `tg:fid:${parsed.channelRef}:${parsed.msgId}`;
              redis.setex(fk, 30 * 86400, sentFileId).catch(() => {});
            }
          } catch { /* optional */ }
        } else if (sentFileId && isSuspectFile) {
          redis.incr("tel:cache:suspect_skipped").catch(() => {});
        }
        Promise.all([
          storage.incrementDailyDownload(userId),
          storage.incrementUserDownloads(userId),
        ]).catch(() => {});
        logSearch(userId, userName, bookName, true, true, results.length);
        setLastBook(userId, bookName).catch(() => {});
        warmRelatedCache(bookName).catch(() => {});
        trackDownload(userId, bookName, true, false, sentDomain, Date.now() - t0).catch(() => {});
        // Clear any stale failure record so the retry worker doesn't
        // re-deliver the same book later with a "وجدتُ الكتاب الآن"
        // apology (the user has already received it).
        removeFailure(failureKey(userId, chatId, bookName)).catch(() => {});
        break;
      }
    }
  } finally {
    clearInterval(chatActionInterval);
  }

  if (sent) {
    await editMsg(token, chatId, msgId, buildProgress(6, bookName));
    armProgressWatchdog(token, chatId, msgId, 6, bookName);
    await sleep(600);
  }
  await deleteMsg(token, chatId, msgId);

  if (sent) {
    // BUG-R4 FIX: sentFilenameScore مُحسَب بالفعل في الحلقة أعلاه — لا نُعيد الحساب
    const isSuspectFile = sentFilenameScore < 0.05;

    await sendSuccessMessage(bot, chatId, userId, dlCount + 1, dailyLimit, bookName, sentSourceUrl, sentSizeMB, false, isSuspectFile, isPrem);
    recordDelivery(Date.now() - t0, "ok_send").catch(() => {});
    clearProgressWatchdog(msgId);
    if (userMessageId) reactRandom(bot, chatId, userMessageId, REACTION_SUCCESS).catch(() => {});
    // Telemetry + Funnel
    const dlOutcome: import("./telemetry.js").RequestOutcome =
      sentSendMode === "direct" ? "sent_direct" : "sent_local";
    await trace.finish(dlOutcome).catch(() => {});
    trackFunnelOnce(jobId, {
      searchFound:   true,
      verifyChecked: verifyStats.checked,
      verifyValid:   verifyStats.valid,
      sendMode:      sentSendMode,
      sendSuccess:   true,
    });
  } else {
    clearProgressWatchdog(msgId);
    if (userMessageId) reactRandom(bot, chatId, userMessageId, REACTION_NO_RESULT).catch(() => {});
    logSearch(userId, userName, bookName, results.length > 0, false, results.length);
    trackDownload(userId, bookName, false, false, undefined, Date.now() - t0).catch(() => {});
    await trace.finish(results.length > 0 ? "links_only" : "no_results").catch(() => {});
    trackFunnelOnce(jobId, {
      searchFound:   results.length > 0,
      verifyChecked: verifyStats?.checked ?? 0,
      verifyValid:   verifyStats?.valid   ?? 0,
      sendMode:      null,
      sendSuccess:   false,
    });
    // Telemetry: "found something but couldn't deliver". This is the
    // metric the 2026-05-03 audit flagged at 44%; tracking it lets
    // operators measure the impact of the download-cap mitigations.
    if (results.length > 0) {
      redis.incr("tel:dl:found_no_send").catch(() => {});
      recordDelivery(Date.now() - t0, "fail_found_no_send").catch(() => {});
      L.warn("bot", "found_no_send — search returned results but no PDF was delivered", {
        book: bookName.slice(0, 50),
        results: results.length,
        candidates: validUrls.length,
        attempted: attemptedDownloads,
        domainCapHits,
        globalCapReached,
        tooLargeHits,
      });
    }
    // FIX-PAID-FALSE-POSITIVE: قبل ده كنا نبعت buildPaidBookMessage *دايماً*
    // لما الـ download يفشل، حتى لو paidSignalCount = 0. ده كان غلط لأن
    // فشل التحميل ممكن يكون لأسباب كتيرة (URL محجوب، PDF تالف، Firecrawl
    // لقى الكتاب لكن ما قدرناش نـ verify المحتوى)، مش بس عشان الكتاب مدفوع.
    //
    // الـ engine دلوقتي (بعد تشديد الـ PROTECTED_ACCESS_PATTERNS) بيتطلب
    // 2 إشارات مستقلة ليعلّم نتيجة protected_page. فلو اثنين أو أكتر
    // من النتائج اتعلّموا protected_page دلوقتي (إشارة عالية الثقة)
    // فرسالة "مدفوع" فعلاً صح. أقل من كده رسالة "لم أجد PDF" الأمينة.
    const paidThreshold       = Math.max(2, Math.ceil(results.length * 0.4));
    const showPaidBookMessage = paidSignalCount >= paidThreshold;

    if (showPaidBookMessage) {
      redis.incr("tel:dl:fail_paid_signal").catch(() => {});
      L.info("bot", "Sending paid-book message — high-confidence paid signals", {
        book: bookName.slice(0, 50),
        paidSignalCount,
        results: results.length,
        threshold: paidThreshold,
      });
    } else {
      redis.incr("tel:dl:fail_no_signal").catch(() => {});
      L.info("bot", "Sending no-results message — download failed without paid signals", {
        book: bookName.slice(0, 50),
        paidSignalCount,
        results: results.length,
        threshold: paidThreshold,
      });
    }

    // 2026-05-08: when search produced verified URL candidates but every
    // download attempt failed, surface the top URLs to the user via
    // `buildLinksOnly` instead of the silent no-results message. The
    // user gets actionable fallback links they can try manually rather
    // than a dead-end "لم أجد" reply.
    //
    // Only used when paid-signal is below threshold — for genuine paid
    // books the buy-page link would mislead the user into thinking the
    // PDF is one click away.
    const hasFallbackLinks = !showPaidBookMessage && validUrls.length > 0;
    // When every attempted candidate was over Telegram's bot upload limit,
    // don't pretend "not found" — tell the user the book exists but is too large.
    const allTooLarge = tooLargeHits > 0 && tooLargeHits >= attemptedDownloads && attemptedDownloads > 0;
    if (allTooLarge) {
      redis.incr("tel:dl:fail_all_too_large").catch(() => {});
    } else if (hasFallbackLinks) {
      redis.incr("tel:dl:links_only_message_sent").catch(() => {});
    }
    const failMsg = showPaidBookMessage
      ? buildPaidBookMessage(bookName, /* apologetic */ true)
      : allTooLarge
        ? buildTooLargeMsg(
            bookName,
            validUrls.filter((u) => /^https?:\/\/t\.me\//i.test(u)).slice(0, 3),
          )
      : hasFallbackLinks
        ? buildLinksOnly(bookName, validUrls) + "\n\n_" + buildFoundNoSendHint({ domainCapHits, tooLargeHits, attempted: attemptedDownloads }) + "_"
        : buildNoResults(bookName, false, /* apologetic */ true);

    // Skip auto-retry if we have a *strong* paid-signal — those books
    // are deliberately not free, so retrying won't change the outcome
    // and would just spam the user. For the no-signal failure path
    // (search/download flake), record so the worker can recover later.
    // Size failures are permanent for bot delivery — don't enqueue
    // auto-retry spam for the same oversized PDFs.
    if (!showPaidBookMessage && !allTooLarge && userMessageId) {
      recordFailure({
        userId:        userId,
        chatId:        chatId,
        userMessageId: userMessageId,
        userName:      userName ?? null,
        bookName:      bookName,
        reason:        "all_attempts_failed",
      }).catch(() => {});
    }

    await bot.sendMessage(chatId, failMsg, {
      parse_mode:               "Markdown",
      disable_web_page_preview: true,
      reply_markup:             kbNoResults(bookName),
      // See no_results path above for rationale.
      ...(userMessageId
        ? { reply_to_message_id: userMessageId, allow_sending_without_reply: true }
        : {}),
    });
  }
  return { sent, sourceUrl: sent ? sentSourceUrl : undefined };
}

// ── Helpers ───────────────────────────────────


function buildFoundNoSendHint(opts: {
  domainCapHits: number;
  tooLargeHits: number;
  attempted: number;
}): string {
  const bits: string[] = [];
  if (opts.tooLargeHits > 0) {
    bits.push("بعض الملفات أكبر من حد تيليجرام للبوت (50MB)");
  }
  if (opts.domainCapHits > 0) {
    bits.push("نتائج كثيرة من مصدر واحد كانت غير مطابقة للعنوان");
  }
  if (opts.attempted > 0) {
    bits.push(`جرّبتُ ${opts.attempted} رابطاً موثوقاً`);
  }
  if (bits.length === 0) {
    return "وجدتُ نتائج بحث لكن لم يمرّ أي PDF من فحوصات الجودة.";
  }
  return bits.join(" · ") + ".";
}

async function sendSuccessMessage(
  bot: TelegramBot, chatId: number, userId: string, dlCount: number, limit: number,
  bookName: string, sourceUrl: string, sizeMB?: string, fromCache = false,
  _isSuspect = false, isPrem = false
): Promise<void> {
  // ── Streak update — atomic via Lua ──
  let streak: StreakUpdate = await updateStreakOnDownload(userId);

  // ── Streak shield: if a long streak just broke, try weekly shield ──
  if (streak.brokenStreak >= 3) {
    const saved = await tryUseStreakShield(userId, streak.brokenStreak).catch(() => false);
    if (saved) {
      try {
        const today = (await import("./text.js")).cairoDateString();
        await redis.set(`streak:cur:${userId}`, String(streak.brokenStreak));
        await redis.set(`streak:last:${userId}`, today);
        streak = {
          ...streak,
          current: streak.brokenStreak,
          brokenStreak: 0,
          transitioned: true,
        };
        bot.sendMessage(
          chatId,
          `🛡️ *درع السلسلة أنقذك!*
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
_حافظنا على سلسلتك (${streak.current} يوم) — الدرع يُستخدم مرة كل أسبوع._`,
          { parse_mode: "Markdown" },
        ).catch(() => {});
      } catch { /* shield restore best-effort */ }
    }
  }

  const streakLine = formatStreakLine(streak) ?? undefined;

  const related = await getRelatedBooks(bookName, userId, 2).catch(() => [] as string[]);
  const tip = pickReadingTip(bookName + userId);
  recordInterest(userId, bookName).catch(() => {});

  let msg = buildSuccessMsg(bookName, dlCount, limit, sizeMB, fromCache, isPrem, streakLine);
  if (related.length > 0) {
    msg += `\n\n✨ *قد يعجبك أيضاً — اضغط الزر بالأسفل*`;
  }
  // نصيحة قراءة قصيرة (بدون تنسيق معقّد)
  const tipPlain = tip.replace(/[_*`\[]/g, "").slice(0, 120);
  if (tipPlain) msg += `\n\n💬 _${tipPlain}_`;

  await bot.sendMessage(
    chatId, msg,
    {
      parse_mode: "Markdown",
      reply_markup: kbAfterSuccess(bookName, sourceUrl, { isPrem, fromCache, related }),
      disable_web_page_preview: true,
    },
  );

  // ── Retention: quests / XP / comeback (non-blocking) ──
  onSuccessfulDownload(userId, {
    fromCache,
    streakTransitioned: streak.transitioned,
  }).then(async (ret) => {
    for (const m of ret.messages) {
      await bot.sendMessage(chatId, m, { parse_mode: "Markdown" }).catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
    }
    // extra badges: comeback / level / quest streak
    const { getXpState } = await import("./retention.js");
    const xp = await getXpState(userId);
    if (xp.level >= 5) {
      const b = await tryAwardBadge(userId, "level5");
      if (b) {
        const text = await buildNewBadgeMessage(userId, b);
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() => {});
      }
    }
    const qs = parseInt((await redis.get(`ret:qstreak:${userId}`).catch(() => "0")) || "0", 10) || 0;
    if (qs >= 7) {
      const b = await tryAwardBadge(userId, "quest7");
      if (b) {
        const text = await buildNewBadgeMessage(userId, b);
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() => {});
      }
    }
  }).catch((e) => {
    L.warn("retention", "onSuccessfulDownload failed", { userId, err: String(e).slice(0, 100) });
  });

  // ── Engagement signals — fire-and-forget ──
  dispatchEngagementSignals(bot, chatId, userId, streak).catch((e) => {
    L.warn("engagement", "dispatchEngagementSignals failed", { userId, err: String(e).slice(0, 100) });
  });
}

/**
 * يُرسل رسائل الـ milestone، badges الجديدة، الـ referral activation
 * بعد رسالة النجاح. كل رسالة لها فاصل صغير عشان ما يتم rate-limit.
 *
 * الترتيب:
 *   1. broken streak (لو > 0) — قبل أي تهنئة، عشان نخفف الصدمة
 *   2. milestone — لو وصل
 *   3. badges جديدة — لكل واحدة رسالة منفصلة
 *   4. referral activation — لو ده أول تحميل لمدعو
 */
async function dispatchEngagementSignals(
  bot:    TelegramBot,
  chatId: number,
  userId: string,
  streak: StreakUpdate,
): Promise<void> {
  const sendDelayed = async (text: string, delayMs: number) => {
    if (delayMs > 0) await sleep(delayMs);
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() => {});
  };

  if (streak.brokenStreak > 0) {
    await sendDelayed(buildBrokenStreakMessage(streak.brokenStreak), 800);
  }
  if (streak.milestoneReached !== null) {
    await sendDelayed(buildMilestoneMessage(streak.milestoneReached), 1000);
  }

  // Badge check — يستخدم الـ totalDownloads المُحدَّث + الـ streak الجديد
  const newBadges = await checkAndAwardBadges(userId, streak.current).catch(() => []);
  for (const badge of newBadges) {
    const text = await buildNewBadgeMessage(userId, badge);
    await sendDelayed(text, 1200);
  }

  // Referral activation — لو ده أول تحميل لمدعو، نُفعِّل الإحالة
  // ونُرسل welcome gift للمدعو + إشعار للمحيل (في chat منفصل).
  try {
    const activation = await activateReferralOnFirstDownload(userId);
    if (activation.welcomeGift || activation.notifyReferrer) {
      await sleep(1500);
      await sendReferralNotifications(bot, activation, userId, chatId);
    }
  } catch (e) {
    L.warn("engagement", "referral activation failed", { userId, err: String(e).slice(0, 100) });
  }
}

/**
 * PR G — auto-summary trigger.
 *
 * Called after a successful download when the user's original
 * request had summary intent (e.g. "لخصلي أرض زيكولا"). Acquires
 * a per-(userId, book) inflight lock so a manual button click
 * during the same window is silently dropped, then runs the summary
 * orchestrator inline (fire-and-forget — failures are logged inside
 * runSummaryFlow, never propagated to the caller).
 *
 * The lock key intentionally diverges from the button-click lock
 * (which keys on sessionKey) by using the canonical book name
 * instead, so the auto-trigger and a fresh button-click for the
 * *same* book dedupe each other.
 */
async function maybeAutoSummary(
  bot:        TelegramBot,
  chatId:     number,
  userId:     string,
  bookName:   string,
  sourceUrl:  string | undefined,
  wantsSummary: boolean,
): Promise<void> {
  if (!wantsSummary) return;
  try {
    // BUG #18 — unified key with summaryHandler.inflightKey. Both auto
    // and manual paths now reduce to `summary:lock:{userId}:{canonical}`
    // so they dedupe each other. If the user typed "لخصلي X" and ALSO
    // tapped the button, only the first call runs AI; the second sees
    // the lock and bails (silently for auto, with a friendly toast for
    // manual). Lock is released by `runSummaryFlow`'s finally block.
    const lockKey = `summary:lock:${userId}:${canonicalizeForCache(bookName)}`;
    const locked  = await redis.set(lockKey, "1", "EX", 90, "NX").catch(() => null);
    if (!locked) {
      L.info("bookRequest", "auto-summary already in flight — skipping", {
        userId, book: bookName.slice(0, 50),
      });
      return;
    }
    redis.incr("tel:summary:auto_triggered").catch(() => {});
    L.info("bookRequest", "auto-summary triggered", {
      userId, book: bookName.slice(0, 50),
    });
    // Lazy import to avoid circular dependency (summaryHandler →
    // session → … → bookRequest).
    const { runSummaryFlow } = await import("./summaryHandler.js");
    await runSummaryFlow(bot, chatId, userId, bookName, sourceUrl, {
      lockKey,
    });
  } catch (e) {
    L.warn("bookRequest", "auto-summary trigger failed", {
      userId, book: bookName.slice(0, 50), err: String(e).slice(0, 120),
    });
  }
}

async function sendAnnouncement(bot: TelegramBot, chatId: number, userId: string): Promise<void> {
  try {
    const [announce, note] = await Promise.all([
      redis.get(BOT_ANNOUNCE_KEY),
      getUserNote(userId),
    ]);

    if (announce) {
      // نُرسل الإعلان مرة واحدة فقط لكل مستخدم لكل إعلان
      // المفتاح يشمل hash للمحتوى → لو تغيّر الإعلان يُرسل مجدداً
      const msgHash = Buffer.from(announce).toString("base64").slice(0, 16);
      const seenKey = `announce:seen:${userId}:${msgHash}`;

      // BUG FIX: كان GET + SETEX منفصلَين → طلبان متزامنان لنفس المستخدم
      // قد يقرآن alreadySeen=null معاً → يُرسلان الإعلان مرتين.
      // الحل: SET NX EX atomic — ينجح واحد فقط من الطلبَين المتنافسَين.
      // سET NX تُعيد "OK" عند النجاح (أول من يصل) و null لمن يأتي بعده.
      const acquired = await redis.set(seenKey, "1", "EX", 30 * 24 * 3600, "NX").catch(() => null);
      if (acquired === "OK") {
        await bot.sendMessage(chatId, `📢 *إعلان:*\n\n${announce}`, { parse_mode: "Markdown" });
      }
    }

    if (note) {
      await bot.sendMessage(chatId, `💬 *ملاحظة:* ${note}`, { parse_mode: "Markdown" });
    }
  } catch {}
}

async function buildNoResultMessage(
  bookName: string,
  apologetic = false,
): Promise<string> {
  const fcDown = await isFirecrawlDown().catch(() => false);
  if (fcDown) {
    const apology = apologetic
      ? `🙏 _عذراً، لم أتمكّن من البحث الآن._

`
      : "";
    return apology + `🔧 *خدمة البحث مؤقتاً غير متاحة*
_جارٍ العمل على إصلاحها — جرّب بعد قليل_ ⏳`;
  }
  const dym = await buildDidYouMeanMessage(bookName, apologetic);
  return dym.text;
}


function logSearch(
  userId: string, userName: string | null | undefined, bookName: string,
  bookFound: boolean, pdfSent: boolean, resultCount: number
): void {
  storage.logSearch({
    telegramUserId: userId, userName: userName ?? null,
    query: bookName, bookFound, pdfSent, resultCount,
  }).catch((e) => L.error("system", `logSearch error`, { err: String(e).slice(0, 100) }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
