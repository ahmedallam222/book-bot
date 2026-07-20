// ══════════════════════════════════════════════
// FEATURE FLAGS + RUNTIME LIMITS (Admin-controlled)
//
// Redis:
//   flag:feat:{name}   = "0" | "1"   (default 1 = on)
//   flag:limit:{name}  = number string (override; empty = env default)
// ══════════════════════════════════════════════

import { redis } from "./redis.js";
import {
  DAILY_LIMIT,
  PREMIUM_LIMIT,
  IMAGE_DAILY_LIMIT,
  IMAGE_PREMIUM_DAILY_LIMIT,
} from "./config.js";

export type FeatName =
  | "images"
  | "summary"
  | "retention_push"
  | "group_free_text"
  | "group_interact"
  | "random"
  | "book_of_day";

export type LimitName =
  | "daily_free"
  | "daily_prem"
  | "image_free"
  | "image_prem";

const FEAT_KEY = (n: string) => `flag:feat:${n}`;
const LIMIT_KEY = (n: string) => `flag:limit:${n}`;

const FEAT_LABELS: Record<FeatName, string> = {
  images: "توليد الصور /img",
  summary: "الملخّصات الذكية",
  retention_push: "إشعارات الصباح/المساء/الأحد",
  group_free_text: "نص حر في الجروبات",
  group_interact: "تفاعل اجتماعي في الجروب",
  random: "كتاب مفاجأة",
  book_of_day: "كتاب اليوم",
};

export async function isFeatureOn(name: FeatName): Promise<boolean> {
  try {
    const v = await redis.get(FEAT_KEY(name));
    if (v === null || v === undefined) return true;
    return v !== "0";
  } catch {
    return true;
  }
}

export async function setFeature(name: FeatName, on: boolean): Promise<void> {
  await redis.set(FEAT_KEY(name), on ? "1" : "0");
}

export async function getAllFeatures(): Promise<Record<FeatName, boolean>> {
  const names = Object.keys(FEAT_LABELS) as FeatName[];
  const out = {} as Record<FeatName, boolean>;
  await Promise.all(
    names.map(async (n) => {
      out[n] = await isFeatureOn(n);
    }),
  );
  return out;
}

export function featLabel(n: FeatName): string {
  return FEAT_LABELS[n];
}

export async function getLimit(name: LimitName, fallback: number): Promise<number> {
  try {
    const v = await redis.get(LIMIT_KEY(name));
    if (v === null || v === undefined || v === "") return fallback;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return fallback;
    return n;
  } catch {
    return fallback;
  }
}

export async function setLimit(name: LimitName, value: number): Promise<void> {
  await redis.set(LIMIT_KEY(name), String(Math.max(0, Math.min(100000, value))));
}

export async function clearLimit(name: LimitName): Promise<void> {
  await redis.del(LIMIT_KEY(name));
}

export async function resolveImageDailyLimit(premium: boolean): Promise<number> {
  if (premium) return getLimit("image_prem", IMAGE_PREMIUM_DAILY_LIMIT);
  return getLimit("image_free", IMAGE_DAILY_LIMIT);
}

export async function resolveBookDailyLimit(premium: boolean, userOverride: string | null): Promise<number> {
  // per-user override still wins
  if (userOverride !== null && userOverride !== undefined) {
    const n = parseInt(userOverride, 10);
    if (Number.isFinite(n)) return n <= 0 ? 999999 : n;
  }
  if (premium) return getLimit("daily_prem", PREMIUM_LIMIT);
  return getLimit("daily_free", DAILY_LIMIT);
}

export async function getLimitsSnapshot(): Promise<{
  daily_free: number;
  daily_prem: number;
  image_free: number;
  image_prem: number;
  daily_free_src: string;
  daily_prem_src: string;
  image_free_src: string;
  image_prem_src: string;
}> {
  const [df, dp, iff, ip] = await Promise.all([
    redis.get(LIMIT_KEY("daily_free")),
    redis.get(LIMIT_KEY("daily_prem")),
    redis.get(LIMIT_KEY("image_free")),
    redis.get(LIMIT_KEY("image_prem")),
  ]);
  return {
    daily_free: df ? parseInt(df, 10) : DAILY_LIMIT,
    daily_prem: dp ? parseInt(dp, 10) : PREMIUM_LIMIT,
    image_free: iff ? parseInt(iff, 10) : IMAGE_DAILY_LIMIT,
    image_prem: ip ? parseInt(ip, 10) : IMAGE_PREMIUM_DAILY_LIMIT,
    daily_free_src: df ? "admin" : "env",
    daily_prem_src: dp ? "admin" : "env",
    image_free_src: iff ? "admin" : "env",
    image_prem_src: ip ? "admin" : "env",
  };
}

export const ALL_FEATS = Object.keys(FEAT_LABELS) as FeatName[];
