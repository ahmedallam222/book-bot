import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { ADMIN_IDS } from "./config.js";
import { getWeeklyStats, getTopBooks } from "./analytics.js";
import { escMd } from "./text.js";
import { storage } from "../storage.js";

// ══════════════════════════════════════════════
// WEEKLY REPORT — تقرير أسبوعي
// ══════════════════════════════════════════════

const WEEKLY_SENT_KEY = "weekly:last_sent";

function bar(filled: number, total = 10): string {
  const f = Math.max(0, Math.min(total, Math.round(filled)));
  return "▰".repeat(f) + "▱".repeat(total - f);
}

// ── Build weekly message ───────────────────────

async function buildWeeklyMessage(isAdminView = false): Promise<string> {
  const [week, topBooks, globalStats] = await Promise.all([
    getWeeklyStats(),
    getTopBooks(5),
    storage.getStats().catch(() => ({ totalUsers: 0, totalSearches: 0, totalDownloads: 0 })),
  ]);

  const totalSearches  = week.reduce((s, d) => s + d.searches,  0);
  const totalDownloads = week.reduce((s, d) => s + d.downloads, 0);
  const totalSuccess   = week.reduce((s, d) => s + d.success,   0);
  const totalCache     = week.reduce((s, d) => s + d.cacheHits, 0);
  const weekRate = totalDownloads > 0
    ? `${Math.round((totalSuccess / totalDownloads) * 100)}%`
    : "0%";
  const cacheRate = totalDownloads > 0
    ? `${Math.round((totalCache / totalDownloads) * 100)}%`
    : "0%";

  // ── Header ────────────────────────────────────
  let msg =
    `📊 *التقرير الأسبوعي — خلاصة الكتب*\n` +
    `━━━━━━━━━━━━━━━━━\n\n`;

  // ── خلاصة الأسبوع ────────────────────────────
  msg +=
    `*📈 ملخّص الأسبوع:*\n` +
    `🔍 بحثات: *${totalSearches.toLocaleString()}*\n` +
    `📥 تحميلات: *${totalDownloads.toLocaleString()}*\n` +
    `✅ نجاح: *${totalSuccess}* (${weekRate})\n` +
    `⚡ كاش: *${totalCache}* (${cacheRate})\n\n`;

  // ── جدول يومي ─────────────────────────────────
  msg += `*📅 يومياً:*\n`;
  const maxDownload = Math.max(...week.map((d) => d.downloads), 1);
  for (const d of week) {
    const isToday = d.date === new Date().toISOString().slice(0, 10);
    const label   = isToday ? `*${d.date}*` : d.date;
    const b       = bar((d.downloads / maxDownload) * 10);
    msg += `${label}: \`${b}\` ${d.downloads}↓ ${d.successRate}\n`;
  }
  msg += "\n";

  // ── أكثر الكتب طلباً ──────────────────────────
  if (topBooks.length > 0) {
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    msg += `*📚 أكثر الكتب طلباً:*\n`;
    for (let i = 0; i < Math.min(topBooks.length, 5); i++) {
      msg += `${medals[i]} ${escMd(topBooks[i].title.slice(0, 40))} *(${topBooks[i].count})*\n`;
    }
    msg += "\n";
  }

  // ── الإجماليات (للأدمن فقط) ─────────────────
  if (isAdminView) {
    msg +=
      `*🌍 الإجماليات الكلية:*\n` +
      `👥 المستخدمون: *${globalStats.totalUsers.toLocaleString()}*\n` +
      `📥 تحميلات كلية: *${globalStats.totalDownloads.toLocaleString()}*\n\n`;
  }

  msg += `_${new Date().toLocaleDateString("ar-SA", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}_`;

  return msg;
}

// ── handleWeeklyCommand ───────────────────────

export async function handleWeeklyCommand(
  bot:      TelegramBot,
  chatId:   number,
  userId:   string,
  isAdmin:  boolean
): Promise<void> {
  try {
    const msg = await buildWeeklyMessage(isAdmin);
    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: isAdmin
        ? {
            inline_keyboard: [
              [
                { text: "🔄 تحديث",  callback_data: "weekly_refresh" },
                { text: "📤 تصدير",  callback_data: "weekly_export"  },
              ],
              [{ text: "◀️ رجوع",   callback_data: "admin_refresh"  }],
            ],
          }
        : {
            inline_keyboard: [[
              { text: "🔄 تحديث", callback_data: "weekly_refresh" },
            ]],
          },
    });
  } catch (e) {
    L.error("weekly", `handleWeeklyCommand error`, { err: String(e).slice(0, 100) });
    await bot.sendMessage(chatId, "❌ خطأ في جلب التقرير الأسبوعي").catch(() => {});
  }
}

// ── broadcastWeeklyToAdmins ───────────────────

/**
 * يُرسل تقريراً أسبوعياً لكل الأدمنز.
 * يُشغَّل من index.ts كل جمعة مساءً.
 * يستخدم Redis NX لضمان الإرسال مرة واحدة فقط.
 */
export async function broadcastWeeklyToAdmins(bot: TelegramBot): Promise<void> {
  const week = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lockKey = `${WEEKLY_SENT_KEY}:${week}`;

  // NX: لو المفتاح موجود → سبق الإرسال هذا الأسبوع
  const locked = await redis.set(lockKey, "1", "EX", 7 * 24 * 3600, "NX").catch(() => null);
  if (!locked) {
    L.debug("weekly", `Weekly already sent for ${week} — skipping`);
    return;
  }

  L.info("weekly", `Broadcasting weekly report to ${ADMIN_IDS.size} admin(s)`);

  try {
    const msg = await buildWeeklyMessage(true);
    const promises = [...ADMIN_IDS].map((adminId) =>
      bot.sendMessage(Number(adminId), msg, { parse_mode: "Markdown" }).catch((e) =>
        L.warn("weekly", `Failed to send weekly to admin ${adminId}: ${String(e).slice(0, 80)}`)
      )
    );
    await Promise.allSettled(promises);
    L.info("weekly", "Weekly broadcast complete");
  } catch (e) {
    L.error("weekly", `broadcastWeeklyToAdmins error`, { err: String(e).slice(0, 100) });
  }
}
