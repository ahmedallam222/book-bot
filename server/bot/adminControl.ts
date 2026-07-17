// ══════════════════════════════════════════════
// ADMIN CONTROL — تحكم كامل من تيليجرام
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { escMd } from "./text.js";
import {
  ALL_FEATS,
  featLabel,
  getAllFeatures,
  setFeature,
  getLimitsSnapshot,
  setLimit,
  clearLimit,
  type FeatName,
  type LimitName,
} from "./featureFlags.js";
import {
  banUser,
  unbanUser,
  bannedList,
  bannedCount,
  isBanned,
} from "./guards.js";
import {
  setPremium,
  isPremium,
  getUserDailyLimit,
  setUserDailyLimit,
  resetUserDailyLimit,
  setUserNote,
  clearUserNote,
  getUserNote,
  premiumCount,
  listPremiumUsers,
} from "./userSettings.js";
import { storage } from "../storage.js";
import { listKnownGroups } from "./groupTracker.js";
import { BOT_ANNOUNCE_KEY, MAINTENANCE_KEY } from "./config.js";

// ── Pending multi-step control ──
type PendingKind =
  | "ban"
  | "unban"
  | "prem_grant"
  | "prem_revoke"
  | "limit"
  | "note"
  | "announce"
  | "limit_global";

const pending = new Map<string, { kind: PendingKind; step: string; meta?: string }>();

export function setAdminPending(adminId: string, kind: PendingKind, step = "await", meta?: string): void {
  pending.set(adminId, { kind, step, meta });
}

export function clearAdminPending(adminId: string): void {
  pending.delete(adminId);
}

export function getAdminPending(adminId: string) {
  return pending.get(adminId);
}

export async function buildControlHubMessage(): Promise<string> {
  const [feats, limits, bans, prems, maint, announce] = await Promise.all([
    getAllFeatures(),
    getLimitsSnapshot(),
    bannedCount(),
    premiumCount(),
    redis.get(MAINTENANCE_KEY).catch(() => null),
    redis.get(BOT_ANNOUNCE_KEY).catch(() => null),
  ]);

  const featLines = ALL_FEATS.map(
    (f) => `◦ ${featLabel(f)}: *${feats[f] ? "🟢 شغال" : "🔴 متوقف"}*`,
  ).join("\n");

  return (
    `🎛 *مركز التحكم — أنت المسيطر*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `🔧 صيانة: *${maint === "1" ? "مفعّلة ⚠️" : "متوقفة ✅"}*\n` +
    `📢 إعلان عام: *${announce ? "موجود" : "لا"}*\n` +
    `🚫 محظورون: *${bans}* · ⭐ Premium: *${prems}*\n\n` +
    `*الميزات:*\n${featLines}\n\n` +
    `*الحدود العامة:*\n` +
    `◦ كتب مجاني: *${limits.daily_free}* (${limits.daily_free_src})\n` +
    `◦ كتب Premium: *${limits.daily_prem}* (${limits.daily_prem_src})\n` +
    `◦ صور مجاني: *${limits.image_free}* (${limits.image_free_src})\n` +
    `◦ صور Premium: *${limits.image_prem}* (${limits.image_prem_src})\n\n` +
    `_اختر إجراءً من الأزرار — أو أرسل ID عند الطلب._`
  );
}

export function kbControlHub(isMaint: boolean): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🧩 الميزات ON/OFF", callback_data: "admin_feats" },
        { text: "📐 الحدود العامة", callback_data: "admin_limits" },
      ],
      [
        { text: "🚫 حظر ID", callback_data: "admin_ban_start" },
        { text: "✅ فك حظر", callback_data: "admin_unban_start" },
      ],
      [
        { text: "⭐ منح Premium", callback_data: "admin_prem_grant" },
        { text: "❌ إلغاء Premium", callback_data: "admin_prem_revoke" },
      ],
      [
        { text: "📥 حد مستخدم", callback_data: "admin_ulimit_start" },
        { text: "📝 ملاحظة مستخدم", callback_data: "admin_note_start" },
      ],
      [
        { text: "📋 قائمة المحظورين", callback_data: "admin_banlist" },
        { text: "⭐ قائمة Premium", callback_data: "admin_premlist" },
      ],
      [
        { text: "📢 وضع إعلان", callback_data: "admin_announce_set" },
        { text: "🗑 مسح إعلان", callback_data: "admin_announce_clear" },
      ],
      [
        {
          text: isMaint ? "✅ إيقاف الصيانة" : "🔧 تفعيل الصيانة",
          callback_data: "admin_toggle_maintenance",
        },
      ],
      [
        { text: "💾 تفريغ كاش بحث", callback_data: "admin_flush_search_cache" },
        { text: "👥 مجموعات معروفة", callback_data: "admin_groups" },
      ],
      [
        { text: "📣 بث جماعي", callback_data: "admin_broadcast" },
        { text: "🏠 لوحة التحكم", callback_data: "admin_panel" },
      ],
    ],
  };
}

export async function buildFeatsMessage(): Promise<string> {
  const feats = await getAllFeatures();
  const lines = ALL_FEATS.map(
    (f) => `${feats[f] ? "🟢" : "🔴"} *${featLabel(f)}*`,
  ).join("\n");
  return (
    `🧩 *الميزات*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `${lines}\n\n` +
    `_اضغط زراً للتبديل فوراً (بدون إعادة تشغيل)._`
  );
}

