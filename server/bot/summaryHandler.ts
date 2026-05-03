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
import { escMd } from "./text.js";
import {
  getBookSummary,
  getCachedSummary,
  checkAndConsumeUsage,
} from "./summary.js";
import type { SummaryResponse } from "./aiProviders/types.js";
import { SUMMARY_DAILY_LIMIT_FREE } from "./config.js";

// Per-user dedup window in seconds — the same user spamming the
// summary button should hit cache; this prevents re-running the
// orchestrator concurrently for the same key (which would spend
// quota twice).
const INFLIGHT_TTL = 60;

function inflightKey(userId: string, sessionKey: string): string {
  return `summary:inflight:${userId}:${sessionKey}`;
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
  const entry      = getSession(sessionKey);
  if (!entry?.bookName) {
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "⏰ انتهت صلاحية هذا الزر. اكتب اسم الكتاب من جديد.",
      show_alert: true,
    }).catch(() => {});
    return;
  }

  const bookName  = entry.bookName;
  const sourceUrl = entry.url;

  // In-flight guard: if the user double-tapped, the second call
  // sees the lock and we just acknowledge without re-running.
  const lockKey = inflightKey(userId, sessionKey);
  const locked  = await redis.set(lockKey, "1", "EX", INFLIGHT_TTL, "NX").catch(() => null);
  if (!locked) {
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "⏳ الملخص جاري تجهيزه...",
    }).catch(() => {});
    return;
  }

  try {
    // Cache fast-path — skip the quota check entirely for cached
    // hits (no upstream cost, treat as free).
    const cached = await getCachedSummary(bookName);
    if (cached) {
      await bot.answerCallbackQuery(callbackQueryId).catch(() => {});
      await sendSummaryMessage(bot, chatId, bookName, cached);
      return;
    }

    const premium = await isPremium(userId).catch(() => false);

    // Quota check — only consumes when we'll actually call AI.
    const usage = await checkAndConsumeUsage(userId, premium);
    if (usage.blocked) {
      await bot.answerCallbackQuery(callbackQueryId).catch(() => {});
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
    // 5–15s and Telegram complains if we don't ack within ~3s.
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "⏳ جاري إعداد الملخص...",
    }).catch(() => {});

    // Visible "typing…" cue while we run.
    await bot.sendChatAction(chatId, "typing").catch(() => {});

    const t0 = Date.now();
    const resp = await getBookSummary(bookName, {
      pdfUrl:  sourceUrl,
      premium,
    });
    L.info("summaryHandler", "summary delivered", {
      book:     bookName.slice(0, 50),
      provider: resp.providerName,
      ms:       Date.now() - t0,
      bookType: resp.bookType,
    });
    await sendSummaryMessage(bot, chatId, bookName, resp);
  } catch (e: any) {
    L.warn("summaryHandler", "summary failed", {
      book: bookName.slice(0, 50),
      err:  String(e).slice(0, 200),
    });
    await bot.sendMessage(chatId,
      `😔 تعذّر إنتاج ملخص لكتاب *${escMd(bookName)}* الآن. حاول بعد قليل.`,
      { parse_mode: "Markdown" },
    ).catch(() => {});
  } finally {
    // Release the inflight lock so a subsequent retry is allowed.
    redis.del(lockKey).catch(() => {});
  }
}

async function sendSummaryMessage(
  bot:      TelegramBot,
  chatId:   number,
  bookName: string,
  resp:     SummaryResponse,
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

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  }).catch(async () => {
    // If Markdown parsing failed (unbalanced asterisks in summary),
    // resend as plain text — better degraded delivery than failure.
    await bot.sendMessage(chatId,
      `${header.replace(/[*_]/g, "")}\n${bookName}\n\n${body}\n\n${footer.replace(/[*_]/g, "")}`,
      { disable_web_page_preview: true },
    ).catch(() => {});
  });
}
