import TelegramBot from "node-telegram-bot-api";
import { redis }         from "./redis.js";
import { L }             from "./logger.js";
import { storage }       from "../storage.js";
import { escMd, cairoDateString, truncateAtWord } from "./text.js";
import { getQueueStats, clearDLQ, getDLQJobs } from "./queue.js";
import { blacklistStats, clearBlacklist }        from "./blacklist.js";
import { getPdfValidationStats }                 from "./pdfValidator.js";
import {
  getDailyStats, getTotalStats, getTopBooks, getSourceStats, getFunnelStats, getWeeklyStats,
  setSourceManuallyDisabled, isSourceManuallyDisabled, sanitizeDomainKey,
} from "./analytics.js";
import { isPremium, getUserDailyLimit, setPremium, getPremiumExpiry } from "./userSettings.js";
import { MAINTENANCE_KEY, BOT_ANNOUNCE_KEY, PREMIUM_SET_KEY } from "./config.js";
import { announceMaintenanceEnd }                              from "./maintenanceAnnounce.js";
import { getStreakState } from "./streak.js";
import { getUserBadges, BADGES }     from "./badges.js";
import { getReferralState }          from "./referral.js";

// ══════════════════════════════════════════════
// ADMIN — لوحة تحكم المشرفين (كاملة)
// ══════════════════════════════════════════════

// ── Welcome message ───────────────────────────
export function buildWelcome(
  name: string, remaining: number, limit: number,
  sourceCount: number, isPrem: boolean,
  isFirstTime = false
): string {
  const premBadge = isPrem ? " ⭐" : "";
  let balanceLine: string;
  if (limit <= 0) {
    balanceLine = "♾️ رصيد غير محدود";
  } else {
    const used   = Math.max(0, limit - remaining);
    const filled = Math.round((used / limit) * 8);
    const bar    = "█".repeat(Math.min(filled, 8)) + "░".repeat(Math.max(0, 8 - filled));
    const emoji  = remaining === 0 ? "⛔" : remaining <= 2 ? "🟡" : "🟢";
    balanceLine  = `${emoji} \`${bar}\` *${remaining}/${limit}* كتاب متبقٍّ`;
  }

  if (isFirstTime) {
    // ترحيب موسّع للمستخدم الجديد فقط — جولة سريعة
    return (
      `🎉 *أهلاً وسهلاً يا ${escMd(name)}!*\n` +
      `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n` +
      `_أنا بوت خلاصة الكتب — أبحث لك في أكبر المكتبات العربية_\n\n` +
      `🚀 *كيف أستخدمك؟*\n` +
      `◦ اكتب اسم أي كتاب مباشرةً\n` +
      `◦ \`/random\` لكتاب مفاجأة\n` +
      `◦ \`/wishlist عنوان\` لحفظ كتاب لاحقاً\n` +
      `◦ \`/help\` للقائمة الكاملة\n\n` +
      `${balanceLine}\n` +
      `🔍 *${sourceCount}* مصدر عربي تحت أمرك\n\n` +
      `_اكتب اسم كتابك الأول وانطلق_ 📖✨`
    );
  }

  return (
    `📚 *أهلاً ${escMd(name)}${premBadge}*\n` +
    `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n\n` +
    `${balanceLine}\n` +
    `🔍 *${sourceCount}* مصدر عربي تحت أمرك\n\n` +
    `_اكتب اسم أي كتاب وسأحضره لك فوراً_ ✨`
  );
}

