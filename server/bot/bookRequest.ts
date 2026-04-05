import TelegramBot from "node-telegram-bot-api";
import { storage } from "../storage.js";
import { L } from "./logger.js";
import { enqueue } from "./queue.js";
import { isBanned, isAdmin, setLastBook } from "./guards.js";
import { isRateLimited, isSearchRateLimited, RATE_LIMIT_MAX, SEARCH_RATE_MAX } from "./rateLimit.js";
import { normalizeForCache, escMd, urlFilenameRelevance } from "./text.js";
import { searchWithFuzzyFallback } from "./fuzzy.js";
import { invalidateRecentSearchesCache } from "./engine.js";
import { warmRelatedCache } from "./suggestions.js";
import { findValidPdfUrls } from "./verify.js";
import { downloadAndSend } from "./download.js";
import { editMsg, deleteMsg, buildProgress, tip, buildSuccessMsg, buildNoResults, buildDailyLimit, buildRateLimitMsg, buildQueueAccepted, buildPendingMsg, buildTurnNotification } from "./ui.js";
import { kbAfterSuccess, kbAfterFail, kbMain, kbNoResults, buildFailMessage } from "./keyboards.js";
import { getUserDailyLimit, getUserNote } from "./userSettings.js";
import { redis } from "./redis.js";
import { MAINTENANCE_KEY, BOT_ANNOUNCE_KEY, PREMIUM_SET_KEY, DAILY_LIMIT, PREMIUM_LIMIT, BANNED_USERS, UNRELIABLE_DOMAINS } from "./config.js";
import { trackSearch, trackDownload, getSourceStats, trackFunnel } from "./analytics.js";
import { RequestTrace, claimFunnelSlot } from "./telemetry.js";
import type { QueueJob } from "./types.js";

// ══════════════════════════════════════════════
// ENTRY POINT — Guards → Enqueue
// ══════════════════════════════════════════════

