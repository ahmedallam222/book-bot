// ══════════════════════════════════════════════
// PRODUCTION PULSE — لقطة صحة الإنتاج
//
// يجمع: تسليم · فهم العناوين · ملخص · جروب · طابور
// للاستخدام من /ops_pulse ووكيل الأدمن و/ops dashboard.
// ══════════════════════════════════════════════

import { redis } from "./redis.js";
import { cairoDateString } from "./text.js";
import { getDeliveryStats, type DeliveryStatsSnapshot } from "./deliveryMetrics.js";
import { getQueueStats } from "./queue.js";
import { getDailyStats } from "./analytics.js";

async function gint(key: string): Promise<number> {
  try {
    const v = await redis.get(key);
    return parseInt(v || "0", 10) || 0;
  } catch {
    return 0;
  }
}

async function mgetMap(keys: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (keys.length === 0) return out;
  try {
    const vals = await redis.mget(...keys);
    keys.forEach((k, i) => {
      out[k] = parseInt(vals[i] || "0", 10) || 0;
    });
  } catch {
    keys.forEach((k) => {
      out[k] = 0;
    });
  }
  return out;
}

export interface ProductionPulse {
  day: string;
  ts: number;
  healthScore: number; // 0–100
  healthLabel: string;
  delivery: DeliveryStatsSnapshot;
  funnel: {
    requests: number;
    found: number;
    downloads: number;
    cache_hits: number;
    search_success_pct: number | null;
    delivery_success_pct: number | null;
  };
  quality: {
    found_no_send: number;
    force_rescue: number;
    links_only: number;
    junk_skipped: number;
    found_no_send_ratio_pct: number | null;
  };
  smartq: Record<string, number>;
  intent: Record<string, number>;
  summary: Record<string, number>;
  group: Record<string, number>;
  retry: Record<string, number>;
  queue: { pending: number; active: number; dlqSize: number; high: number; normal: number };
  learned_spelling: number;
  alerts: string[];
}

function labelForScore(s: number): string {
  if (s >= 85) return "ممتاز";
  if (s >= 70) return "جيد";
  if (s >= 50) return "متوسط — راقب";
  if (s >= 30) return "ضعيف";
  return "حرج";
}

export async function buildProductionPulse(): Promise<ProductionPulse> {
  const day = cairoDateString();
  const smartKeys = [
    "tel:smartq:local_fixed",
    "tel:smartq:ai_used",
    "tel:smartq:ai_corrected",
    "tel:smartq:ai_fail",
    "tel:smartq:cache_hit",
    "tel:smartq:learned_saved",
    "tel:smartq:learned_hit",
    "tel:smartq:dym_auto_recovered",
    "tel:smartq:retry_recovered",
  ];
  const intentKeys = [
    "tel:intent:fast_path",
    "tel:intent:stripped",
    "tel:intent:author",
    "tel:intent:genre",
    "tel:intent:genre_menu",
    "tel:intent:similar",
  ];
  const sumKeys = [
    "tel:summary:auto_triggered",
    "tel:summary:deep_requested",
    "tel:summary:soft_nudge",
    "tel:summary:firecrawl_used",
  ];
  const grpKeys = [
    "tel:group:free_text_hit",
    "tel:group:embedded_hit",
    "tel:group:reply_context_hit",
    "tel:group:recommend",
    "tel:group:social_reply",
    "tel:group:celebrate",
  ];
  const qKeys = [
    "tel:dl:ok",
    "tel:dl:found_no_send",
    "tel:dl:force_rescue",
    "tel:dl:links_only_message_sent",
    "tel:dl:junk_url_skipped",
    "tel:dl:rescue_augmented",
    "tel:retry:delivered",
  ];

  const [delivery, daily, queue, smart, intent, summary, group, quality, learned] =
    await Promise.all([
      getDeliveryStats(day),
      getDailyStats().catch(
        () =>
          ({
            requests: 0,
            found: 0,
            downloads: 0,
            cache_hits: 0,
          }) as Record<string, number>,
      ),
      getQueueStats().catch(() => ({
        highQueue: 0,
        normalQueue: 0,
        dlqSize: 0,
        totalActiveJobs: 0,
      })),
      mgetMap(smartKeys),
      mgetMap(intentKeys),
      mgetMap(sumKeys),
      mgetMap(grpKeys),
      mgetMap(qKeys),
      redis.hlen("smartq:learned").catch(() => 0),
    ]);

  const requests = Number(daily.requests || 0);
  const found = Number(daily.found || 0);
  const downloads = Number(daily.downloads || 0);
  const cacheHits = Number(daily.cache_hits || 0);

  const pct = (n: number, d: number) =>
    d > 0 ? Math.round((n / d) * 1000) / 10 : null;

  const fns = quality["tel:dl:found_no_send"] || 0;
  const okDl =
    (delivery.outcomes.ok_send || 0) + (delivery.outcomes.ok_cache || 0);
  const fnsRatio =
    okDl + fns > 0 ? Math.round((fns / (okDl + fns)) * 1000) / 10 : null;

  // Health score weighted
  let score = 70;
  const delRate = delivery.successRate;
  if (delivery.samples >= 5) {
    if (delRate >= 80) score += 15;
    else if (delRate >= 65) score += 8;
    else if (delRate >= 50) score += 0;
    else if (delRate >= 35) score -= 15;
    else score -= 30;
  }
  if (fnsRatio != null) {
    if (fnsRatio > 40) score -= 20;
    else if (fnsRatio > 25) score -= 10;
    else if (fnsRatio < 10) score += 5;
  }
  const q = queue as {
    highQueue: number;
    normalQueue: number;
    dlqSize: number;
    totalActiveJobs: number;
  };
  const pendingQ = (q.highQueue || 0) + (q.normalQueue || 0);
  if (q.dlqSize > 20) score -= 10;
  if (pendingQ > 40) score -= 8;
  if (delivery.p95Ms > 120_000 && delivery.samples >= 8) score -= 10;
  if ((smart["tel:smartq:dym_auto_recovered"] || 0) > 0) score += 3;
  if ((quality["tel:retry:delivered"] || 0) > 0) score += 3;
  score = Math.max(0, Math.min(100, score));

  const alerts: string[] = [];
  if (delivery.samples >= 8 && delRate < 50) {
    alerts.push(`نسبة نجاح التسليم منخفضة: ${delRate}%`);
  }
  if (fnsRatio != null && fnsRatio > 30 && fns >= 3) {
    alerts.push(`found_no_send مرتفع: ${fnsRatio}% (${fns} حالة)`);
  }
  if (q.dlqSize > 15) {
    alerts.push(`DLQ: ${q.dlqSize} مهمة`);
  }
  if (delivery.p95Ms > 120_000 && delivery.samples >= 8) {
    alerts.push(`p95 تسليم بطيء: ${(delivery.p95Ms / 1000).toFixed(1)}ث`);
  }

  const strip = (m: Record<string, number>, prefix: string) => {
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) {
      o[k.replace(prefix, "")] = v;
    }
    return o;
  };

  return {
    day,
    ts: Date.now(),
    healthScore: score,
    healthLabel: labelForScore(score),
    delivery,
    funnel: {
      requests,
      found,
      downloads,
      cache_hits: cacheHits,
      search_success_pct: pct(found, requests),
      delivery_success_pct: pct(downloads + cacheHits, requests),
    },
    quality: {
      found_no_send: fns,
      force_rescue: quality["tel:dl:force_rescue"] || 0,
      links_only: quality["tel:dl:links_only_message_sent"] || 0,
      junk_skipped: quality["tel:dl:junk_url_skipped"] || 0,
      found_no_send_ratio_pct: fnsRatio,
    },
    smartq: strip(smart, "tel:smartq:"),
    intent: strip(intent, "tel:intent:"),
    summary: strip(summary, "tel:summary:"),
    group: strip(group, "tel:group:"),
    retry: { delivered: quality["tel:retry:delivered"] || 0 },
    queue: {
      pending: pendingQ,
      active: q.totalActiveJobs || 0,
      dlqSize: q.dlqSize || 0,
      high: q.highQueue || 0,
      normal: q.normalQueue || 0,
    },
    learned_spelling: typeof learned === "number" ? learned : 0,
    alerts,
  };
}