export function kbFeats(feats: Record<FeatName, boolean>): TelegramBot.InlineKeyboardMarkup {
  const rows = ALL_FEATS.map((f) => [
    {
      text: `${feats[f] ? "🟢" : "🔴"} ${featLabel(f).slice(0, 28)}`,
      callback_data: `admin_feat:${f}`,
    },
  ]);
  rows.push([
    { text: "🔙 مركز التحكم", callback_data: "admin_control" },
    { text: "🏠 اللوحة", callback_data: "admin_panel" },
  ]);
  return { inline_keyboard: rows };
}

export async function buildLimitsMessage(): Promise<string> {
  const L = await getLimitsSnapshot();
  return (
    `📐 *الحدود العامة*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `◦ كتب/يوم مجاني: *${L.daily_free}* _(${L.daily_free_src})_\n` +
    `◦ كتب/يوم Premium: *${L.daily_prem}* _(${L.daily_prem_src})_\n` +
    `◦ صور/يوم مجاني: *${L.image_free}* _(${L.image_free_src})_\n` +
    `◦ صور/يوم Premium: *${L.image_prem}* _(${L.image_prem_src})_\n\n` +
    `_اضغط لتعديل · «إعادة للافتراضي» يمسح تجاوز الأدمن._`
  );
}

export function kbLimits(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "كتب مجاني", callback_data: "admin_lim:daily_free" },
        { text: "كتب Prem", callback_data: "admin_lim:daily_prem" },
      ],
      [
        { text: "صور مجاني", callback_data: "admin_lim:image_free" },
        { text: "صور Prem", callback_data: "admin_lim:image_prem" },
      ],
      [
        { text: "♻ كتب مجاني افتراضي", callback_data: "admin_limclr:daily_free" },
        { text: "♻ كتب Prem افتراضي", callback_data: "admin_limclr:daily_prem" },
      ],
      [
        { text: "♻ صور مجاني", callback_data: "admin_limclr:image_free" },
        { text: "♻ صور Prem", callback_data: "admin_limclr:image_prem" },
      ],
      [
        { text: "🔙 مركز التحكم", callback_data: "admin_control" },
      ],
    ],
  };
}

export async function handleControlCallback(
  bot: TelegramBot,
  chatId: number,
  adminId: string,
  data: string,
): Promise<boolean> {
  // returns true if handled
  if (data === "admin_control") {
    const isMaint = (await redis.get(MAINTENANCE_KEY).catch(() => null)) === "1";
    await bot.sendMessage(chatId, await buildControlHubMessage(), {
      parse_mode: "Markdown",
      reply_markup: kbControlHub(isMaint),
    });
    return true;
  }

  if (data === "admin_feats") {
    const feats = await getAllFeatures();
    await bot.sendMessage(chatId, await buildFeatsMessage(), {
      parse_mode: "Markdown",
      reply_markup: kbFeats(feats),
    });
    return true;
  }

  if (data.startsWith("admin_feat:")) {
    const name = data.slice("admin_feat:".length) as FeatName;
    if (!ALL_FEATS.includes(name)) return true;
    const feats = await getAllFeatures();
    await setFeature(name, !feats[name]);
    L.adminAction(adminId, `feat ${name} → ${!feats[name]}`);
    const next = await getAllFeatures();
    await bot.sendMessage(chatId, await buildFeatsMessage(), {
      parse_mode: "Markdown",
      reply_markup: kbFeats(next),
    });
    return true;
  }

  if (data === "admin_limits") {
    await bot.sendMessage(chatId, await buildLimitsMessage(), {
      parse_mode: "Markdown",
      reply_markup: kbLimits(),
    });
    return true;
  }

  if (data.startsWith("admin_lim:")) {
    const name = data.slice("admin_lim:".length);
    setAdminPending(adminId, "limit_global", "await", name);
    await bot.sendMessage(
      chatId,
      `📐 أرسل الرقم الجديد لـ \`${escMd(name)}\`\n_مثال: 10_`,
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (data.startsWith("admin_limclr:")) {
    const name = data.slice("admin_limclr:".length) as LimitName;
    await clearLimit(name);
    L.adminAction(adminId, `clear limit ${name}`);
    await bot.sendMessage(chatId, `✅ أُعيد \`${escMd(name)}\` للافتراضي.`, {
      parse_mode: "Markdown",
      reply_markup: kbLimits(),
    });
    return true;
  }

  if (data === "admin_ban_start") {
    setAdminPending(adminId, "ban");
    await bot.sendMessage(chatId, `🚫 أرسل *Telegram ID* للحظر:`, { parse_mode: "Markdown" });
    return true;
  }
  if (data === "admin_unban_start") {
    setAdminPending(adminId, "unban");
    await bot.sendMessage(chatId, `✅ أرسل *Telegram ID* لفك الحظر:`, { parse_mode: "Markdown" });
    return true;
  }
  if (data === "admin_prem_grant") {
    setAdminPending(adminId, "prem_grant");
    await bot.sendMessage(
      chatId,
      `⭐ أرسل: \`ID\` أو \`ID أيام\`\nمثال: \`123456789\` أو \`123456789 30\``,
      { parse_mode: "Markdown" },
    );
    return true;
  }
  if (data === "admin_prem_revoke") {
    setAdminPending(adminId, "prem_revoke");
    await bot.sendMessage(chatId, `❌ أرسل ID لإلغاء Premium:`, { parse_mode: "Markdown" });
    return true;
  }
  if (data === "admin_ulimit_start") {
    setAdminPending(adminId, "limit");
    await bot.sendMessage(
      chatId,
      `📥 أرسل: \`ID الحد\`\nمثال: \`123456789 20\` · 0 = غير محدود تقريباً`,
      { parse_mode: "Markdown" },
    );
    return true;
  }
  if (data === "admin_note_start") {
    setAdminPending(adminId, "note");
    await bot.sendMessage(
      chatId,
      `📝 أرسل: \`ID النص\`\nلحذف الملاحظة: \`ID clear\``,
      { parse_mode: "Markdown" },
    );
    return true;
  }
  if (data === "admin_announce_set") {
    setAdminPending(adminId, "announce");
    await bot.sendMessage(chatId, `📢 أرسل نص الإعلان العام (يظهر للمستخدمين):`);
    return true;
  }
  if (data === "admin_announce_clear") {
    await redis.del(BOT_ANNOUNCE_KEY);
    L.adminAction(adminId, "announce cleared");
    await bot.sendMessage(chatId, `✅ تم مسح الإعلان العام.`);
    return true;
  }

  if (data === "admin_banlist") {
    const list = await bannedList();
    const body =
      list.length === 0
        ? "_لا محظورين_"
        : list
            .slice(0, 40)
            .map((id, i) => `${i + 1}. \`${id}\``)
            .join("\n");
    await bot.sendMessage(
      chatId,
      `🚫 *المحظورون* (${list.length})\n━━━━━━━━━━━━━━━━\n\n${body}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 مركز التحكم", callback_data: "admin_control" }]],
        },
      },
    );
    return true;
  }

  if (data === "admin_premlist") {
    const list = await listPremiumUsers();
    const body =
      list.length === 0
        ? "_لا Premium_"
        : list
            .slice(0, 40)
            .map((id, i) => `${i + 1}. \`${id}\``)
            .join("\n");
    await bot.sendMessage(
      chatId,
      `⭐ *Premium* (${list.length})\n━━━━━━━━━━━━━━━━\n\n${body}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 مركز التحكم", callback_data: "admin_control" }]],
        },
      },
    );
    return true;
  }

  if (data === "admin_groups") {
    const groups = await listKnownGroups();
    const body =
      groups.length === 0
        ? "_لا مجموعات مسجّلة_"
        : groups
            .slice(0, 30)
            .map((g, i) => {
              const title = escMd((g.title || "بدون عنوان").slice(0, 30));
              return `${i + 1}. \`${g.chatId}\` — ${title}`;
            })
            .join("\n");
    await bot.sendMessage(
      chatId,
      `👥 *المجموعات المعروفة* (${groups.length})\n━━━━━━━━━━━━━━━━\n\n${body}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 مركز التحكم", callback_data: "admin_control" }]],
        },
      },
    );
    return true;
  }

  if (data === "admin_flush_search_cache") {
    // best-effort: delete search cache keys
    try {
      let cursor = "0";
      let n = 0;
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", "search:*", "COUNT", 100);
        cursor = next;
        if (keys.length) {
          await redis.del(...keys);
          n += keys.length;
        }
      } while (cursor !== "0" && n < 2000);
      L.adminAction(adminId, `flush search cache ~${n}`);
      await bot.sendMessage(chatId, `✅ تم حذف حوالي *${n}* مفتاح كاش بحث.`, {
        parse_mode: "Markdown",
      });
    } catch (e) {
      await bot.sendMessage(chatId, `⚠️ فشل التفريغ: ${String(e).slice(0, 80)}`);
    }
    return true;
  }

  // per-user quick actions from user card
  if (data.startsWith("admin_ban_id:")) {
    const id = data.slice("admin_ban_id:".length);
    await banUser(id);
    L.adminAction(adminId, `ban ${id}`);
    await bot.sendMessage(chatId, `🚫 حُظر \`${id}\``, { parse_mode: "Markdown" });
    return true;
  }
  if (data.startsWith("admin_unban_id:")) {
    const id = data.slice("admin_unban_id:".length);
    await unbanUser(id);
    L.adminAction(adminId, `unban ${id}`);
    await bot.sendMessage(chatId, `✅ فُك حظر \`${id}\``, { parse_mode: "Markdown" });
    return true;
  }
  if (data.startsWith("admin_ulimit_id:")) {
    const id = data.slice("admin_ulimit_id:".length);
    setAdminPending(adminId, "limit", "await", id);
    await bot.sendMessage(chatId, `📥 أرسل الحد الرقمي لـ \`${id}\`:`, { parse_mode: "Markdown" });
    return true;
  }

  return false;
}

