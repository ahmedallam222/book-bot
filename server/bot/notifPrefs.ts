// ══════════════════════════════════════════════
// NOTIF PREFS — تحكّم المستخدم في الإشعارات (DND)
//
// ret:pref:{uid} HASH:
//   morning | evening | sunday | club  → "1" = مفعّل (افتراضي)
//   "0" = صامت
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { escMd } from "./text.js";

export type PrefKey = "morning" | "evening" | "sunday" | "club" | "continue";

const KEY = (uid: string) => `ret:pref:${uid}`;
const ALL: PrefKey[] = ["morning", "evening", "sunday", "club", "continue"];

const LABELS: Record<PrefKey, string> = {
  morning: "رسالة الصباح",
  evening: "تذكير المساء",
  sunday:  "تقرير الأحد",
  club:    "همسات نادي الجروب",
  continue: "تذكير أكمل قراءتك",
};

export async function getPref(userId: string, key: PrefKey): Promise<boolean> {
  try {
    const v = await redis.hget(KEY(userId), key);
    if (v === null || v === undefined) return true; // default on
    return v !== "0";
  } catch {
    return true;
  }
}

export async function setPref(userId: string, key: PrefKey, on: boolean): Promise<void> {
  try {
    await redis.hset(KEY(userId), key, on ? "1" : "0");
    await redis.expire(KEY(userId), 800 * 86400);
  } catch { /* */ }
}

export async function getAllPrefs(userId: string): Promise<Record<PrefKey, boolean>> {
  const out = {} as Record<PrefKey, boolean>;
  for (const k of ALL) out[k] = await getPref(userId, k);
  return out;
}

export async function buildPrefsMessage(userId: string): Promise<string> {
  const p = await getAllPrefs(userId);
  const lines = ALL.map((k) => {
    const on = p[k];
    return `◦ ${LABELS[k]}: *${on ? "مفعّلة ✅" : "صامتة 🔕"}*`;
  }).join("\n");
  return (
    `🔔 *تفضيلات الإشعارات*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `أنت المتحكّم — لا رسائل دون رغبتك.\n\n` +
    `${lines}\n\n` +
    `_اضغط زراً لتبديل الحالة. الإعدادات تُحفظ فوراً._`
  );
}

export function kbPrefs(prefs: Record<PrefKey, boolean>): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = ALL.map((k) => [
    {
      text: `${prefs[k] ? "🔔" : "🔕"} ${LABELS[k]}`,
      callback_data: `pref:${k}`,
    },
  ]);
  rows.push([{ text: "🏠  الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

export async function togglePref(userId: string, key: PrefKey): Promise<boolean> {
  const cur = await getPref(userId, key);
  await setPref(userId, key, !cur);
  return !cur;
}

export function isPrefKey(s: string): s is PrefKey {
  return (ALL as string[]).includes(s);
}
