import Redis from "ioredis";

// ══════════════════════════════════════════════
// REDIS CLIENT — single shared instance
// ══════════════════════════════════════════════

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  throw new Error(
    "❌ REDIS_URL environment variable is required.\n" +
    "   Example: REDIS_URL=redis://localhost:6379"
  );
}

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => {
    // بعد 20 محاولة (~60 ثانية) → توقف ودع Node يخرج أو يُعيد التشغيل
    if (times > 20) return null;
    return Math.min(times * 100, 3000);
  },
  lazyConnect: false,
});

redis.on("error", (err: Error) => {
  console.error(`[Redis] ❌ ${err.message}`);
});

redis.on("connect", () => {
  console.log("[Redis] ✅ Connected");
});

redis.on("reconnecting", () => {
  console.warn("[Redis] 🔄 Reconnecting...");
});