export function formatProductionPulseArabic(p: ProductionPulse): string {
  const d = p.delivery;
  const sec = (ms: number) => (ms / 1000).toFixed(1);
  const lines = [
    `🩺 *نبض الإنتاج — ${p.day}*`,
    `━━━━━━━━━━━━━━━━`,
    `الصحة: *${p.healthScore}/100* — ${p.healthLabel}`,
    ``,
    `*التسليم*`,
    `✅ نجاح: *${d.successRate}%* · عينات ${d.samples}`,
    `⏱ p50 ${sec(d.p50Ms)}ث · p95 ${sec(d.p95Ms)}ث · متوسط ${sec(d.avgMs)}ث`,
    `· كاش ${d.outcomes.ok_cache || 0} · إرسال ${d.outcomes.ok_send || 0}`,
    `· لا نتائج ${d.outcomes.fail_no_results || 0} · وُجد ولم يُرسل ${d.outcomes.fail_found_no_send || 0}`,
    ``,
    `*القمع*`,
    `طلبات ${p.funnel.requests} · وُجد ${p.funnel.found}` +
      (p.funnel.search_success_pct != null
        ? ` (${p.funnel.search_success_pct}%)`
        : ""),
    `تحميلات ${p.funnel.downloads} · كاش ${p.funnel.cache_hits}`,
    ``,
    `*جودة*`,
    `found_no_send ${p.quality.found_no_send}` +
      (p.quality.found_no_send_ratio_pct != null
        ? ` (${p.quality.found_no_send_ratio_pct}%)`
        : ""),
    `إنقاذ ${p.quality.force_rescue} · روابط فقط ${p.quality.links_only} · junk ${p.quality.junk_skipped}`,
    `retry أوصل ${p.retry.delivered}`,
    ``,
    `*فهم العناوين*`,
    `محلي ${p.smartq.local_fixed || 0} · AI ${p.smartq.ai_corrected || 0}/${p.smartq.ai_used || 0}`,
    `تعلّم ${p.learned_spelling} · dym-auto ${p.smartq.dym_auto_recovered || 0}`,
    `fast-path ${p.intent.fast_path || 0} · نوع ${p.intent.genre_menu || 0}`,
    ``,
    `*ملخص / جروب*`,
    `auto ${p.summary.auto_triggered || 0} · deep ${p.summary.deep_requested || 0}`,
    `جروب embed ${p.group.embedded_hit || 0} · رشّح ${p.group.recommend || 0}`,
    ``,
    `*طابور* pending ${p.queue.pending} · active ${p.queue.active} · DLQ ${p.queue.dlqSize}`,
  ];
  if (p.alerts.length) {
    lines.push(``, `⚠️ *تنبيهات*`);
    for (const a of p.alerts) lines.push(`◦ ${a}`);
  }
  lines.push(``, `_/ops_pulse · /ops_delivery_`);
  return lines.join("\n");
}
