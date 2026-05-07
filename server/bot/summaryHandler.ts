// ══════════════════════════════════════════════════════════
// Summary callback handler — `sum:<sessionKey>`
// ══════════════════════════════════════════════════════════
// Fired when the user taps "📘 ملخص الكتاب" under a delivered book.
// Resolves the session key → (bookName, sourceUrl), enforces the
// per-user free-tier quota, runs the summary orchestrator, and
// renders a Telegram message with proper Arabic + spoiler framing.

import TelegramBot from "node-telegram-bot-api";
import { L } from "./logger.js";
import { redis } from "./redis.js";
import { getSession } from "./session.js";
import { isPremium } from "./userSettings.js";
import { escMd, canonicalizeForCache } from "./text.js";
import {
  getBookSummary,
  getCachedSummary,
  checkAndConsumeUsage,
  refundUserSummaryUsage,
  GlobalSummaryLimitError,
} from "./summary.js";
import type { SummaryResponse } from "./aiProviders/types.js";
import { SUMMARY_DAILY_LIMIT_FREE } from "./config.js";
import { trackSummaryAndAward, buildNewBadgeMessage } from "./badges.js";

// Per-user dedup window in seconds — the same user spamming the
// summary button should hit cache; this prevents re-running the
// orchestrator concurrently for the same key (which would spend
// quota twice).
const INFLIGHT_TTL = 90;

// BUG #18 — unified inflight key for both auto-trigger and manual button
// click. Pre-fix, the manual handler used `summary:inflight:userId:sessionKey`
// while bookRequest's auto-trigger used `summary:auto:userId:canonicalBook`.
// If the user typed "لخصلي X" *and* tapped the "📘 ملخص الكتاب" button
// before the auto-trigger finished, both paths grabbed different keys,
// passed their NX checks, and ran AI twice — wasting quota and risking
// global cap exhaustion. Now both paths compute the same key from
// (userId, canonicalizedBookName), so they dedupe each other.
//
// Why canonicalize the book name:
//   - The bookName surfacing in the auto path comes from `parseBookName`
//     which strips noise but preserves casing/whitespace differences.
//   - The session-key path goes through `canonicalizeForCache` to share
//     storage with the cache layer.
//   - Canonicalizing here guarantees both paths reduce to the same string.
function inflightKey(userId: string, bookName: string): string {
  return `summary:lock:${userId}:${canonicalizeForCache(bookName)}`;
}

function pickHeader(resp: SummaryResponse): string {
  if (resp.bookType === "novel") {
    if (resp.spoilerLevel === "critical")
      return "📖 *ملخص الرواية* — _بدون أي حرق_";
    return "📖 *ملخص الرواية*";
  }
  if (resp.bookType === "poetry")     return "📝 *مقدمة عن الديوان*";
  if (resp.bookType === "religion")   return "🕌 *عرض الكتاب*";
  if (resp.bookType === "textbook")   return "📚 *عرض الكتاب الدراسي*";
  if (resp.bookType === "non-fiction") return "📘 *ملخص الكتاب*";
  return "📘 *ملخص الكتاب*";
}

function renderProvenance(resp: SummaryResponse): string {
  if (resp.providerName === "wikipedia-fallback") return "_المصدر: ويكيبيديا_";
  if (resp.source === "pdf")                      return "_تحليل مباشر للملف_";
  return "_من السياق العام للكتاب_";
}

export async function handleSummaryCallback(
  bot:           TelegramBot,
  chatId:        number,
  userId:        string,
  data:          string,
  callbackQueryId: string,
): Promise<void> {
  // data shape: "sum:<sessionKey>"
  const sessionKey = data.slice(4).trim();
  const entry      = await getSession(sessionKey);
  if (!entry?.bookName) {
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "⏰ انتهت صلاحية هذا الزر. اكتب اسم الكتاب من جديد.",
      show_alert: true,
    }).catch(() => {});
    return;
  }

  // In-flight guard: if the user double-tapped, OR the auto-summary
  // path is already running for the same book (PR G), the second call
  // sees the lock and we just acknowledge without re-running. This
  // prevents duplicate AI calls (and double quota consumption). The
  // lock is keyed on (userId, canonicalBook) so different users — or
  // the same user requesting a different delivered book — are
  // unaffected, and the auto-trigger and manual button click DO
  // dedupe each other (Bug #18).
  const lockKey = inflightKey(userId, entry.bookName);
  const locked  = await redis.set(lockKey, "1", "EX", INFLIGHT_TTL, "NX").catch(() => null);
  if (!locked) {
    L.info("summaryHandler", "double-tap blocked", { userId, sessionKey });
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "⏳ الملخص جاري تجهيزه...",
    }).catch(() => {});
    return;
  }

  await runSummaryFlow(bot, chatId, userId, entry.bookName, entry.url, {
    callbackQueryId,
    lockKey,
  });
}

