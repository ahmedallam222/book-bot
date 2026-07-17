// ══════════════════════════════════════════════
// LIBRARY — مكتبتي الشخصية + أكمل من حيث توقفت
//
// Redis:
//   lib:z:{uid}     ZSET score=ts member=title
//   lib:st:{uid}    HASH title → want|reading|done|have
//   lib:last:{uid}  آخر كتاب حُمّل بنجاح
//   lib:meta:{uid}  HASH title → JSON {at, sizeMB?, fromCache?}
// ══════════════════════════════════════════════

import TelegramBot from "node-telegram-bot-api";
import { redis } from "./redis.js";
import { escMd } from "./text.js";
import { storeRetryKey } from "./session.js";
import { BOT_NAME } from "./brand.js";
import { storage } from "../storage.js";

export type LibStatus = "have" | "reading" | "done" | "want";

const ZKEY = (uid: string) => `lib:z:${uid}`;
const STKEY = (uid: string) => `lib:st:${uid}`;
const LAST = (uid: string) => `lib:last:${uid}`;
const META = (uid: string) => `lib:meta:${uid}`;
const TTL = 400 * 86400;
const MAX_LIB = 80;

const ST_EMOJI: Record<LibStatus, string> = {
  have: "📥",
  reading: "📖",
  done: "✅",
  want: "🔖",
};
const ST_LABEL: Record<LibStatus, string> = {
  have: "لديه",
  reading: "أقرؤه",
  done: "أنهيتُه",
  want: "لاحقاً",
};

function clean(t: string): string {
  return (t.split(/\s*[—–-]\s*/)[0] || t).trim().slice(0, 120);
}

export async function recordLibraryDownload(
  userId: string,
  bookName: string,
  opts?: { sizeMB?: string; fromCache?: boolean },
): Promise<void> {
  const title = clean(bookName);
  if (!title || title.length < 2) return;
  const now = Date.now();
  try {
    const pipe = redis.pipeline();
    pipe.zadd(ZKEY(userId), now, title);
    pipe.hset(STKEY(userId), title, "have");
    pipe.set(LAST(userId), title, "EX", TTL);
    pipe.hset(
      META(userId),
      title,
      JSON.stringify({
        at: now,
        sizeMB: opts?.sizeMB || null,
        fromCache: !!opts?.fromCache,
      }),
    );
    pipe.expire(ZKEY(userId), TTL);
    pipe.expire(STKEY(userId), TTL);
    pipe.expire(META(userId), TTL);
    await pipe.exec();
    // trim oldest beyond MAX_LIB
    const n = await redis.zcard(ZKEY(userId));
    if (n > MAX_LIB) {
      await redis.zremrangebyrank(ZKEY(userId), 0, n - MAX_LIB - 1);
    }
  } catch { /* fail-open */ }
}