// ── /profile message — صفحة المستخدم ─────────
//
// تجمع: streak (active/max)، badges، إجمالي تحميلات، Premium status،
// تقدّم الإحالات. مكمّلة لـ /stats — مش بديل (stats للحد اليومي،
// profile للـ engagement).
export async function buildProfileMessage(userId: string, name: string): Promise<string> {
  const [streak, badges, refState, prem, premExp, user] = await Promise.all([
    getStreakState(userId),
    getUserBadges(userId),
    getReferralState(userId),
    isPremium(userId),
    getPremiumExpiry(userId).catch(() => null),
    storage.getOrCreateUser(userId).catch(() => null),
  ]);

  const totalDl = user?.totalDownloads ?? 0;

  // ── Streak block ──
  let streakBlock: string;
  if (streak.active >= 2) {
    const fire =
      streak.active >= 30 ? "🌟" :
      streak.active >= 14 ? "🔥🔥🔥" :
      streak.active >= 7  ? "🔥🔥" :
      "🔥";
    streakBlock = `${fire} *السلسلة:* ${streak.active} يوم${streak.max > streak.active ? ` _(أعلى: ${streak.max})_` : ""}`;
  } else if (streak.max > 0) {
    streakBlock = `🔥 *السلسلة:* ابدأ اليوم! _(أعلاك: ${streak.max} يوم)_`;
  } else {
    streakBlock = `🔥 *السلسلة:* ابدأ اليوم — حمّل كتاباً وافتح أول milestone!`;
  }

  // ── Premium block ──
  let premBlock: string;
  if (prem) {
    const days = premExp
      ? Math.max(0, Math.ceil((premExp.getTime() - Date.now()) / (24 * 3600 * 1000)))
      : 0;
    premBlock = days > 0
      ? `⭐ *Premium:* مفعّل _(${days} يوم متبقٍّ)_`
      : `⭐ *Premium:* مفعّل _(دائم)_`;
  } else {
    premBlock = `⭐ *Premium:* غير مفعّل — \`/premium\` للترقية`;
  }

  // ── Badges block ──
  let badgesBlock: string;
  if (badges.length === 0) {
    badgesBlock = `🎓 *الشارات:* 0 / ${BADGES.length} _— حمّل كتباً واصنع سلسلة لفتحها_`;
  } else {
    const list = badges.map(b => `${b.emoji} ${b.name}`).join(" · ");
    badgesBlock = `🎓 *الشارات:* ${badges.length} / ${BADGES.length}\n_${list}_`;
  }

  // ── Referral block ──
  let refBlock = "";
  if (refState.count > 0 || refState.nextTier) {
    const next = refState.nextTier;
    refBlock = next
      ? `\n🎁 *الإحالات:* ${refState.count} _— ${next.remaining} لمكافأة +${next.days} يوم Premium_`
      : `\n🎁 *الإحالات:* ${refState.count} _— رابطك في_ \`/invite\``;
  }

  return (
    `👤 *ملفك — ${escMd(name)}*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
    `📥 *إجمالي التحميلات:* ${totalDl}\n` +
    `${streakBlock}\n` +
    `${premBlock}${refBlock}\n\n` +
    `${badgesBlock}\n\n` +
    `_استخدم \`/invite\` لرابط الدعوة، أو \`/stats\` للحد اليومي._`
  );
}