/**
 * Core summary flow — extracted from `handleSummaryCallback` so
 * `bookRequest.ts` can auto-trigger a summary right after a book is
 * delivered when the user's original message had summary intent
 * (e.g. "لخصلي أرض زيكولا"). PR G — auto-summary trigger.
 *
 * The auto-trigger path passes its own per-(userId,bookName) lock key
 * to dedupe with the manual button click; if the user clicks the
 * "📘 ملخص الكتاب" button while the auto-trigger is still running,
 * the second call sees the lock and is silently dropped.
 */
export async function runSummaryFlow(
  bot:        TelegramBot,
  chatId:     number,
  userId:     string,
  bookName:   string,
  sourceUrl:  string | undefined,
  opts: {
    callbackQueryId?: string;
    /** Lock key already acquired by the caller. We release it on exit. */
    lockKey?: string;
  } = {},
): Promise<void> {
  const lockKey = opts.lockKey;
  const callbackQueryId = opts.callbackQueryId;

  // Tracking state across try/catch/finally — the watchdog & placeholder
  // need to be visible to the error path so we can edit-in-place rather
  // than leave the user staring at a stale "loading" message.
  let placeholderMsgId: number | undefined;
  let watchdogTimer:    NodeJS.Timeout | undefined;
  let typingInterval:   NodeJS.Timeout | undefined;
  // Hoisted so the catch block can refund the per-user quota slot if
  // we charged it in checkAndConsumeUsage but the upstream call
  // failed before producing a SummaryResponse.
  let premium       = false;
  let usageConsumed = false;

  try {
    // Cache fast-path — skip the quota check entirely for cached
    // hits (no upstream cost, treat as free).
    const cached = await getCachedSummary(bookName);
    if (cached) {
      if (callbackQueryId) await bot.answerCallbackQuery(callbackQueryId).catch(() => {});
      await deliverSummary(bot, chatId, bookName, cached);
      return;
    }

    premium = await isPremium(userId).catch(() => false);

    // Quota check — only consumes when we'll actually call AI.
    const usage = await checkAndConsumeUsage(userId, premium);
    if (!usage.blocked) usageConsumed = true;
    if (usage.blocked) {
      if (callbackQueryId) await bot.answerCallbackQuery(callbackQueryId).catch(() => {});
      await bot.sendMessage(chatId,
        `⚠️ *وصلت إلى حد الملخصات اليومي* (${SUMMARY_DAILY_LIMIT_FREE} ملخصات/يوم).\n\n` +
        `🌟 ترقّى إلى *Premium* للحصول على:\n` +
        `• ملخصات غير محدودة\n` +
        `• جودة أعلى عبر You.com Smart Search\n` +
        `• استشهادات بالمصادر`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[
            { text: "⭐ ترقية للـ Premium", callback_data: "premium_buy" },
          ]]},
        },
      ).catch(() => {});
      return;
    }

    // Acknowledge the click immediately; the orchestrator may take
    // 5–30s and Telegram complains if we don't ack within ~3s.
    // (Only if we came from a button click — auto-trigger has no
    // callback to acknowledge.)
    if (callbackQueryId) {
      await bot.answerCallbackQuery(callbackQueryId, {
        text: "⏳ جاري تجهيز الملخص...",
      }).catch(() => {});
    }

    // Send a *visible, persistent* placeholder so the user sees the bot is
    // working. PDF-tier summaries can take 25–30s; the toast disappears
    // in ~5s and Telegram's typing action only lasts ~5s as well.
    const placeholderText =
      `⏳ *جاري تجهيز الملخص...*\n` +
      `📚 *${escMd(bookName)}*\n\n` +
      `_البوت يقرأ الكتاب ويجهّز لك ملخصًا مفصّلًا. قد يستغرق حتّى دقيقة._`;
    try {
      const sent = await bot.sendMessage(chatId, placeholderText, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      placeholderMsgId = sent.message_id;
    } catch {
      // If the placeholder fails (rare), we fall back to sendMessage on
      // success below — the user just won't see a status update.
    }

    // Watchdog: if the orchestrator runs longer than 30s (PDF tier on a
    // big book), edit the placeholder so the user knows the bot isn't
    // frozen — it's just slow. Replaced again by the final summary
    // edit, or by the error path edit, whichever happens first.
    if (placeholderMsgId !== undefined) {
      watchdogTimer = setTimeout(() => {
        const longerText =
          `⏳ *العملية تأخذ وقتًا أطول من المتوقّع...*\n` +
          `📚 *${escMd(bookName)}*\n\n` +
          `_البوت لسّه شغّال على الملخص. شكرًا لصبرك._`;
        bot.editMessageText(longerText, {
          chat_id:                  chatId,
          message_id:               placeholderMsgId!,
          parse_mode:               "Markdown",
          disable_web_page_preview: true,
        }).catch(() => {});
      }, 30_000);
    }

    // Refresh "typing…" every 4s while we run — Telegram clears the
    // indicator after ~5s, so a one-shot call isn't enough for 25s+ PDFs.
    await bot.sendChatAction(chatId, "typing").catch(() => {});
    typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, "typing").catch(() => {});
    }, 4_000);

    let resp: SummaryResponse;
    const t0 = Date.now();
    try {
      resp = await getBookSummary(bookName, {
        pdfUrl:  sourceUrl,
        premium,
      });
    } finally {
      clearInterval(typingInterval);
      typingInterval = undefined;
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      }
    }
    L.info("summaryHandler", "summary delivered", {
      book:     bookName.slice(0, 50),
      provider: resp.providerName,
      ms:       Date.now() - t0,
      bookType: resp.bookType,
    });
    await deliverSummary(bot, chatId, bookName, resp, placeholderMsgId);

    // ── Engagement signal: 📘 ملخّصاتي badge (10 ملخصات) ──
    // FIX (PR #103): trackSummaryAndAward كان dead code — معرّف
    // في badges.ts لكن ما اتنادى أبداً. النتيجة: مهما المستخدم استخدم
    // الـ feature، الشارة لن تُمنح. الـ counter `sum:count:{uid}`
    // يتحدّث الآن، وعند 10 ملخصات تُمنح الشارة برسالة منفصلة.
    // Fire-and-forget: فشل الـ awarding لا يُعطّل تسليم الملخص.
    trackSummaryAndAward(userId).then(async (badge) => {
      if (badge) {
        const text = await buildNewBadgeMessage(userId, badge);
        await new Promise(r => setTimeout(r, 1200));
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() => {});
      }
    }).catch((e) => {
      L.warn("summaryHandler", "trackSummaryAndAward failed", {
        userId,
        err: String(e).slice(0, 100),
      });
    });
  } catch (e: any) {
    // The per-user counter was incremented by checkAndConsumeUsage
    // before this AI call ran. The user is not getting a summary, so
    // refund the slot — otherwise a user near the cap loses their
    // last allowance to a transient provider failure or a global cap
    // hit (which is the bot's fault, not theirs).
    if (usageConsumed) {
      refundUserSummaryUsage(userId, premium).catch(() => {});
    }
    // Distinguish bot-wide cap exhaustion from a generic failure so
    // the user gets actionable wording ("try later") instead of a
    // confusing "something went wrong".
    if (e instanceof GlobalSummaryLimitError) {
      L.warn("summaryHandler", "global cap reached", {
        book:   bookName.slice(0, 50),
        userId,
      });
      await deliverGlobalCapMessage(bot, chatId, bookName, placeholderMsgId);
    } else {
      L.warn("summaryHandler", "summary failed", {
        book: bookName.slice(0, 50),
        err:  String(e).slice(0, 200),
      });
      await deliverError(bot, chatId, bookName, placeholderMsgId);
    }
  } finally {
    // Defensive cleanup — normally these are already cleared in the
    // try block, but if anything threw between setup and the inner
    // finally we'd leak a timer. Calling clear* on undefined is safe.
    if (typingInterval) clearInterval(typingInterval);
    if (watchdogTimer)  clearTimeout(watchdogTimer);
    // Release the inflight lock so a subsequent retry is allowed.
    if (lockKey) redis.del(lockKey).catch(() => {});
  }
}

