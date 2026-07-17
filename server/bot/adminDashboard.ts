// ══════════════════════════════════════════════
// ADMIN DASHBOARD — لقطة شاملة لكل مقاييس رفيق
// ══════════════════════════════════════════════

import { redis } from "./redis.js";
import { cairoDateString, escMd } from "./text.js";
import { getDailyStats, getTotalStats, getWeeklyStats, getFunnelStats, getTopBooks } from "./analytics.js";
import { getImageGenStats } from "./imageGen.js";
import { getDeliveryStats, formatDeliveryStatsArabic } from "./deliveryMetrics.js";
import { getQueueStats } from "./queue.js";
import { storage } from "../storage.js";
import { listKnownGroups } from "./groupTracker.js";
import { getPdfValidationStats } from "./pdfValidator.js";
import { blacklistStats } from "./blacklist.js";
import { MAINTENANCE_KEY, BOT_ANNOUNCE_KEY } from "./config.js";

async function safeInt(key: string): Promise<number> {
  try {
    return parseInt((await redis.get(key)) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

async function activeUsers(hours: number): Promise<number> {
  try {
    const since = Date.now() - hours * 3600_000;
    return await redis.zcount("user:lastSeen", since, "+inf");
  } catch {
    return 0;
  }
}

function monthPrefixCairo(): string {
  // YYYY-MM from cairo date
  return cairoDateString().slice(0, 7);
}

export async function buildAdminHomeMessage(): Promise<string> {
  const day = cairoDateString();
  const [
    today,
    total,
    qs,
    dbStats,
    img,
    delivery,
    a24,
    a7,
    isMaint,
    announce,
    bl,
    pdf,
    groups,
    retDaily,
    retQuest,
    retMorning,
    retEvening,
    retWeek,
    retComback,
    imgTodayFail,
  ] = await Promise.all([
    getDailyStats(),
    getTotalStats(),
    getQueueStats(),
    storage.getStats(),
    getImageGenStats(5),
    getDeliveryStats(day),
    activeUsers(24),
    activeUsers(24 * 7),
    redis.get(MAINTENANCE_KEY).catch(() => null),
    redis.get(BOT_ANNOUNCE_KEY).catch(() => null),
    blacklistStats(),
    getPdfValidationStats(),
    listKnownGroups(),
    safeInt("tel:retention:daily_claim"),
    safeInt("tel:retention:quest_complete"),
    safeInt("tel:retention:morning_note"),
    safeInt("tel:retention:evening_note"),
    safeInt("tel:retention:week_report"),
    safeInt("tel:retention:comeback"),
    safeInt("tel:imageGen:fail"),
  ]);

  const successRate =
    (today.requests ?? 0) > 0
      ? Math.round(((today.found ?? 0) / (today.requests ?? 1)) * 100)
      : 0;

  const imgTotal = img.totalSuccess + img.totalFail;
  const imgRate = imgTotal > 0 ? Math.round((img.totalSuccess / imgTotal) * 100) : 0;

  return (
    `🔧 *لوحة رفيق — نظرة شاملة*\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `📅 ${escMd(day)}\n\n` +

    `👥 *النشاط*\n` +
    `◦ نشط 24س: *${a24}* · 7 أيام: *${a7}*\n` +
    `◦ مستخدمون مسجّلون: *${dbStats.totalUsers}*\n` +
    `◦ مجموعات معروفة: *${groups.length}*\n\n` +

    `📥 *اليوم — كتب*\n` +
    `◦ طلبات: *${today.requests ?? 0}* · نجح: *${today.found ?? 0}* (${successRate}%)\n` +
    `◦ تحميل حقيقي: *${today.downloads ?? 0}* · كاش: *${today.cache_hits ?? 0}*\n` +
    `◦ تسليم: نجاح *${delivery.successRate}%* · p50 *${(delivery.p50Ms / 1000).toFixed(1)}ث*\n\n` +

    `🎨 *الصور (AI)*\n` +
    `◦ اليوم: *${img.todayCount}* ناجحة\n` +
    `◦ كل الوقت: ✅*${img.totalSuccess}* · ❌*${img.totalFail}* (${imgRate}%)\n\n` +

    `🔥 *Retention (عدادات)*\n` +
    `◦ حضور يومي: *${retDaily}* · مهام: *${retQuest}*\n` +
    `◦ صباح: *${retMorning}* · مساء: *${retEvening}*\n` +
    `◦ تقارير أحد: *${retWeek}* · عودة: *${retComback}*\n\n` +

    `📋 *الطابور:* H*${qs.highQueue}* N*${qs.normalQueue}* DLQ*${qs.dlqSize}* نشط*${qs.totalActiveJobs}*\n` +
    `🛡️ PDF: قبول *${pdf.accepted}* · رفض *${pdf.rejected}* (${pdf.rejectionRate})\n` +
    `🚫 Blacklist: *${bl.total}*\n` +
    `📈 إجمالي تحميلات: *${total.downloads ?? 0}* · بحث: *${total.searches ?? 0}*\n\n` +

    `📢 إعلان: ${announce ? "نعم" : "لا"} · 🔧 صيانة: ${isMaint === "1" ? "مفعّلة ⚠️" : "متوقف ✅"}\n\n` +
    `_اختر قسماً للتفاصيل الكاملة 👇_`
  );
}

export async function buildAdminLiveMessage(): Promise<string> {
  const day = cairoDateString();
  const [delivery, funnel, img, a1, a24] = await Promise.all([
    getDeliveryStats(day),
    getFunnelStats(),
    getImageGenStats(8),
    activeUsers(1),
    activeUsers(24),
  ]);

  const topImg = img.topUsers.length
    ? img.topUsers
        .map((u, i) => `${i + 1}. \`${u.userId}\` — *${u.count}*`)
        .join("\n")
    : "_لا صور بعد_";

  return (
    `⚡ *البث الحي — الآن*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `👥 نشط آخر ساعة: *${a1}* · 24س: *${a24}*\n\n` +
    formatDeliveryStatsArabic(delivery) +
    `\n\n🔭 *Funnel اليوم*\n` +
    `◦ طلبات: *${funnel.total ?? 0}*\n` +
    `◦ وُجد: *${funnel.search_found ?? 0}*\n` +
    `◦ أُرسل: *${funnel.send_success ?? 0}*\n` +
    `◦ Direct/Local: *${funnel.send_direct ?? 0}* / *${funnel.send_local ?? 0}*\n\n` +
    `🎨 *صور اليوم:* *${img.todayCount}*\n` +
    `*أعلى مولّدي الصور:*\n${topImg}`
  );
}

export async function buildAdminRetentionMessage(): Promise<string> {
  const keys = [
    ["tel:retention:daily_claim", "حضور /daily"],
    ["tel:retention:quest_complete", "إتمام لفتة"],
    ["tel:retention:morning_note", "رسائل صباح"],
    ["tel:retention:evening_note", "رسائل مساء"],
    ["tel:retention:week_report", "تقارير أحد"],
    ["tel:retention:comeback", "مكافآت عودة"],
    ["tel:retention:level_up", "ترقيات مستوى"],
    ["tel:retention:shield_used", "دروع سلسلة"],
    ["tel:retention:quest_complete", "مهام"],
    ["tel:group:club_post", "منشورات نادي"],
    ["tel:group:free_text_hit", "نص حر جروب"],
    ["tel:group:rate_limited", "حد معدل جروب"],
    ["tel:group:welcome_sent", "ترحيب جروب"],
    ["tel:group:soft_not_book", "توجيه «مش كتاب»"],
  ] as const;

  const vals = await Promise.all(keys.map(([k]) => safeInt(k)));
  const lines = keys.map(([, label], i) => `◦ ${label}: *${vals[i]}*`).join("\n");

  return (
    `🔥 *Retention والجروبات — عدادات*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `${lines}\n\n` +
    `_عدادات تراكمية منذ تفعيل المقاييس (Redis)._`
  );
}

export async function buildAdminMonthMessage(): Promise<string> {
  const month = monthPrefixCairo();
  // Aggregate last ~30 daily stats keys by scanning week data + totals
  const week = await getWeeklyStats();
  let req = 0,
    found = 0,
    dl = 0,
    cache = 0;
  const dayLines: string[] = [];
  for (const [day, s] of Object.entries(week)) {
    req += s.requests ?? 0;
    found += s.found ?? 0;
    dl += s.downloads ?? 0;
    cache += s.cache_hits ?? 0;
    dayLines.push(
      `◦ ${day}: ط*${s.requests ?? 0}* ن*${s.found ?? 0}* ت*${s.downloads ?? 0}*`,
    );
  }

  // Image: sum last 7 days daily totals if keys exist
  let imgWeek = 0;
  try {
    const days: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      // use cairo-ish: just try last 14 ISO dates from cairoDateString offset
    }
  } catch { /* */ }

  // Better: read img:daily:total:{date} for last 14 cairo days via redis
  const imgCounts: number[] = [];
  try {
    const { cairoDateString: cds } = await import("./text.js");
    for (let i = 0; i < 14; i++) {
      const dt = new Date(Date.now() - i * 86400_000);
      // approximate date string
      const iso = dt.toISOString().slice(0, 10);
      const n = await safeInt(`img:daily:total:${iso}`);
      // also try cairo if different - getImageGenStats uses cairoDateString
      imgCounts.push(n);
    }
    // cairo dates
    for (let i = 0; i < 14; i++) {
      // use redis keys pattern - already have safeInt on iso
    }
  } catch { /* */ }

  // Use cairo properly
  let img14 = 0;
  try {
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      // Cairo offset UTC+2/+3 approximate: use redis keys from getImageGenStats style
      const keyDate = new Date(Date.now() - i * 86400000);
      const y = keyDate.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
      img14 += await safeInt(`img:daily:total:${y}`);
    }
  } catch {
    img14 = (await getImageGenStats()).todayCount;
  }

  const [total, imgAll, top, a7, groups] = await Promise.all([
    getTotalStats(),
    getImageGenStats(5),
    getTopBooks(10),
    activeUsers(24 * 7),
    listKnownGroups(),
  ]);

  const topLines = top
    .slice(0, 8)
    .map((b, i) => `${i + 1}. ${escMd(b.book.slice(0, 40))} *(${b.count})*`)
    .join("\n");

  const rate = req > 0 ? Math.round((found / req) * 100) : 0;

  return (
    `📅 *أحداث ومؤشرات — ${escMd(month)}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `*آخر ~7 أيام (stats يومية):*\n` +
    `◦ طلبات: *${req}* · نجاح بحث: *${found}* (${rate}%)\n` +
    `◦ تحميلات: *${dl}* · كاش: *${cache}*\n` +
    `${dayLines.join("\n") || "_لا بيانات يومية_"}\n\n` +
    `*صور AI (آخر ~30 يوم cairo keys):* *${img14}*\n` +
    `*صور كل الوقت:* ✅${imgAll.totalSuccess} ❌${imgAll.totalFail}\n\n` +
    `*المجتمع:*\n` +
    `◦ نشط 7 أيام: *${a7}*\n` +
    `◦ مجموعات: *${groups.length}*\n` +
    `◦ إجمالي تحميلات النظام: *${total.downloads ?? 0}*\n\n` +
    `*أكثر الكتب (كل الوقت):*\n${topLines || "_—_"}\n\n` +
    `_للتصدير: زر CSV من الإحصاءات._`
  );
}

export async function buildAdminImagesMessage(): Promise<string> {
  const stats = await getImageGenStats(15);
  const total = stats.totalSuccess + stats.totalFail;
  const rate = total > 0 ? Math.round((stats.totalSuccess / total) * 100) : 0;
  const top = stats.topUsers.length
    ? stats.topUsers
        .map((u, i) => {
          const m = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
          return `${m} \`${u.userId}\` — *${u.count}* صورة`;
        })
        .join("\n")
    : "_لا استخدام_";

  // provider-ish counters if any
  const [flux, nano, gem] = await Promise.all([
    safeInt("tel:imageGen:provider:flux"),
    safeInt("tel:imageGen:provider:nano"),
    safeInt("tel:imageGen:provider:gemini"),
  ]);

  return (
    `🎨 *توليد الصور — تفاصيل كاملة*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `*اليوم:* *${stats.todayCount}* صورة ناجحة\n\n` +
    `*مدى الحياة:*\n` +
    `◦ نجاح: *${stats.totalSuccess}*\n` +
    `◦ فشل: *${stats.totalFail}*\n` +
    `◦ نسبة النجاح: *${rate}%*\n\n` +
    (flux + nano + gem > 0
      ? `*حسب المزود (إن وُجدت عدادات):*\n◦ Flux: ${flux} · Nano: ${nano} · Gemini: ${gem}\n\n`
      : "") +
    `*أعلى 15 مستخدماً:*\n${top}`
  );
}

export function adminPanelKeyboard(isMaint: boolean): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "⚡ بث حي", callback_data: "admin_live" },
        { text: "📊 إحصاءات", callback_data: "admin_stats" },
      ],
      [
        { text: "🎨 الصور", callback_data: "admin_images" },
        { text: "📅 أحداث الشهر", callback_data: "admin_month" },
      ],
      [
        { text: "🔥 Retention", callback_data: "admin_retention" },
        { text: "🔭 Funnel", callback_data: "admin_funnel" },
      ],
      [
        { text: "📋 الطابور", callback_data: "admin_queue" },
        { text: "📡 المصادر", callback_data: "admin_sources" },
      ],
      [
        { text: "👥 مستخدمون", callback_data: "admin_users_0" },
        { text: "🏆 كتب", callback_data: "admin_top" },
      ],
      [
        { text: "💾 كاش", callback_data: "admin_cache" },
        { text: "🚫 Blacklist", callback_data: "admin_blacklist" },
      ],
      [
        { text: "🖼 نانو (قديم)", callback_data: "admin_nano_banana" },
        { text: "📤 CSV", callback_data: "admin_export_csv" },
      ],
      [
        {
          text: isMaint ? "✅ إيقاف الصيانة" : "🔧 تفعيل الصيانة",
          callback_data: "admin_toggle_maintenance",
        },
      ],
      [
        { text: "📢 بث جماعي", callback_data: "admin_broadcast" },
        { text: "🗑️ مسح DLQ", callback_data: "admin_clear_dlq" },
      ],
    ],
  };
}
