// ══════════════════════════════════════════════
// JOURNEY — حالات رحلة القراءة على الأمنيات
//
// want → reading → done  (دورة لطيفة)
// تخزين منفصل عن قائمة العناوين حتى لا نكسر التوافق.
// ══════════════════════════════════════════════

import { redis } from "./redis.js";
import { escMd } from "./text.js";

export type JourneyStatus = "want" | "reading" | "done";

const KEY = (uid: string) => `wl:journey:${uid}`;

const LABEL: Record<JourneyStatus, string> = {
  want:    "لاحقاً",
  reading: "أقرؤه",
  done:    "أنهيتُه",
};

const EMOJI: Record<JourneyStatus, string> = {
  want:    "🔖",
  reading: "📖",
  done:    "✅",
};

export function nextStatus(cur: JourneyStatus): JourneyStatus {
  if (cur === "want") return "reading";
  if (cur === "reading") return "done";
  return "want";
}

export async function getJourneyMap(userId: string): Promise<Record<string, JourneyStatus>> {
  try {
    const raw = await redis.hgetall(KEY(userId));
    const out: Record<string, JourneyStatus> = {};
    for (const [k, v] of Object.entries(raw || {})) {
      if (v === "want" || v === "reading" || v === "done") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getStatus(userId: string, title: string): Promise<JourneyStatus> {
  try {
    const v = await redis.hget(KEY(userId), title);
    if (v === "reading" || v === "done" || v === "want") return v;
    return "want";
  } catch {
    return "want";
  }
}

export async function setStatus(userId: string, title: string, st: JourneyStatus): Promise<void> {
  try {
    await redis.hset(KEY(userId), title, st);
    await redis.expire(KEY(userId), 120 * 86400);
  } catch { /* */ }
}

export async function cycleStatus(userId: string, title: string): Promise<JourneyStatus> {
  const cur = await getStatus(userId, title);
  const n = nextStatus(cur);
  await setStatus(userId, title, n);
  return n;
}

export function statusLabel(st: JourneyStatus): string {
  return `${EMOJI[st]} ${LABEL[st]}`;
}

export function formatWishlistLine(title: string, st: JourneyStatus, index: number): string {
  return `${index + 1}. ${EMOJI[st]} _${escMd(title.slice(0, 50))}_ · *${LABEL[st]}*`;
}

export async function journeySummary(userId: string, titles: string[]): Promise<string> {
  const map = await getJourneyMap(userId);
  let want = 0, reading = 0, done = 0;
  for (const t of titles) {
    const s = map[t] || "want";
    if (s === "reading") reading++;
    else if (s === "done") done++;
    else want++;
  }
  if (titles.length === 0) return "";
  return `📊 لاحقاً: *${want}* · أقرأ: *${reading}* · أنهيت: *${done}*`;
}
