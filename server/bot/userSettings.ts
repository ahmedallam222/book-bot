import { redis } from "./redis.js";
import { PREMIUM_SET_KEY, USER_LIMIT_KEY, DAILY_LIMIT, PREMIUM_LIMIT } from "./config.js";

// ══════════════════════════════════════════════
// USER SETTINGS — إعدادات لكل مستخدم (Redis)
// ══════════════════════════════════════════════

// ── Premium ───────────────────────────────────

export async function isPremium(userId: string): Promise<boolean> {
  return (await redis.sismember(PREMIUM_SET_KEY, userId).catch(() => 0)) === 1;
}

export async function setPremium(userId: string, value: boolean): Promise<void> {
  if (value) {
    await redis.sadd(PREMIUM_SET_KEY, userId);
  } else {
    await redis.srem(PREMIUM_SET_KEY, userId);
    // حذف limit override لو وُجد
    await redis.del(USER_LIMIT_KEY(userId)).catch(() => {});
  }
}

export async function listPremiumUsers(): Promise<string[]> {
  return redis.smembers(PREMIUM_SET_KEY).catch(() => [] as string[]);
}

export async function premiumCount(): Promise<number> {
  return redis.scard(PREMIUM_SET_KEY).catch(() => 0);
}

// ── Daily limit ───────────────────────────────

/**
 * getUserDailyLimit
 * ─────────────────
 * يُعيد الحد اليومي للمستخدم بأولوية:
 *  1. override مخصّص من الأدمن (ulimit:{userId})
 *  2. PREMIUM_LIMIT للمميّزين
 *  3. DAILY_LIMIT للعاديين
 *  4. إذا كان 0 أو سالب → حد غير محدود (∞)
 */
export async function getUserDailyLimit(userId: string): Promise<number> {
  try {
    const [overrideRaw, isPrem] = await Promise.all([
      redis.get(USER_LIMIT_KEY(userId)),
      redis.sismember(PREMIUM_SET_KEY, userId),
    ]);
    if (overrideRaw !== null) {
      const val = parseInt(overrideRaw, 10);
      // 0 = غير محدود
      return isNaN(val) ? DAILY_LIMIT : val <= 0 ? 0 : val;
    }
    return isPrem === 1 ? PREMIUM_LIMIT : DAILY_LIMIT;
  } catch {
    return DAILY_LIMIT;
  }
}

export async function setUserDailyLimit(userId: string, limit: number): Promise<void> {
  // TTL 90 يوم — يتجدد إذا غيّره الأدمن
  await redis.setex(USER_LIMIT_KEY(userId), 90 * 24 * 3600, String(limit));
}

export async function resetUserDailyLimit(userId: string): Promise<void> {
  await redis.del(USER_LIMIT_KEY(userId));
}

// ── User notes ────────────────────────────────

const NOTE_KEY = (uid: string) => `unote:${uid}`;

export async function getUserNote(userId: string): Promise<string | null> {
  return redis.get(NOTE_KEY(userId)).catch(() => null);
}

export async function setUserNote(userId: string, note: string): Promise<void> {
  // ملاحظة تنتهي بعد 30 يوم تلقائياً
  await redis.setex(NOTE_KEY(userId), 30 * 24 * 3600, note);
}

export async function clearUserNote(userId: string): Promise<void> {
  await redis.del(NOTE_KEY(userId));
}