// ── لوحة التحكم الرئيسية ─────────────────────
export async function sendAdminPanel(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const [today, total, qs, blStats, pdfStats, dbStats] = await Promise.all([
      getDailyStats(),
      getTotalStats(),
      getQueueStats(),
      blacklistStats(),
      getPdfValidationStats(),
      storage.getStats(),
    ]);

    const isMaint  = await redis.get(MAINTENANCE_KEY).catch(() => null);
    const announce = await redis.get(BOT_ANNOUNCE_KEY).catch(() => null);
    const successRate = (today.requests ?? 0) > 0
      ? Math.round(((today.found ?? 0) / (today.requests ?? 1)) * 100)
      : 0;

    const msg =
      `🔧 *لوحة التحكم — خلاصة الكتب*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      `📊 *اليوم:*\n` +
      `◦ طلبات: *${today.requests ?? 0}* | نجح: *${today.found ?? 0}* (${successRate}%)\n` +
      `◦ تحميل: *${today.downloads ?? 0}* | كاش: *${today.cache_hits ?? 0}*\n\n` +
      `📈 *الإجمالي:*\n` +
      `◦ مستخدمون: *${dbStats.totalUsers}*\n` +
      `◦ تحميلات: *${total.downloads ?? 0}* | بحث: *${total.searches ?? 0}*\n\n` +
      `📋 *الطابور:*\n` +
      `◦ High: *${qs.highQueue}* | Normal: *${qs.normalQueue}* | DLQ: *${qs.dlqSize}*\n\n` +
      `🛡️ *PDF Validator:*\n` +
      `◦ قبول: *${pdfStats.accepted}* | رفض: *${pdfStats.rejected}* (${pdfStats.rejectionRate})\n` +
      `◦ Mistral: *${pdfStats.mistralUsed}* مرة\n\n` +
      `🚫 *Blacklist:* ${blStats.total} رابط\n` +
      `📢 *إعلان:* ${announce ? `"${announce.slice(0, 30)}..."` : "لا يوجد"}\n` +
      `🔧 *الصيانة:* ${isMaint === "1" ? "✅ مفعّلة" : "❌ معطّلة"}`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 إحصاءات",      callback_data: "admin_stats"    },
            { text: "📋 الطابور",       callback_data: "admin_queue"    },
          ],
          [
            { text: "👥 المستخدمون",    callback_data: "admin_users_0"  },
            { text: "🏆 أكثر تحميلاً", callback_data: "admin_top"      },
          ],
          [
            { text: "🚫 Blacklist",     callback_data: "admin_blacklist" },
            { text: "💾 الكاش",         callback_data: "admin_cache"     },
          ],
          [
            { text: "📡 المصادر",       callback_data: "admin_sources"   },
            { text: "🔭 الـ Funnel",    callback_data: "admin_funnel"    },
          ],
          [
            { text: isMaint === "1" ? "✅ إيقاف الصيانة" : "🔧 تفعيل الصيانة",
              callback_data: "admin_toggle_maintenance" },
          ],
          [
            { text: "📢 بث جماعي",      callback_data: "admin_broadcast" },
            { text: "🗑️ مسح DLQ",       callback_data: "admin_clear_dlq" },
          ],
        ],
      },
    }).catch(() => {});
  } catch (e) {
    L.error("admin", `sendAdminPanel error`, { err: String(e).slice(0, 100) });
  }
}

// ── Pending admin actions ─────────────────────
const _pendingBroadcast  = new Map<string, { step: string; draft?: string }>();
const _pendingUserSearch = new Set<string>();

export async function handleAdminPendingAction(
  bot: TelegramBot, chatId: number, userId: string, text: string
): Promise<boolean> {

  // انتظار نص البث
  const pending = _pendingBroadcast.get(userId);
  if (pending?.step === "awaiting_broadcast") {
    _pendingBroadcast.set(userId, { step: "confirm_broadcast", draft: text });
    await bot.sendMessage(chatId,
      `📢 *معاينة البث:*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n${text}\n\n_هل تريد إرساله لجميع المستخدمين؟_`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[
          { text: "✅ إرسال", callback_data: "admin_broadcast_confirm" },
          { text: "❌ إلغاء", callback_data: "admin_broadcast_cancel"  },
        ]]},
      }
    ).catch(() => {});
    return true;
  }

  // انتظار ID للبحث عن مستخدم
  if (_pendingUserSearch.has(userId)) {
    _pendingUserSearch.delete(userId);
    const targetId = text.trim();
    if (!/^\d{5,15}$/.test(targetId)) {
      await bot.sendMessage(chatId,
        `❌ ID غير صالح: \`${escMd(targetId)}\`\n_يجب أن يكون أرقاماً فقط (5-15 رقم)_`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return true;
    }
    await showUserDetail(bot, chatId, targetId);
    return true;
  }

  return false;
}