// Replace the placeholder when the bot-wide daily AI ceiling has been
// hit. Worded explicitly as a temporary, time-based limit (not a user
// quota issue and not a generic error) so the user knows retrying
// later will work — no upgrade path is offered because Premium also
// shares the same global Gemini pool on a busy day.
async function deliverGlobalCapMessage(
  bot:               TelegramBot,
  chatId:            number,
  bookName:          string,
  placeholderMsgId?: number,
): Promise<void> {
  const text =
    `🌙 *بلغ البوت الحد اليومي للملخصات*\n` +
    `📚 *${escMd(bookName)}*\n\n` +
    `_طلب عدد كبير من المستخدمين ملخصات اليوم. حاول بعد قليل أو غداً — الكتب التي تم تلخيصها سابقاً ستظل متاحة كالمعتاد._`;
  if (placeholderMsgId !== undefined) {
    try {
      await bot.editMessageText(text, {
        chat_id:                  chatId,
        message_id:               placeholderMsgId,
        parse_mode:               "Markdown",
        disable_web_page_preview: true,
      });
      return;
    } catch {
      // Fall through to sendMessage if edit fails.
    }
  }
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
  }).catch(() => {});
}

// Replace the placeholder with a clear error message instead of leaving
// the user staring at a stale "loading" indicator. Falls back to a
// fresh sendMessage if the edit fails or no placeholder exists.
async function deliverError(
  bot:               TelegramBot,
  chatId:            number,
  bookName:          string,
  placeholderMsgId?: number,
): Promise<void> {
  const errorText =
    `❌ *تعذّر إنتاج الملخص*\n` +
    `📚 *${escMd(bookName)}*\n\n` +
    `_حدث خطأ أثناء توليد الملخص. حاول مرّة أخرى بعد قليل._`;
  if (placeholderMsgId !== undefined) {
    try {
      await bot.editMessageText(errorText, {
        chat_id:                  chatId,
        message_id:               placeholderMsgId,
        parse_mode:               "Markdown",
        disable_web_page_preview: true,
      });
      return;
    } catch {
      // Fall through to sendMessage if edit fails (rare).
    }
  }
  await bot.sendMessage(chatId, errorText, {
    parse_mode: "Markdown",
  }).catch(() => {});
}

