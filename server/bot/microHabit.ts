// ══════════════════════════════════════════════
// MICRO HABIT — سؤال يومي لطيف (عادة خفيفة)
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { cairoDateString, escMd } from "./text.js";
import { addXp } from "./retention.js";
import { BOT_NAME } from "./brand.js";

const DONE = (uid: string, day: string) => `ret:micro:${uid}:${day}`;

const QUESTIONS: { id: string; q: string; opts: { id: string; label: string }[] }[] = [
  {
    id: "mood",
    q: "ما مزاج قراءتك اليوم؟",
    opts: [
      { id: "calm", label: "هدوء" },
      { id: "learn", label: "تعلّم" },
      { id: "story", label: "قصة" },
      { id: "faith", label: "تذكير" },
    ],
  },
  {
    id: "time",
    q: "كم دقيقة تتخيّل أن تقرأ اليوم؟",
    opts: [
      { id: "10", label: "١٠ دقائق" },
      { id: "20", label: "٢٠" },
      { id: "45", label: "٤٥" },
      { id: "0", label: "راحة اليوم" },
    ],
  },
  {
    id: "place",
    q: "أين تفضّل أن تقرأ؟",
    opts: [
      { id: "home", label: "المنزل" },
      { id: "out", label: "خارجاً" },
      { id: "bed", label: "قبل النوم" },
      { id: "any", label: "أي مكان" },
    ],
  },
  {
    id: "goal",
    q: "هدفك الهادئ هذا الأسبوع؟",
    opts: [
      { id: "one", label: "كتاب واحد" },
      { id: "pages", label: "صفحات قليلة يومياً" },
      { id: "sum", label: "ملخصات" },
      { id: "none", label: "بلا هدف" },
    ],
  },
];

function pickQuestion(day: string): (typeof QUESTIONS)[0] {
  let h = 0;
  for (let i = 0; i < day.length; i++) h = (h * 31 + day.charCodeAt(i)) >>> 0;
  return QUESTIONS[h % QUESTIONS.length];
}

export async function hasAnsweredMicro(userId: string): Promise<boolean> {
  const day = cairoDateString();
  try {
    return (await redis.get(DONE(userId, day))) === "1";
  } catch {
    return false;
  }
}

export function buildMicroMessage(): { text: string; kb: TelegramBot.InlineKeyboardMarkup } {
  const day = cairoDateString();
  const q = pickQuestion(day);
  const text =
    `🕊 *لحظة مع ${BOT_NAME}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `${escMd(q.q)}\n\n` +
    `_سؤال يومي اختياري · +5 نقاط إن أجبت · بلا حكم._`;
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < q.opts.length; i += 2) {
    const row = [
      { text: q.opts[i].label, callback_data: `micro:${q.id}:${q.opts[i].id}` },
    ];
    if (q.opts[i + 1]) {
      row.push({
        text: q.opts[i + 1].label,
        callback_data: `micro:${q.id}:${q.opts[i + 1].id}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "⏭  ليس الآن", callback_data: "micro:skip" }]);
  return { text, kb: { inline_keyboard: rows } };
}

export async function answerMicro(
  userId: string,
  qid: string,
  oid: string,
): Promise<string> {
  const day = cairoDateString();
  const set = await redis.set(DONE(userId, day), "1", "EX", 3 * 86400, "NX").catch(() => null);
  if (set === "OK") {
    await addXp(userId, 5).catch(() => ({ xp: 0, level: 1, leveledUp: null }));
    // store soft signal for future personalization
    try {
      await redis.hset(`ret:micro_ans:${userId}`, qid, oid);
      await redis.expire(`ret:micro_ans:${userId}`, 120 * 86400);
    } catch { /* */ }
    return (
      `🌿 *شكراً — سُجّلت لحظتك*\n` +
      `+5 نقاط.\n\n` +
      `_لا واجب بعد هذا. اكتب عنوان كتاب متى شئت._`
    );
  }
  return `_أجبتَ اليوم بالفعل. إلى الغد بهدوء._`;
}

export async function skipMicro(userId: string): Promise<string> {
  const day = cairoDateString();
  await redis.set(DONE(userId, day), "1", "EX", 3 * 86400).catch(() => {});
  return `_حسناً. لا سؤال اليوم — ${BOT_NAME} هنا إن احتجت._`;
}