// ── عرض تفاصيل مستخدم بـ ID ──────────────────
async function showUserDetail(bot: TelegramBot, chatId: number, targetId: string): Promise<void> {
  try {
    const [prem, limit, dlCount, history, expiry] = await Promise.all([
      isPremium(targetId),
      getUserDailyLimit(targetId),
      storage.getDailyDownloadCount(targetId).catch(() => 0),
      storage.getUserSearchHistory(targetId, 5).catch(() => [] as { query: string; createdAt: Date | null }[]),
      getPremiumExpiry(targetId),
    ]);

    const premLabel  = prem
      ? expiry
        ? `⭐ Premium (ينتهي ${expiry.toLocaleDateString("ar-EG", { day: "numeric", month: "long" })})`
        : "⭐ Premium (دائم)"
      : "مجاني";
    const limitLabel = limit <= 0 ? "∞" : String(limit);
    const histLines  = history.length
      ? history.map((h, i) => `${i + 1}\\. _${escMd(h.query.slice(0, 45))}_`).join("\n")
      : "_لا سجل_";

    await bot.sendMessage(chatId,
      `👤 *مستخدم: \`${targetId}\`*\n` +
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
      `◦ نوع الحساب: *${premLabel}*\n` +
      `◦ الحد اليومي: *${limitLabel}*\n` +
      `◦ حمّل اليوم: *${dlCount}*\n\n` +
      `*آخر الكتب:*\n${histLines}`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [
          [
            { text: prem ? "❌ إلغاء Premium" : "⭐ منح Premium",
              callback_data: `admin_user_prem:${targetId}` },
          ],
          [
            { text: "🔍 بحث مستخدم آخر", callback_data: "admin_user_search" },
            { text: "🔙 قائمة المستخدمين", callback_data: "admin_users_0"   },
          ],
        ]},
      }
    ).catch(() => {});
  } catch (e) {
    await bot.sendMessage(chatId, `⚠️ خطأ: ${String(e).slice(0, 80)}`).catch(() => {});
  }
}

