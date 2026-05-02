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