export async function handleControlPendingText(
  bot: TelegramBot,
  chatId: number,
  adminId: string,
  text: string,
): Promise<boolean> {
  const p = getAdminPending(adminId);
  if (!p) return false;

  const isValidId = (id: string) => /^\d{5,15}$/.test(id);

  try {
    if (p.kind === "ban") {
      clearAdminPending(adminId);
      const id = text.trim();
      if (!isValidId(id)) {
        await bot.sendMessage(chatId, "❌ ID غير صالح");
        return true;
      }
      await banUser(id);
      L.adminAction(adminId, `ban ${id}`);
      await bot.sendMessage(chatId, `🚫 تم حظر \`${id}\``, { parse_mode: "Markdown" });
      return true;
    }
    if (p.kind === "unban") {
      clearAdminPending(adminId);
      const id = text.trim();
      if (!isValidId(id)) {
        await bot.sendMessage(chatId, "❌ ID غير صالح");
        return true;
      }
      await unbanUser(id);
      L.adminAction(adminId, `unban ${id}`);
      await bot.sendMessage(chatId, `✅ فُك حظر \`${id}\``, { parse_mode: "Markdown" });
      return true;
    }
    if (p.kind === "prem_grant") {
      clearAdminPending(adminId);
      const parts = text.trim().split(/\s+/);
      const id = parts[0];
      const days = parts[1] ? parseInt(parts[1], 10) : 0;
      if (!isValidId(id)) {
        await bot.sendMessage(chatId, "❌ ID غير صالح");
        return true;
      }
      await setPremium(id, true, Number.isFinite(days) ? days : 0, {
        by: adminId,
        source: "telegram-cmd",
      });
      L.adminAction(adminId, `prem grant ${id} days=${days || "manual"}`);
      await bot.sendMessage(
        chatId,
        `⭐ Premium لـ \`${id}\`${days > 0 ? ` · ${days} يوم` : " · دائم"}`,
        { parse_mode: "Markdown" },
      );
      return true;
    }
    if (p.kind === "prem_revoke") {
      clearAdminPending(adminId);
      const id = text.trim();
      if (!isValidId(id)) {
        await bot.sendMessage(chatId, "❌ ID غير صالح");
        return true;
      }
      await setPremium(id, false, 0, { by: adminId, source: "telegram-cmd" });
      L.adminAction(adminId, `prem revoke ${id}`);
      await bot.sendMessage(chatId, `✅ أُلغي Premium من \`${id}\``, { parse_mode: "Markdown" });
      return true;
    }
    if (p.kind === "limit") {
      clearAdminPending(adminId);
      // meta may hold id, or "id limit" in text
      let id = p.meta || "";
      let lim = 0;
      if (id && isValidId(id)) {
        lim = parseInt(text.trim(), 10);
      } else {
        const parts = text.trim().split(/\s+/);
        id = parts[0];
        lim = parseInt(parts[1] || "", 10);
      }
      if (!isValidId(id) || !Number.isFinite(lim) || lim < 0) {
        await bot.sendMessage(chatId, "❌ الصيغة: ID ثم الحد");
        return true;
      }
      if (lim === 0) {
        await setUserDailyLimit(id, 0);
      } else {
        await setUserDailyLimit(id, lim);
      }
      L.adminAction(adminId, `ulimit ${id}=${lim}`);
      await bot.sendMessage(chatId, `✅ حد \`${id}\` = *${lim <= 0 ? "∞" : lim}*`, {
        parse_mode: "Markdown",
      });
      return true;
    }
    if (p.kind === "note") {
      clearAdminPending(adminId);
      const parts = text.trim().split(/\s+/);
      const id = parts[0];
      const note = parts.slice(1).join(" ");
      if (!isValidId(id)) {
        await bot.sendMessage(chatId, "❌ ID غير صالح");
        return true;
      }
      if (!note || note === "clear") {
        await clearUserNote(id);
        await bot.sendMessage(chatId, `✅ مُسحت ملاحظة \`${id}\``, { parse_mode: "Markdown" });
      } else {
        await setUserNote(id, note.slice(0, 500));
        await bot.sendMessage(chatId, `✅ ملاحظة \`${id}\` حُفظت`, { parse_mode: "Markdown" });
      }
      L.adminAction(adminId, `note ${id}`);
      return true;
    }
    if (p.kind === "announce") {
      clearAdminPending(adminId);
      await redis.set(BOT_ANNOUNCE_KEY, text.slice(0, 1000));
      L.adminAction(adminId, "announce set");
      await bot.sendMessage(chatId, `✅ الإعلان العام حُفظ.`);
      return true;
    }
    if (p.kind === "limit_global") {
      clearAdminPending(adminId);
      const name = (p.meta || "") as LimitName;
      const n = parseInt(text.trim(), 10);
      if (!name || !Number.isFinite(n) || n < 0) {
        await bot.sendMessage(chatId, "❌ رقم غير صالح");
        return true;
      }
      await setLimit(name, n);
      L.adminAction(adminId, `global limit ${name}=${n}`);
      await bot.sendMessage(chatId, await buildLimitsMessage(), {
        parse_mode: "Markdown",
        reply_markup: kbLimits(),
      });
      return true;
    }
  } catch (e) {
    clearAdminPending(adminId);
    await bot.sendMessage(chatId, `⚠️ خطأ: ${String(e).slice(0, 100)}`);
    return true;
  }

  return false;
}

/** أزرار إضافية لبطاقة المستخدم */
export function kbUserControl(targetId: string, prem: boolean, banned: boolean): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: prem ? "❌ إلغاء Premium" : "⭐ منح Premium",
          callback_data: `admin_user_prem:${targetId}`,
        },
      ],
      [
        {
          text: banned ? "✅ فك الحظر" : "🚫 حظر",
          callback_data: banned ? `admin_unban_id:${targetId}` : `admin_ban_id:${targetId}`,
        },
        { text: "📥 حد يومي", callback_data: `admin_ulimit_id:${targetId}` },
      ],
      [
        { text: "🔍 مستخدم آخر", callback_data: "admin_user_search" },
        { text: "🔙 المستخدمون", callback_data: "admin_users_0" },
      ],
      [{ text: "🎛 مركز التحكم", callback_data: "admin_control" }],
    ],
  };
}