// ── Admin callback handler ────────────────────
export async function handleAdminCallback(
  bot:      TelegramBot,
  chatId:   number,
  userId:   string,
  data:     string,
  msgId?:   number,
  queryId?: string
): Promise<void> {
  try {

    // ── قائمة المستخدمين مع pagination ──────────────────
    if (data.startsWith("admin_users_")) {
      const page    = parseInt(data.replace("admin_users_", ""), 10) || 0;
      const perPage = 10;
      const { users, total } = await storage.getAllUsersWithDetails(perPage, page * perPage);
      const totalPages = Math.ceil(total / perPage);

      if (!users.length) {
        await bot.sendMessage(chatId, `👥 لا يوجد مستخدمون بعد.`).catch(() => {});
        return;
      }

      // جلب premium status لكل المستخدمين في pipeline واحد بدل N calls
      const premPipeline = redis.pipeline();
      users.forEach((u) => premPipeline.sismember(PREMIUM_SET_KEY, u.telegramId));
      const premResults = await premPipeline.exec();

      const lines = users.map((u, i) => {
        const num    = page * perPage + i + 1;
        const name   = escMd((u.firstName || u.username || u.telegramId).slice(0, 22));
        const dls    = u.totalDownloads ?? 0;
        const isPrem = (premResults?.[i]?.[1] as number) === 1;
        const badge  = isPrem ? "⭐" : "◦";
        return `${num}\\. ${badge} ${name} — *${dls}* ⬇️`;
      });

      const nav: TelegramBot.InlineKeyboardButton[] = [];
      if (page > 0)              nav.push({ text: "◀️", callback_data: `admin_users_${page - 1}` });
      nav.push({ text: `${page + 1} / ${totalPages}`, callback_data: "noop" });
      if (page < totalPages - 1) nav.push({ text: "▶️", callback_data: `admin_users_${page + 1}` });

      await bot.sendMessage(chatId,
        `👥 *المستخدمون* (${total} إجمالي)\n` +
        `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
        lines.join("\n"),
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [
            nav.length > 0 ? nav : [],
            [
              { text: "🔍 بحث بـ ID",       callback_data: "admin_user_search" },
              { text: "🔙 لوحة التحكم",     callback_data: "admin_panel"       },
            ],
          ].filter(r => r.length > 0)},
        }
      ).catch(() => {});
      return;
    }

    // ── بحث عن مستخدم بـ ID ─────────────────────────────
    if (data === "admin_user_search") {
      _pendingUserSearch.add(userId);
      await bot.sendMessage(chatId,
        `🔍 *بحث عن مستخدم*\n\n_أرسل الـ Telegram ID (أرقام فقط):_`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    // ── toggle premium لمستخدم محدد ─────────────────────
    if (data.startsWith("admin_user_prem:")) {
      const targetId = data.split(":")[1] ?? "";
      if (!targetId) return;
      const wasPrem = await isPremium(targetId);
      await setPremium(targetId, !wasPrem, 0, { by: userId, source: "telegram-callback" });
      L.adminAction(userId, `${wasPrem ? "revoke" : "grant"} premium → ${targetId}`);
      await bot.sendMessage(chatId,
        `✅ ${wasPrem ? "تم إلغاء Premium من" : "تم منح Premium لـ"} \`${targetId}\``,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      await showUserDetail(bot, chatId, targetId);
      return;
    }

    // ── العودة للوحة الرئيسية ────────────────────────────
    if (data === "admin_panel") {
      await sendAdminPanel(bot, chatId);
      return;
    }

    // ── Toggle مصدر يدوياً (تفعيل/تعطيل) ──────────────
    // FIX-MANUAL-DISABLE: الـ callback dispatcher في callbacks.ts كان
    // يحوِّل `admin_src_toggle:{domain}` لـ handleAdminCallback بدون أي
    // handler فعلي → الزر مكنش بيعمل حاجة. الآن: يقلب src:off:{domain}
    // ويعيد رسم لوحة المصادر.
    if (data.startsWith("admin_src_toggle:")) {
      const rawDomain = data.slice("admin_src_toggle:".length);
      const domain    = sanitizeDomainKey(rawDomain);
      if (!domain) {
        if (queryId) await bot.answerCallbackQuery(queryId, { text: "❌ مصدر غير صالح" }).catch(() => {});
        return;
      }
      const wasOff = await isSourceManuallyDisabled(domain);
      await setSourceManuallyDisabled(domain, !wasOff);
      L.adminAction(userId, `source ${wasOff ? "enabled" : "disabled"}: ${domain}`);
      if (queryId) {
        await bot.answerCallbackQuery(queryId, {
          text: wasOff ? `✅ ${domain} تم تفعيله` : `🚫 ${domain} تم تعطيله`,
        }).catch(() => {});
      }
      if (msgId) {
        try { await bot.deleteMessage(chatId, msgId); } catch {}
      }
      await sendSourcesPanel(bot, chatId);
      return;
    }

    switch (data) {

      // ── إحصاءات تفصيلية ─────────────────────────────
      case "admin_stats": {
        const [today, total, topBooks] = await Promise.all([
          getDailyStats(),
          getTotalStats(),
          getTopBooks(5),
        ]);
        const weekData  = await getWeeklyStats();
        const weekLines = Object.entries(weekData)
          .map(([day, s]) =>
            `◦ ${day}: طلبات *${s.requests ?? 0}* | نجح *${s.found ?? 0}* | تحميل *${s.downloads ?? 0}*`
          ).join("\n");
        const topLines = topBooks.map((b, i) =>
          `${i + 1}\\. _${escMd(truncateAtWord(b.book, 60))}_ *(${b.count})*`
        ).join("\n");

        await bot.sendMessage(chatId,
          `📊 *إحصاءات تفصيلية*\n` +
          `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
          `*اليوم:*\n` +
          `◦ طلبات: *${today.requests??0}* | نجح: *${today.found??0}*\n` +
          `◦ تحميل: *${today.downloads??0}* | كاش: *${today.cache_hits??0}*\n\n` +
          `*الإجمالي:*\n` +
          `◦ تحميلات: *${total.downloads??0}* | بحث: *${total.searches??0}*\n\n` +
          `*آخر 7 أيام:*\n${weekLines || "_لا بيانات_"}\n\n` +
          `*أكثر الكتب طلباً:*\n${topLines || "_لا بيانات_"}`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [
              [{ text: "📤 تصدير CSV",    callback_data: "admin_export_csv" }],
              [{ text: "🔙 لوحة التحكم", callback_data: "admin_panel"      }],
            ]},
          }
        ).catch(() => {});
        break;
      }

      // ── أكثر الكتب تحميلاً ───────────────────────────
      case "admin_top": {
        const top = await getTopBooks(20);
        if (!top.length) {
          await bot.sendMessage(chatId, `🏆 لا توجد بيانات بعد.`).catch(() => {});
          break;
        }
        const medals = ["🥇","🥈","🥉"];
        const lines  = top.map((b, i) =>
          `${medals[i] ?? `${i + 1}\\.`} _${escMd(truncateAtWord(b.book, 80))}_ *(${b.count})*`
        ).join("\n");
        await bot.sendMessage(chatId,
          `🏆 *أكثر 20 كتاباً تحميلاً*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n${lines}`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [
              [{ text: "📤 تصدير CSV",    callback_data: "admin_export_csv" }],
              [{ text: "🔙 لوحة التحكم", callback_data: "admin_panel"      }],
            ]},
          }
        ).catch(() => {});
        break;
      }

      // ── الطابور ──────────────────────────────────────
      case "admin_queue": {
        const qs      = await getQueueStats();
        const dlqJobs = await getDLQJobs(5);
        const dlqLines = dlqJobs.map((j) =>
          `◦ _${escMd(j.bookName.slice(0, 40))}_ — ${j.retries} retry`
        ).join("\n");
        await bot.sendMessage(chatId,
          `📋 *الطابور*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
          `⚡ High: *${qs.highQueue}*\n` +
          `📋 Normal: *${qs.normalQueue}*\n` +
          `💀 DLQ: *${qs.dlqSize}*\n` +
          `🔄 نشط: *${qs.totalActiveJobs}*\n\n` +
          `${dlqLines ? `*آخر DLQ:*\n${dlqLines}` : "_DLQ فارغ_ ✅"}`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [
              [{ text: "🗑️ مسح DLQ",     callback_data: "admin_clear_dlq" }],
              [{ text: "🔙 لوحة التحكم", callback_data: "admin_panel"     }],
            ]},
          }
        ).catch(() => {});
        break;
      }

      case "admin_clear_dlq":
        await clearDLQ();
        L.adminAction(userId, "DLQ cleared");
        await bot.sendMessage(chatId, `✅ تم مسح DLQ بنجاح.`).catch(() => {});
        break;

      // ── Blacklist ────────────────────────────────────
      case "admin_blacklist": {
        const bl = await blacklistStats();
        await bot.sendMessage(chatId,
          `🚫 *Blacklist*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
          `◦ إجمالي: *${bl.total}* رابط محجوب`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [
              [{ text: "🗑️ مسح الـ Blacklist", callback_data: "admin_clear_blacklist" }],
              [{ text: "🔙 لوحة التحكم",        callback_data: "admin_panel"           }],
            ]},
          }
        ).catch(() => {});
        break;
      }

      case "admin_clear_blacklist":
        await clearBlacklist();
        L.adminAction(userId, "blacklist cleared");
        await bot.sendMessage(chatId, `✅ تم مسح الـ Blacklist بنجاح.`).catch(() => {});
        break;

      // ── Cache ────────────────────────────────────────
      case "admin_cache": {
        const cStats = await storage.getCacheStats();
        await bot.sendMessage(chatId,
          `💾 *الكاش*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
          `◦ مخزّن: *${cStats.totalCached}* كتاب\n` +
          `◦ خُدم من الكاش: *${cStats.totalServed}* مرة`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[
              { text: "🔙 لوحة التحكم", callback_data: "admin_panel" },
            ]]},
          }
        ).catch(() => {});
        break;
      }

      // ── المصادر ──────────────────────────────────────
      case "admin_sources": {
        await sendSourcesPanel(bot, chatId);
        break;
      }

      // ── Funnel ───────────────────────────────────────
      case "admin_funnel": {
        const f        = await getFunnelStats();
        const total    = f.total        ?? 0;
        const found    = f.search_found ?? 0;
        const success  = f.send_success ?? 0;
        const direct   = f.send_direct  ?? 0;
        const local    = f.send_local   ?? 0;
        const foundPct   = total > 0 ? Math.round((found   / total) * 100) : 0;
        const successPct = found > 0 ? Math.round((success / found) * 100) : 0;
        await bot.sendMessage(chatId,
          `🔭 *Funnel اليوم*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
          `◦ إجمالي طلبات: *${total}*\n` +
          `◦ وجد نتائج: *${found}* (${foundPct}%)\n` +
          `◦ أُرسل بنجاح: *${success}* (${successPct}% من الموجود)\n\n` +
          `*طريقة الإرسال:*\n` +
          `◦ Direct: *${direct}*\n` +
          `◦ Local: *${local}*`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[
              { text: "🔙 لوحة التحكم", callback_data: "admin_panel" },
            ]]},
          }
        ).catch(() => {});
        break;
      }

      // ── Maintenance ──────────────────────────────────
      case "admin_toggle_maintenance": {
        const isMaint = await redis.get(MAINTENANCE_KEY).catch(() => null);
        if (isMaint === "1") {
          await redis.del(MAINTENANCE_KEY);
          L.adminAction(userId, "maintenance OFF");
          await bot.sendMessage(chatId,
            `✅ *تم إيقاف وضع الصيانة.*\n\n_جارٍ إرسال إعلان للجروبات…_`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
          // FIX (maintenance-announce): لما المشرف يطفي الصيانة، البوت يعلن
          // تلقائياً في كل الجروبات المعروفة. fire-and-forget عشان ما يوقفش
          // الـ callback handler لو الإرسال طوّل.
          announceMaintenanceEnd(bot).catch((e) =>
            L.error("admin", "announceMaintenanceEnd failed", { err: String(e).slice(0, 100) })
          );
        } else {
          await redis.set(MAINTENANCE_KEY, "1");
          L.adminAction(userId, "maintenance ON");
          await bot.sendMessage(chatId, `🔧 تم تفعيل وضع الصيانة.`).catch(() => {});
        }
        break;
      }

      // ── بث جماعي ────────────────────────────────────
      case "admin_broadcast":
        _pendingBroadcast.set(userId, { step: "awaiting_broadcast" });
        await bot.sendMessage(chatId,
          `📢 *بث جماعي*\n\n_أرسل نص الرسالة التي تريد بثها:_\n_يدعم Markdown ✅_`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
        break;

      case "admin_broadcast_confirm": {
        const pending = _pendingBroadcast.get(userId);
        _pendingBroadcast.delete(userId);
        if (!pending?.draft) {
          await bot.sendMessage(chatId, `❌ لا يوجد نص للبث.`).catch(() => {});
          break;
        }
        (process as NodeJS.EventEmitter).emit("dashboard:broadcast", {
          message:    pending.draft,
          parse_mode: "Markdown",
        });
        L.adminAction(userId, `broadcast: ${pending.draft.slice(0, 50)}`);
        await bot.sendMessage(chatId, `✅ تم إرسال البث.`).catch(() => {});
        break;
      }

      case "admin_broadcast_cancel":
        _pendingBroadcast.delete(userId);
        await bot.sendMessage(chatId, `❌ تم إلغاء البث.`).catch(() => {});
        break;

      // ── تصدير CSV ───────────────────────────────────
      case "admin_export_csv": {
        const top = await getTopBooks(50);
        const csv = ["كتاب,تحميلات", ...top.map((b) => `"${b.book}",${b.count}`)].join("\n");
        await bot.sendDocument(chatId,
          Buffer.from(csv, "utf-8"),
          { caption: "📊 أكثر الكتب تحميلاً" },
          { filename: `kholasa_top_books_${cairoDateString()}.csv`, contentType: "text/csv" }
        ).catch(() => {});
        break;
      }

      default:
        L.debug("admin", `Unknown admin callback: ${data}`);
    }

  } catch (e) {
    L.error("admin", `handleAdminCallback error`, { data, err: String(e).slice(0, 100) });
    await bot.sendMessage(chatId, `⚠️ خطأ مؤقت: ${String(e).slice(0, 60)}`).catch(() => {});
  }
}

// ── helper: لوحة المصادر مع أزرار toggle ─────
async function sendSourcesPanel(bot: TelegramBot, chatId: number): Promise<void> {
  const srcStats = await getSourceStats();
  // أعلى 13 (مرتبة بالـ total تنازلياً) + أيّ مصدر معطَّل يدوياً يظهر تلقائياً
  // (حتى لو total = 0 لأنه أُضيف حديثاً للـ off list — getSourceStats يضمّه).
  const top = srcStats.slice(0, 13);
  const lines: string[] = [];
  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  for (const s of top) {
    const rate = s.total > 0 ? Math.round(s.successRate * 100) : 0;
    const trust = s.totalWithRejects > 0 ? Math.round(s.trustRate * 100) : rate;
    let badge: string;
    if (s.manuallyDisabled)             badge = "🚫"; // معطّل يدوياً
    else if (s.hardAutoDisabled)        badge = "⛔"; // معطّل تلقائياً (catastrophic)
    else if (s.trustAutoDisabled)       badge = "🟣"; // معطّل تلقائياً (Mistral trust)
    else if (s.mistralOnlyAutoDisabled) badge = "💛"; // معطّل تلقائياً (Mistral-only catastrophic)
    else if (s.autoDisabled)            badge = "🟠"; // معطّل تلقائياً (low rate)
    else if (rate >= 70)                badge = "🟢";
    else if (rate >= 40)                badge = "🟡";
    else                                badge = "🔴";
    const domain = s.domain.replace(/^www\./, "").slice(0, 22);
    const mistralPart = s.mistralRejected > 0 ? ` (m:${s.mistralRejected})` : "";
    // اعرض الـ trust rate لما يختلف عن النسبة العادية (يعني Mistral رفض كتير)
    const trustPart = (s.mistralRejected > 0 && trust !== rate) ? ` · trust:${trust}%` : "";
    lines.push(`${badge} _${escMd(domain)}_ — ${rate}%${trustPart} (${s.ok}✅ ${s.fail}❌${mistralPart})`);
    const btnText = s.manuallyDisabled
      ? `✅ تفعيل ${domain.slice(0, 16)}`
      : `🚫 تعطيل ${domain.slice(0, 16)}`;
    buttons.push([{ text: btnText, callback_data: `admin_src_toggle:${s.domain}` }]);
  }
  buttons.push([{ text: "🔙 لوحة التحكم", callback_data: "admin_panel" }]);

  const legend =
    "\n\n_شرح:_ 🟢 جيد · 🟡 متوسط · 🔴 ضعيف · 🟠 منخفض النجاح · 🟣 ضعيف الثقة \\(Mistral\\) · ⛔ catastrophic · 🚫 يدوي" +
    "\n_m: عدد رفض Mistral · trust: ok / \\(ok\\+fail\\+mistral\\)_";

  await bot.sendMessage(chatId,
    `📡 *أداء المصادر*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
    `${lines.length ? lines.join("\n") : "_لا بيانات بعد_"}` +
    legend,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    }
  ).catch(() => {});
}

