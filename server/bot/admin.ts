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
import { getImageGenStats } from "./imageGen.js";
import {
  buildAdminHomeMessage, buildAdminLiveMessage, buildAdminRetentionMessage,
  buildAdminMonthMessage, buildAdminImagesMessage, adminPanelKeyboard,
} from "./adminDashboard.js";
import {
  handleControlCallback, handleControlPendingText, kbUserControl,
  getAdminPending, clearAdminPending,
} from "./adminControl.js";
import { isBanned } from "./guards.js";
import { buildAdminAuditMessage } from "./adminAudit.js";
import { buildSystemHealthMessage, buildBackupStatusMessage, runBackupNow } from "./adminHealth.js";
import { isPremium, getUserDailyLimit, setPremium, getPremiumExpiry } from "./userSettings.js";
import { MAINTENANCE_KEY, BOT_ANNOUNCE_KEY, PREMIUM_SET_KEY } from "./config.js";
import { announceMaintenanceEnd }                              from "./maintenanceAnnounce.js";
import { getStreakState } from "./streak.js";
import { getUserBadges, BADGES }     from "./badges.js";
import { buildRetentionProfileBlock } from "./retention.js";
import { buildInterestProfileLine } from "./interests.js";
import { buildPersonalWeekProfileLine } from "./personalWeek.js";
import { getLastBook } from "./library.js";
import { getReferralState }          from "./referral.js";
import { ARABIC_SOURCES }            from "./sources.js";
import type { SourceStat }           from "./analytics.js";

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
    balanceLine = "♾️ *رصيد غير محدود*";
  } else {
    const used   = Math.max(0, limit - remaining);
    const filled = Math.round((used / limit) * 10);
    const bar    = "█".repeat(Math.min(filled, 10)) + "░".repeat(Math.max(0, 10 - filled));
    const emoji  = remaining === 0 ? "⛔" : remaining <= 2 ? "🟡" : "🟢";
    balanceLine  = `${emoji} \`${bar}\`  *${remaining}/${limit}* متبقٍّ اليوم`;
  }

  const DIV = "━━━━━━━━━━━━━━━━";

  if (isFirstTime) {
    return (
      `🌿 *أهلاً ${escMd(name)} — أنا رفيق*\n` +
      `${DIV}\n` +
      `أساعدك تجيب *كتب PDF* بسهولة.\n\n` +
      `*ابدأ الآن:*\n` +
      `① اكتب *اسم الكتاب* في الشات\n` +
      `② انتظر لحظات بينما أبحث\n` +
      `③ يصلك الملف جاهزاً للقراءة\n\n` +
      `*أزرار مهمة:*\n` +
      `◦ ✅ سجّل حضورك — مرة في اليوم (اختياري)\n` +
      `◦ 🎲 كتاب مفاجأة — إن لم تعرف ماذا تطلب\n` +
      `◦ ❓ كيف أستخدم رفيق؟ — شرح بسيط\n\n` +
      `${balanceLine}\n` +
      `🌍 أدور في *${sourceCount}* مصدر عربي\n\n` +
      `_جرّب: اكتب عنوان أيّ كتاب تحبّه._ 📖`
    );
  }

  return (
    `📚 *أهلاً ${escMd(name)}${premBadge}*\n` +
    `${DIV}\n` +
    `${balanceLine}\n` +
    `🌍 أدور لك في *${sourceCount}* مصدر\n\n` +
    `*أتريد كتاباً؟* اكتب عنوانه في المحادثة.\n` +
    `*ألست متأكّداً؟* مفاجأة · كتاب اليوم · /myweek لتقريرك.\n\n` +
    `_رفيق جاهز._ ✨`
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
    streakBlock = `${fire} *أيام النشاط المتتالية:* ${streak.active}${streak.max > streak.active ? ` _(أطول: ${streak.max})_` : ""}`;
  } else if (streak.max > 0) {
    streakBlock = `🔥 *أيّام النشاط:* ابدأ من جديد _(أطول سلسلة سابقة: ${streak.max})_`;
  } else {
    streakBlock = `🔥 *أيّام النشاط المتتالية:* لم تبدأ بعد — سجّل حضورك أو حمّل كتاباً متى شئت`;
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
    badgesBlock = `🎓 *الشارات:* 0 / ${BADGES.length} _— تُفتح تدريجياً وأنت تستخدم رفيق_`;
  } else {
    // FIX (PR #103): escMd على اسم كل شارة. الأسماء الحالية كلها نظيفة،
    // لكن أي شارة جديدة فيها `_` أو `*` كانت ستكسر `/profile` بنفس
    // bug PR #102. Defensive escaping يحمي مستقبلياً.
    const list = badges.map(b => `${b.emoji} ${escMd(b.name)}`).join(" · ");
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

  const [retentionBlock, interestLine, weekLine, lastBook] = await Promise.all([
    buildRetentionProfileBlock(userId).catch(() => ""),
    buildInterestProfileLine(userId).catch(() => ""),
    buildPersonalWeekProfileLine(userId).catch(() => ""),
    getLastBook(userId).catch(() => null),
  ]);

  return (
    `👤 *ملفي الشخصي — ${escMd(name)}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `هذا ملخّص حسابك في رفيق:\n\n` +
    `📥 *الكتب التي حمّلتها (إجمالاً):* ${totalDl}\n` +
    `${streakBlock}\n` +
    `${premBlock}${refBlock}\n\n` +
    (interestLine ? `${interestLine}\n` : "") +
    (weekLine ? `${weekLine}\n` : "") +
    (lastBook ? `🕯 *آخر كتاب:* «${escMd(lastBook)}» · /continue\n` : "") +
    (retentionBlock ? `${retentionBlock}\n\n` : "") +
    `${badgesBlock}\n\n` +
    `*أوامر سريعة:*\n` +
    `◦ /daily — سجّل حضورك اليوم\n` +
    `◦ /myweek — تقرير أسبوعك\n` +
    `◦ /stats — كم تحميلاً يتبقّى لك اليوم\n` +
    `◦ /invite — ادعُ صديقاً`
  );
}

// ── لوحة التحكم الرئيسية ─────────────────────
export async function sendAdminPanel(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const isMaint = await redis.get(MAINTENANCE_KEY).catch(() => null);
    const msg = await buildAdminHomeMessage();
    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
      reply_markup: adminPanelKeyboard(isMaint === "1"),
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
    // مركز التحكم الكامل
    if (await handleControlCallback(bot, chatId, userId, data)) return;

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


      case "admin_health": {
        const text = await buildSystemHealthMessage();
        await bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[
            { text: "🔄 تحديث", callback_data: "admin_health" },
            { text: "🔙 اللوحة", callback_data: "admin_panel" },
          ]]},
        }).catch(() => {});
        break;
      }
      case "admin_audit": {
        const text = await buildAdminAuditMessage(40);
        await bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🔙 اللوحة", callback_data: "admin_panel" }]] },
        }).catch(() => {});
        break;
      }
      case "admin_backup": {
        const text = await buildBackupStatusMessage();
        await bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [
            [{ text: "▶️ تشغيل نسخة الآن", callback_data: "admin_backup_run" }],
            [{ text: "🔄 تحديث القائمة", callback_data: "admin_backup" }],
            [{ text: "🔙 اللوحة", callback_data: "admin_panel" }],
          ]},
        }).catch(() => {});
        break;
      }
      case "admin_backup_run": {
        await bot.sendMessage(chatId, `⏳ *جارٍ تشغيل النسخة الاحتياطية…* قد يستغرق دقيقة.`, { parse_mode: "Markdown" }).catch(() => {});
        const res = await runBackupNow();
        L.adminAction(userId, res.ok ? "backup ok" : "backup fail");
        await bot.sendMessage(chatId,
          (res.ok ? `✅ *اكتملت النسخة*\n\n` : `⚠️ *فشلت النسخة*\n\n`) +
          "```\n" + res.log.slice(0, 1200).replace(/```/g, "") + "\n```",
          { parse_mode: "Markdown" },
        ).catch(() => {});
        const status = await buildBackupStatusMessage();
        await bot.sendMessage(chatId, status, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🔙 اللوحة", callback_data: "admin_panel" }]] },
        }).catch(() => {});
        break;
      }
      case "admin_help_doc": {
        await bot.sendMessage(chatId,
          `📖 *دليل الأدمن — رفيق*\n` +
          `━━━━━━━━━━━━━━━━\n\n` +
          `*المراقبة:*\n` +
          `◦ /admin — اللوحة\n` +
          `◦ بث حي · إحصاءات · Funnel · Retention · صور · أحداث\n` +
          `◦ 🏥 صحة النظام · 📜 سجل التحكم\n\n` +
          `*السيطرة:*\n` +
          `◦ 🎛 مركز التحكم — ميزات ON/OFF · حدود · حظر · Premium\n` +
          `◦ إعلان · صيانة · تفريغ كاش · مجموعات\n` +
          `◦ 💾 نسخ احتياطي يدوي\n\n` +
          `*أوامر نصية:*\n` +
          `◦ /ban ID · /unban ID\n` +
          `◦ /premium_add ID · /premium_remove ID\n` +
          `◦ /set_limit ID N\n\n` +
          `*تنبيهات تلقائية كل 5 دقائق:*\n` +
          `◦ DLQ · نجاح منخفض · Firecrawl · بطء p95 · صور · طابور\n\n` +
          `_كل إجراء مهم يُسجَّل في سجل التحكم._`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔙 اللوحة", callback_data: "admin_panel" }]] },
          },
        ).catch(() => {});
        break;
      }

      case "admin_live": {
        const text = await buildAdminLiveMessage();
        await bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[
            { text: "🔄 تحديث", callback_data: "admin_live" },
            { text: "🔙 لوحة التحكم", callback_data: "admin_panel" },
          ]]},
        }).catch(() => {});
        break;
      }

      case "admin_images": {
        const text = await buildAdminImagesMessage();
        await bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[
            { text: "🔄 تحديث", callback_data: "admin_images" },
            { text: "🔙 لوحة التحكم", callback_data: "admin_panel" },
          ]]},
        }).catch(() => {});
        break;
      }

      case "admin_retention": {
        const text = await buildAdminRetentionMessage();
        await bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🔙 لوحة التحكم", callback_data: "admin_panel" }]] },
        }).catch(() => {});
        break;
      }

      case "admin_month": {
        const text = await buildAdminMonthMessage();
        await bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [
            [{ text: "📤 CSV", callback_data: "admin_export_csv" }],
            [{ text: "🔙 لوحة التحكم", callback_data: "admin_panel" }],
          ]},
        }).catch(() => {});
        break;
      }

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

      // ── Nano Banana (image generation) usage ────────
      case "admin_nano_banana": {
        const stats = await getImageGenStats(10);
        const total = stats.totalSuccess + stats.totalFail;
        const successRate = total > 0
          ? Math.round((stats.totalSuccess / total) * 100)
          : 0;

        const topLines = stats.topUsers.length
          ? stats.topUsers.map((u, i) => {
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}\\.`;
              return `${medal} \`${u.userId}\` — *${u.count}* صورة`;
            }).join("\n")
          : "_لا يوجد استخدام بعد_";

        await bot.sendMessage(chatId,
          `🎨 *Nano Banana — إحصاءات الاستخدام*\n` +
          `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
          `*الإجمالي (مدى الحياة):*\n` +
          `◦ ناجح: *${stats.totalSuccess}*\n` +
          `◦ فاشل: *${stats.totalFail}*\n` +
          `◦ نسبة النجاح: *${successRate}%*\n\n` +
          `*اليوم:*\n` +
          `◦ صور ناجحة: *${stats.todayCount}*\n\n` +
          `*أعلى المستخدمين (Top 10):*\n${topLines}`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[
              { text: "🔙 لوحة التحكم", callback_data: "admin_panel" },
            ]]},
          }
        ).catch(() => {});
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
          // تلقائياً في كل المجموعةات المعروفة. fire-and-forget عشان ما يوقفش
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
  // اعرض كل المصادر الـ canonical المُعرَّفة في `sources.ts` بدون استثناء —
  // حتى لو ما اتجربتش لسه (welib مثلاً)، الأدمن يقدر يفعّل/يعطل من اللوحة
  // بدل ما يضطر يـ SSH في الـ env vars. لو الـ srcStats ضمّ نطاق غير معروف
  // (مثلاً مصدر تاني ظهر من history)، نضمّه برضه في الذيل.
  const known = new Set(ARABIC_SOURCES.map((s) => s.domain));
  const byDomain = new Map(srcStats.map((s) => [s.domain, s]));
  const blank = (domain: string): SourceStat => ({
    domain, ok: 0, fail: 0, mistralRejected: 0,
    total: 0, totalWithRejects: 0,
    successRate: 0, trustRate: 0, rate: "0%",
    autoDisabled: false, hardAutoDisabled: false, trustAutoDisabled: false,
    mistralOnlyAutoDisabled: false,
    manuallyDisabled: false,
  });
  const merged: SourceStat[] = [
    ...ARABIC_SOURCES.map((src) => byDomain.get(src.domain) ?? blank(src.domain)),
    ...srcStats.filter((s) => !known.has(s.domain)),
  ];
  // اقسم لمجموعتين: نشطة (فيها استخدام أو معطّلة يدوياً) في الأعلى،
  // الباقي (0/0/0 وغير معطّل) في الذيل بترتيب الـ priority الأصلي.
  const active = merged.filter((s) => s.total > 0 || s.totalWithRejects > 0 || s.manuallyDisabled);
  const idle   = merged.filter((s) => !(s.total > 0 || s.totalWithRejects > 0 || s.manuallyDisabled));
  active.sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail));
  // top: أهم 13 سطر — نشطة أولاً ثم idle
  const top = [...active, ...idle].slice(0, 16);
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
    else if (s.total === 0 && s.totalWithRejects === 0) badge = "⚪"; // ما اتجربتش لسه
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
    "\n\n_شرح:_ 🟢 جيد · 🟡 متوسط · 🔴 ضعيف · 🟠 منخفض النجاح · 🟣 ضعيف الثقة \\(Mistral\\) · ⛔ catastrophic · 🚫 يدوي · ⚪ ما اتجربش" +
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
