import Redis from "ioredis";

// ══════════════════════════════════════════════
// REDIS — singleton client
// ══════════════════════════════════════════════

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck:     true,
  lazyConnect:          false,
});

redis.on("error",   (err) => console.error("[Redis] error:", err.message));
redis.on("connect", ()    => console.log("[Redis] connected"));

// ══════════════════════════════════════════════
// scanKeys — non-blocking replacement for KEYS
//
// SCAN يكرّر بالـ cursor ويرجع batches صغيرة بدون lock للسيرفر. الـ
// `KEYS pattern` كانت تستخدم في hot paths (analytics getSourceStats /
// getManualDisabledSourceDomains) ومُستدعاة من كل طلب بحث في
// engine.searchAllSources قبل cache check. على Redis بآلاف الـ keys
// (cache entries, daily limits, sessions، إلخ) كانت كل KEYS تأخذ ms
// كثيرة وتمنع باقي الأوامر — وأضافت latency على كل بحث.
// COUNT=200 توازن: round-trips أقل من الافتراضي (10) وما زال غير حاجب.
// ══════════════════════════════════════════════
export async function scanKeys(pattern: string, batchSize = 200): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", batchSize);
    cursor = next;
    if (batch.length) out.push(...batch);
  } while (cursor !== "0");
  return out;
}