// ── buildHistoryMessage ───────────────────────
export async function buildHistoryMessage(
  bot: TelegramBot, chatId: number, userId: string
): Promise<void> {
  try {
    const history = await storage.getUserSearchHistory(userId, 7);
    if (!history.length) {
      await bot.sendMessage(chatId,
        `📚 *سجل كتبك*\n\n_لم تطلب أي كتاب بعد!_\n\nابحث عن كتاب وسيظهر هنا.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }
    const lines = history.map((h, i) =>
      `${i + 1}\\. _${escMd(h.query.slice(0, 55))}_`
    ).join("\n");
    await bot.sendMessage(chatId,
      `📚 *آخر كتبك*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n${lines}`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[
          { text: "🏠 القائمة", callback_data: "main_menu" },
        ]]},
      }
    ).catch(() => {});
  } catch (e) {
    L.error("admin", `buildHistoryMessage error`, { err: String(e).slice(0, 100) });
    await bot.sendMessage(chatId, `⚠️ خطأ مؤقت، حاول مرة أخرى.`).catch(() => {});
  }
}

// ── buildTopBooksMessage ──────────────────────
export async function buildTopBooksMessage(
  bot: TelegramBot, chatId: number
): Promise<void> {
  try {
    const top = await getTopBooks(15);
    if (!top.length) {
      await bot.sendMessage(chatId,
        `🏆 *الأكثر تحميلاً*\n\n_لا توجد بيانات بعد!_`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }
    const medals = ["🥇","🥈","🥉"];
    const lines  = top.map((b, i) =>
      // Smart truncate at word boundary (was: hard slice at 55 → "Full boo")
      `${medals[i] ?? `${i + 1}\\.`} _${escMd(truncateAtWord(b.book, 80))}_`
    ).join("\n");
    await bot.sendMessage(chatId,
      `🏆 *الأكثر تحميلاً*\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n${lines}`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[
          { text: "🏠 القائمة", callback_data: "main_menu" },
        ]]},
      }
    ).catch(() => {});
  } catch (e) {
    L.error("admin", `buildTopBooksMessage error`, { err: String(e).slice(0, 100) });
  }
}