// Render the final summary into the placeholder message (edit-in-place
// when possible, send a fresh message otherwise). Editing keeps the chat
// clean and gives the user the impression of one continuous "loading →
// done" interaction instead of two separate messages.
async function deliverSummary(
  bot:               TelegramBot,
  chatId:            number,
  bookName:          string,
  resp:              SummaryResponse,
  placeholderMsgId?: number,
): Promise<void> {
  const header = pickHeader(resp);
  // Trim very long bodies to stay safely under Telegram's 4096-char
  // message limit (we use Markdown which adds escape overhead).
  const body   = resp.summary.length > 3500
    ? resp.summary.slice(0, 3500) + "…"
    : resp.summary;
  const footer = renderProvenance(resp);

  const text =
    `${header}\n` +
    `📚 *${escMd(bookName)}*\n` +
    `\n${escMd(body)}\n` +
    `\n${footer}`;

  const plainFallback =
    `${header.replace(/[*_]/g, "")}\n${bookName}\n\n${body}\n\n${footer.replace(/[*_]/g, "")}`;

  if (placeholderMsgId !== undefined) {
    try {
      await bot.editMessageText(text, {
        chat_id:                  chatId,
        message_id:                placeholderMsgId,
        parse_mode:               "Markdown",
        disable_web_page_preview: true,
      });
      return;
    } catch {
      // Markdown parse error or message-too-old — try a plain edit.
      try {
        await bot.editMessageText(plainFallback, {
          chat_id:                  chatId,
          message_id:                placeholderMsgId,
          disable_web_page_preview: true,
        });
        return;
      } catch {
        // Edit completely failed — fall through to sending a fresh message.
      }
    }
  }

  await bot.sendMessage(chatId, text, {
    parse_mode:               "Markdown",
    disable_web_page_preview: true,
  }).catch(async () => {
    await bot.sendMessage(chatId, plainFallback, {
      disable_web_page_preview: true,
    }).catch(() => {});
  });
}