export async function handleBookRequest(
  bot: TelegramBot,
  chatId: number,
  userId: string,
  bookName: string,
  token: string,
  userName?: string | null
): Promise<void> {
  // ── دمج كل الفحوصات الأولية في استعلامين متوازيين بدل 7+ متسلسلة ──
  let bannedResult: [Error|null, unknown]|undefined;
  let maintenanceResult: [Error|null, unknown]|undefined;
  let premiumResult: [Error|null, unknown]|undefined;
  let limitOverrideResult: [Error|null, unknown]|undefined;
  let pipelineOk = false;

  try {
    const pipelineRes = await redis.pipeline()
      .sismember("bans", userId)
      .get(MAINTENANCE_KEY)
      .sismember(PREMIUM_SET_KEY, userId)
      .get(`ulimit:${userId}`)
      .exec();
    if (pipelineRes) {
      [bannedResult, maintenanceResult, premiumResult, limitOverrideResult] =
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
      await bot.sendMessage(chatId, buildRateLimitMsg(RATE_LIMIT_MAX), { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
    if (searchRateLimited) {
      await bot.sendMessage(chatId, buildRateLimitMsg(SEARCH_RATE_MAX), { parse_mode: "Markdown" }).catch(() => {});
      return;
    }
  }

  // ── Daily limit ───────────────────────────────
  const isPrem     = (premiumResult?.[1] as number) === 1;
  const limitVal   = limitOverrideResult?.[1] as string | null;
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

  // BUG FIX: dailyLimit=0 يعني "غير محدود" (من userSettings) — لا يجب أن يُحجب المستخدم
  // قبل: dlCount(0) >= dailyLimit(0) → true → يُحجب فوراً
  // الحل: فحص dailyLimit > 0 أولاً — 0 = unlimited → تجاوز الفحص كلياً
  if (dailyLimit > 0 && dlCount >= dailyLimit && !isAdmin(userId)) {
    const now      = new Date();
    const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
    const diffMs   = midnight.getTime() - now.getTime();
    const diffH    = Math.floor(diffMs / 3_600_000);
    const diffM    = Math.floor((diffMs % 3_600_000) / 60_000);
    const reset    = diffH > 0 ? `${diffH}س ${diffM}د` : `${diffM} دقيقة`;
    await bot.sendMessage(
      chatId,
      buildDailyLimit(dlCount, dailyLimit, reset),
      { parse_mode: "Markdown", reply_markup: kbMain() }
    );
    return;
  }

  // ── Enqueue ───────────────────────────────────
  const priority = isAdmin(userId) ? "high" : isPrem ? "high" : "normal";
  const result   = await enqueue(userId, chatId, bookName, token, priority, userName);

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
    { parse_mode: "Markdown" }
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

  // دمج getUserDailyLimit + getDailyDownloadCount في Promise.all — توفير serial round-trip
  const [dailyLimit, dlCountRaw] = await Promise.all([
    getUserDailyLimit(userId),
    storage.getDailyDownloadCount(userId).catch(() => 0),
  ]);
  const dlCount = dlCountRaw;

  // BUG FIX: نفس الإصلاح — dailyLimit=0 = unlimited
  if (dailyLimit > 0 && dlCount >= dailyLimit && !isAdmin(userId)) {
    await bot.sendMessage(chatId, `📵 *وصلت للحد اليومي.* (${dailyLimit} كتب)`, { parse_mode: "Markdown" }).catch(() => {});
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
  try {
    const qm = await bot.sendMessage(chatId, buildProgress(0, bookName), { parse_mode: "Markdown" });
    msgId = qm.message_id;
  } catch {}

  storage.getOrCreateUser(userId).catch(() => {});

  try {
    const servedFromCache = await serveFromCache(bot, chatId, userId, bookName, token, userName, dlCount, dailyLimit, t0, trace);
    if (servedFromCache) {
      await deleteMsg(token, chatId, msgId);
      await trace.finish("sent_from_cache");
      // cache hit يُعدّ في الـ funnel كـ send_success بدون verify steps
      trackFunnelOnce(job.id, {
        searchFound:   true,
        verifyChecked: 0,
        verifyValid:   0,
        sendMode:      "direct", // file_id → مثل direct
        sendSuccess:   true,
      });
      await sendAnnouncement(bot, chatId, userId);
      return;
    }
    await performFullSearch(bot, chatId, userId, bookName, token, userName, msgId, dlCount, dailyLimit, t0, trace, job.id);
    await sendAnnouncement(bot, chatId, userId);
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

    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: kbAfterFail(bookName, []) }).catch(() => {});

    trace.finish("error").catch(() => {});
    // FIX BUG-7: كان يُعيد throw بعد إرسال رسالة الخطأ للمستخدم
    // هذا يسبب: Worker يُعيد المحاولة → إما يصل الكتاب بدون سياق، أو رسالة خطأ ثانية
    // الحل: لا نُعيد throw — المستخدم أُخبر بالخطأ، الـ job يُكمَل بشكل طبيعي
    // الـ Worker سيستدعي completeJob ويُنقص الـ pending counter
  }
}

// ── Cache Serve ───────────────────────────────

async function serveFromCache(
  bot: TelegramBot, chatId: number, userId: string, bookName: string,
  token: string, userName: string | null | undefined,
  dlCount: number, dailyLimit: number, t0: number,
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

  if (cached.telegramFileId) {
    try {
      await bot.sendDocument(chatId, cached.telegramFileId, {
        caption: `📚 *${escMd(cached.bookName)}*\n\n⚡ من مكتبة خلاصة الكتب`,
        parse_mode: "Markdown",
      });
      // FIX-3: دمج 3 عمليات increment في Promise.all بدل 3 fire-and-forget منفصلة
      Promise.all([
        storage.incrementCacheServed(cached.id),
        storage.incrementDailyDownload(userId),
        storage.incrementUserDownloads(userId),
      ]).catch(() => {});
      logSearch(userId, userName, bookName, true, true, 1);
      invalidateRecentSearchesCache();
      setLastBook(userId, bookName);
      warmRelatedCache(bookName).catch(() => {});
      trackDownload(userId, bookName, true, true, undefined, Date.now() - t0).catch(() => {});
      await sendSuccessMessage(bot, chatId, dlCount + 1, dailyLimit, bookName, cached.sourceUrl || "", undefined, true);
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
        invalidateRecentSearchesCache();
        setLastBook(userId, bookName);
        warmRelatedCache(bookName).catch(() => {});
        trackDownload(userId, bookName, true, true, cached.sourceUrl?.split("/")[2], Date.now() - t0).catch(() => {});
        await sendSuccessMessage(bot, chatId, dlCount + 1, dailyLimit, bookName, cached.sourceUrl, qr.sizeMB, true);
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
  msgId: number, dlCount: number, dailyLimit: number, t0: number,
  trace: RequestTrace,
  jobId: string
): Promise<void> {
  await editMsg(token, chatId, msgId, buildProgress(1, bookName, tip()));

  const { results, usedFuzzy } = await searchWithFuzzyFallback(bookName);
  trace.phase("search_done", {
    results:   results.length,
    usedFuzzy: usedFuzzy || false,
    ms:        Date.now() - t0,
  });

  if (results.length === 0) {
    await deleteMsg(token, chatId, msgId);
    logSearch(userId, userName, bookName, false, false, 0);
    trackDownload(userId, bookName, false, false, undefined, Date.now() - t0).catch(() => {});
    trackFunnelOnce(jobId, { searchFound: false, verifyChecked: 0, verifyValid: 0, sendMode: null, sendSuccess: false });
    await trace.finish("no_results");
    await bot.sendMessage(chatId, await buildNoResultMessage(bookName), {
      parse_mode: "Markdown", reply_markup: kbNoResults(bookName),
    });
    return;
  }

  if (usedFuzzy)
    await editMsg(token, chatId, msgId, buildProgress(2, bookName, "💡 لم أجد تطابقاً تاماً — أجرّب أقرب نتيجة"));

  await editMsg(token, chatId, msgId, buildProgress(3, bookName, `📄 وجدت *${results.length}* نتيجة\n\n${tip()}`));

  const allPdfUrls: string[] = [];
  const pageUrlFallbacks: string[] = [];
  // BUG FIX: استخدام Set لتجنب تكرار نفس URL في كلا القائمتين
  // قبل: نفس URL يمكن أن يُضاف أكثر من مرة إذا أعادته مصادر متعددة
  const seenPdfUrls   = new Set<string>();
  const seenPageUrls  = new Set<string>();
  for (const r of results) {
    if (r.directPdfUrl) {
      if (!seenPdfUrls.has(r.directPdfUrl)) {
        seenPdfUrls.add(r.directPdfUrl);
        allPdfUrls.push(r.directPdfUrl);
      }
    } else if (r.url) {
      if (!seenPageUrls.has(r.url)) {
        seenPageUrls.add(r.url);
        pageUrlFallbacks.push(r.url);
      }
    }
  }
  // findValidPdfUrls تفلتر الـ blacklist داخلياً — لا داعي لفحص مسبق
  const uniquePdfs = [...allPdfUrls]; // already deduped via seenPdfUrls

  await editMsg(token, chatId, msgId, buildProgress(4, bookName, tip()));

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
  } else if (validUrls.length === 0 && uniquePdfs.length === 0 && pageUrlFallbacks.length > 0) {
    // Fallback 3: صفحات HTML — download.ts سيحاول استخراج PDF منها
    L.info("bot", `No direct PDF URLs — trying ${Math.min(3, pageUrlFallbacks.length)} page URLs as last resort`, {
      book: bookName.slice(0, 50),
    });
    validUrls = [...new Set(pageUrlFallbacks)].slice(0, 3);
  }

  // ── ترتيب URLs الذكي — 3 معايير مدمجة ──────────────────────────────
  // FIX-WRONG-FILE: الترتيب القديم كان يعتمد فقط على أداء المصدر التاريخي
  // هذا يسبب إرسال ملفات خاطئة (مثل TT-79.pdf) حتى لو المصدر "موثوق"
  // الحل: دمج 3 معايير:
  //   (1) صلة اسم الملف بالكتاب المطلوب (الأهم — يمنع إرسال ملف خاطئ)
  //   (2) أداء المصدر التاريخي من analytics
  //   (3) عقوبة المواقع غير الموثوقة (مثل noor-book.com)
  if (validUrls.length > 1) {
    let srcRateMap = new Map<string, number>();
    try {
      const srcStats = await getSourceStats();
      srcRateMap = new Map(srcStats.map((s) => [s.domain, s.ok / Math.max(s.ok + s.fail, 1)]));
    } catch {}

    validUrls.sort((a, b) => {
      const scoreUrl = (url: string): number => {
        const domain = url.split("/")[2] || "";
        // (1) صلة اسم الملف — 0 لـ 1، وزن 50%
        const filenameScore = urlFilenameRelevance(bookName, url);
        // (2) أداء المصدر التاريخي — 0 لـ 1، وزن 30%
        const sourceRate = srcRateMap.get(domain) ?? 0.5;
        // (3) عقوبة المواقع غير الموثوقة — وزن 20%
        const reliablePenalty = UNRELIABLE_DOMAINS.some(d => domain.includes(d)) ? 0 : 1;
        return filenameScore * 0.5 + sourceRate * 0.3 + reliablePenalty * 0.2;
      };
      return scoreUrl(b) - scoreUrl(a);
    });

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

  await editMsg(token, chatId, msgId, buildProgress(5, bookName, tip()));

  const chatActionInterval = setInterval(() => {
    bot.sendChatAction(chatId, "upload_document").catch(() => {});
  }, 4000);
  bot.sendChatAction(chatId, "upload_document").catch(() => {});

  let sent = false, sentFileId: string | undefined, sentSizeMB: string | undefined;
  let sentSourceUrl = "", sentDomain = "", sentSendMode: "direct" | "local" = "local";
  // BUG-R4 FIX: isSuspectFile يُحسَب مرة واحدة خارج الحلقة ويُعاد استخدامه
  // قبل: يُحسَب مرتين (داخل الحلقة + بعدها) — نتيجتان قد تختلفان لو تغيّر المنطق
  let sentFilenameScore = 0.5; // neutral حتى يُضبط بعد التحميل الناجح

  try {
    for (const pdfUrl of validUrls) {
      const dlDomain = pdfUrl.split("/")[2] || "";
      trace.phase("download_started", { url: pdfUrl.slice(0, 80), domain: dlDomain });
      let result = await downloadAndSend(bot, chatId, pdfUrl, bookName, token);
      // BUG FIX: كان يُعيد المحاولة حتى عند rejectedContent=true
      // عندما يُرفض الـ PDF بسبب عدم تطابق المحتوى، إعادة التحميل ستُعطي نفس الـ bytes
      // → نفس النتيجة → هدر 90 ثانية + استهلاك bandwidth بلا فائدة
      // الحل: تجاوز الـ retry إذا كان الرفض بسبب المحتوى أو إذا كان permanent
      if (!result.ok && !result.permanent && !result.rejectedContent) {
        await sleep(500); // M4 FIX: 500ms كافٍ للـ back-off — 2000ms كانت تعطّل الـ worker
        result = await downloadAndSend(bot, chatId, pdfUrl, bookName, token);
      }
      if (result.ok) {
        sent          = true;
        sentFileId    = result.fileId;
        sentSizeMB    = result.sizeMB;
        sentSourceUrl = pdfUrl;
        sentDomain    = pdfUrl.split("/")[2] || "";
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
        // لا نُضيف للكاش إذا كان الملف مشبوهاً
        if (sentFileId && !isSuspectFile) {
          storage.cacheBook({
            bookQuery: bookName, bookQueryNormalized: normalizeForCache(bookName),
            telegramFileId: sentFileId, fileName: `${bookName}.pdf`, bookName, sourceUrl: pdfUrl,
          }).catch(() => {});
        }
        Promise.all([
          storage.incrementDailyDownload(userId),
          storage.incrementUserDownloads(userId),
        ]).catch(() => {});
        logSearch(userId, userName, bookName, true, true, results.length);
        invalidateRecentSearchesCache();
        setLastBook(userId, bookName);
        warmRelatedCache(bookName).catch(() => {});
        trackDownload(userId, bookName, true, false, sentDomain, Date.now() - t0).catch(() => {});
        break;
      }
    }
  } finally {
    clearInterval(chatActionInterval);
  }

  if (sent) {
    await editMsg(token, chatId, msgId, buildProgress(6, bookName));
    await sleep(600);
  }
  await deleteMsg(token, chatId, msgId);

  if (sent) {
    // BUG-R4 FIX: sentFilenameScore مُحسَب بالفعل في الحلقة أعلاه — لا نُعيد الحساب
    const isSuspectFile = sentFilenameScore < 0.05;

    await sendSuccessMessage(bot, chatId, dlCount + 1, dailyLimit, bookName, sentSourceUrl, sentSizeMB, false, isSuspectFile);
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
    await bot.sendMessage(chatId, buildFailMessage(bookName, results, 0), {
      parse_mode: "Markdown", disable_web_page_preview: true,
      reply_markup: kbAfterFail(bookName, results, 0),
    });
  }
}

// ── Helpers ───────────────────────────────────

async function sendSuccessMessage(
  bot: TelegramBot, chatId: number, dlCount: number, limit: number,
  bookName: string, sourceUrl: string, sizeMB?: string, fromCache = false, isSuspect = false
): Promise<void> {
  let msg = buildSuccessMsg(bookName, dlCount, limit, sizeMB, fromCache);
  // FIX-WRONG-FILE: إذا الملف مشبوه → أضف تحذيراً واضحاً للمستخدم
  if (isSuspect) {
    msg += `\n\n⚠️ _تحذير: اسم الملف لا يطابق اسم الكتاب — قد يكون الملف خاطئاً._\n_استخدم زر "ملف خاطئ؟" إذا لاحظت مشكلة._`;
  }
  await bot.sendMessage(
    chatId, msg,
    { parse_mode: "Markdown", reply_markup: kbAfterSuccess(bookName, sourceUrl) }
  );
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

async function buildNoResultMessage(bookName: string): Promise<string> {
  // FIX-6: كانت تُجري 2 network requests بـ timeout 3 ثوانٍ قبل كل رسالة "لا نتائج"
  // هذا يُضيف تأخيراً حتى 3 ثوانٍ لكل مستخدم لا يجد كتابه — والغالبية ليست شبكتهم مشكلة
  // الحل: نعرض رسالة "لا نتائج" فوراً — المستخدم يعرف إذا كانت شبكته مشكلة
  return buildNoResults(bookName, false);
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