export async function getLastBook(userId: string): Promise<string | null> {
  try {
    const t = await redis.get(LAST(userId));
    return t && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

export async function getLibrary(
  userId: string,
  limit = 20,
): Promise<{ title: string; status: LibStatus; at: number }[]> {
  try {
    const titles = await redis.zrevrange(ZKEY(userId), 0, limit - 1, "WITHSCORES");
    const out: { title: string; status: LibStatus; at: number }[] = [];
    for (let i = 0; i < titles.length; i += 2) {
      const title = titles[i];
      const at = parseInt(titles[i + 1] || "0", 10) || 0;
      const st = (await redis.hget(STKEY(userId), title)) as LibStatus | null;
      const status: LibStatus =
        st === "reading" || st === "done" || st === "want" || st === "have"
          ? st
          : "have";
      out.push({ title, status, at });
    }
    return out;
  } catch {
    return [];
  }
}

export async function cycleLibStatus(
  userId: string,
  title: string,
): Promise<LibStatus> {
  const order: LibStatus[] = ["have", "reading", "done", "want"];
  try {
    const cur = ((await redis.hget(STKEY(userId), title)) as LibStatus) || "have";
    const idx = order.indexOf(cur);
    const next = order[(idx + 1) % order.length];
    await redis.hset(STKEY(userId), title, next);
    await redis.expire(STKEY(userId), TTL);
    return next;
  } catch {
    return "have";
  }
}

export function statusBadge(st: LibStatus): string {
  return `${ST_EMOJI[st]} ${ST_LABEL[st]}`;
}


/** يملأ المكتبة من سجل التحميلات السابق مرة واحدة إن كانت فارغة */
export async function maybeBackfillLibrary(userId: string): Promise<number> {
  try {
    const n = await redis.zcard(ZKEY(userId));
    if (n > 0) return 0;
    const flag = await redis.set(`lib:backfilled:${userId}`, "1", "EX", 400 * 86400, "NX");
    if (flag !== "OK") return 0;
    const hist = await storage.getUserSearchHistory(userId, 40);
    let added = 0;
    for (const h of hist) {
      const q = (h.query || "").trim();
      if (q.length < 2) continue;
      await recordLibraryDownload(userId, q, {});
      added++;
    }
    return added;
  } catch {
    return 0;
  }
}

export async function buildLibraryMessage(userId: string): Promise<string> {
  const added = await maybeBackfillLibrary(userId);
  const items = await getLibrary(userId, 15);
  const last = await getLastBook(userId);

  if (items.length === 0) {
    return (
      `📚 *مكتبتي — ${BOT_NAME}*\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `_فارغة بعد. حمّل أي كتاب وسيُحفظ هنا تلقائياً._\n\n` +
      `*ماذا ستجد لاحقاً؟*\n` +
      `◦ آخر كتبك مع حالة القراءة\n` +
      `◦ زر «أكمل رحلتي» لآخر كتاب\n` +
      `◦ إعادة التحميل بضغطة\n\n` +
      `_اكتب عنوان كتاب للبدء._`
    );
  }

  let reading = 0,
    done = 0,
    have = 0;
  for (const it of items) {
    if (it.status === "reading") reading++;
    else if (it.status === "done") done++;
    else have++;
  }

  const lines = items
    .map((it, i) => {
      const badge = statusBadge(it.status);
      return `${i + 1}. ${badge} — _${escMd(it.title.slice(0, 48))}_`;
    })
    .join("\n");

  return (
    `📚 *مكتبتي — ${BOT_NAME}*\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    (last ? `🕯 *آخر كتاب:* «${escMd(last)}»\n\n` : "") +
    `📊 لديّ: *${have}* · أقرأ: *${reading}* · أنهيت: *${done}*\n\n` +
    `*آخر ${items.length} كتاباً:*\n${lines}\n\n` +
    `_📥 تحميل · 🔄 غيّر الحالة · استخدم «أكمل رحلتي»_`
  );
}

export async function kbLibrary(
  userId: string,
): Promise<TelegramBot.InlineKeyboardMarkup> {
  const items = await getLibrary(userId, 8);
  const rows: TelegramBot.InlineKeyboardButton[][] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const k = storeRetryKey(it.title);
    const label =
      it.title.length > 26 ? it.title.slice(0, 25) + "…" : it.title;
    rows.push([
      { text: `📥 ${label}`, callback_data: `retry:${k}` },
      {
        text: statusBadge(it.status).slice(0, 12),
        callback_data: `libst:${i}`,
      },
    ]);
  }

  rows.push([
    { text: "▶️  أكمل رحلتي", callback_data: "lib_continue" },
    { text: "📖  قوائم مختارة", callback_data: "curated_menu" },
  ]);
  rows.push([{ text: "🏠  الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

export async function buildContinueMessage(
  userId: string,
): Promise<{ text: string; title: string | null }> {
  const last = await getLastBook(userId);
  if (!last) {
    return {
      title: null,
      text:
        `▶️ *أكمل رحلتي*\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `_لا يوجد كتاب أخير بعد._\n` +
        `حمّل كتاباً أولاً، وسأحفظه هنا لتعود إليه.\n\n` +
        `أو استكشف: /lists · /random · /today`,
    };
  }

  let st: LibStatus = "have";
  try {
    const s = await redis.hget(STKEY(userId), last);
    if (s === "reading" || s === "done" || s === "want" || s === "have") st = s;
  } catch { /* */ }

  return {
    title: last,
    text:
      `▶️ *أكمل رحلتي*\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `آخر كتاب معك:\n` +
      `📗 «${escMd(last)}»\n` +
      `الحالة: *${statusBadge(st)}*\n\n` +
      `*ماذا تريد؟*\n` +
      `◦ إعادة إرسال الملف\n` +
      `◦ ملخّص سريع (بعد الإرسال من الأزرار)\n` +
      `◦ فتح المكتبة الكاملة\n\n` +
      `_${BOT_NAME} يتذكّر مكانك._`,
  };
}

export function kbContinue(title: string | null): TelegramBot.InlineKeyboardMarkup {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  if (title) {
    const k = storeRetryKey(title);
    rows.push([{ text: "📥  أعد إرسال آخر كتاب", callback_data: `retry:${k}` }]);
    rows.push([
      { text: "📚  مكتبتي", callback_data: "my_library" },
      { text: "✨  كتب مشابهة", callback_data: `series:${k}` },
    ]);
  } else {
    rows.push([
      { text: "🎲  مفاجأة", callback_data: "rg:any" },
      { text: "📖  قوائم", callback_data: "curated_menu" },
    ]);
  }
  rows.push([{ text: "🏠  الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: rows };
}

/** عنوان بالمكتبة حسب الفهرس (لأزرار الحالة) */
export async function libraryTitleAt(
  userId: string,
  index: number,
): Promise<string | null> {
  const items = await getLibrary(userId, 30);
  return items[index]?.title ?? null;
}
