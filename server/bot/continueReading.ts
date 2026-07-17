// ══════════════════════════════════════════════
// CONTINUE READING — تذكير هادئ «أكمل قراءتك»
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { L } from "./logger.js";
import { cairoDateString, escMd } from "./text.js";
import { getPref } from "./notifPrefs.js";
import { storeRetryKey } from "./session.js";
import { BOT_NAME } from "./brand.js";
import { getLastBook, READING_USERS_KEY } from "./library.js";

const NUDGE_DAY = (day: string) => `ret:continue_nudge:${day}`;
const NUDGE_USER = (uid: string) => `ret:continue_cd:${uid}`;
const MAX_SEND = 25;
const COOLDOWN_SEC = 3 * 86400;

export async function getReadingTitle(userId: string): Promise<string | null> {
  try {
    const st = await redis.hgetall(`lib:st:${userId}`);
    const reading = Object.entries(st || {})
      .filter(([, v]) => v === "reading")
      .map(([k]) => k);
    if (reading.length > 0) {
      const titles = await redis.zrevrange(`lib:z:${userId}`, 0, 40);
      for (const t of titles) {
        if (reading.includes(t)) return t;
      }
      return reading[0];
    }
    return await getLastBook(userId);
  } catch {
    return null;
  }
}

function buildContinueMessage(title: string): string {
  return (
    `📖 *أكمل قراءتك — ${BOT_NAME}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `ما زال معك:\n` +
    `📗 «${escMd(title.slice(0, 70))}»\n\n` +
    `تذكير لطيف فقط — بلا واجب.\n` +
    `*يمكنك:*\n` +
    `◦ إعادة إرسال الملف من الزر\n` +
    `◦ فتح مكتبتي لتغيير الحالة\n` +
    `◦ أو تجاهل الرسالة كما تشاء\n\n` +
    `_يمكنك إسكات هذا النوع من /prefs_`
  );
}

export function kbContinueNudge(title: string): TelegramBot.InlineKeyboardMarkup {
  const k = storeRetryKey(title);
  return {
    inline_keyboard: [
      [{ text: "📥  أعد إرسال الكتاب", callback_data: `retry:${k}` }],
      [
        { text: "✅  أنهيتُه", callback_data: `lib_done:${k}` },
        { text: "📚  مكتبتي", callback_data: "my_library" },
      ],
      [{ text: "🔔  الإشعارات", callback_data: "prefs_menu" }],
    ],
  };
}

export async function sendContinueReadingNudges(bot: TelegramBot): Promise<number> {
  const day = cairoDateString();
  const lock = await redis
    .set(`ret:continue_lock:${day}`, "1", "EX", 4 * 3600, "NX")
    .catch(() => null);
  if (lock !== "OK") return 0;

  let sent = 0;
  try {
    const raw = await redis.srandmember(READING_USERS_KEY, 80).catch(() => [] as string[]);
    const list: string[] = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];

    for (const uid of list) {
      if (sent >= MAX_SEND) break;
      if (!uid || !/^\d{5,15}$/.test(uid)) continue;

      let allowed = true;
      try {
        allowed = await getPref(uid, "continue");
      } catch {
        allowed = true;
      }
      if (!allowed) continue;

      const cd = await redis.set(NUDGE_USER(uid), "1", "EX", COOLDOWN_SEC, "NX").catch(() => null);
      if (cd !== "OK") continue;

      if ((await redis.sismember(NUDGE_DAY(day), uid)) === 1) continue;

      try {
        const last = await redis.zscore("user:lastSeen", uid);
        if (last && Date.now() - Number(last) < 6 * 3600_000) continue;
        if (!last || Date.now() - Number(last) > 21 * 86400_000) {
          await redis.srem(READING_USERS_KEY, uid);
          continue;
        }
      } catch { /* */ }

      const title = await getReadingTitle(uid);
      if (!title) {
        await redis.srem(READING_USERS_KEY, uid);
        continue;
      }

      try {
        await bot.sendMessage(Number(uid), buildContinueMessage(title), {
          parse_mode: "Markdown",
          reply_markup: kbContinueNudge(title),
        });
        await redis.sadd(NUDGE_DAY(day), uid);
        await redis.expire(NUDGE_DAY(day), 2 * 86400);
        sent++;
        redis.incr("tel:retention:continue_nudge").catch(() => {});
      } catch { /* blocked */ }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (sent > 0) L.info("retention", "continue-reading nudges sent", { sent, day });
  } catch (e) {
    L.warn("retention", `sendContinueReadingNudges failed: ${String(e).slice(0, 100)}`);
  }
  return sent;
}
