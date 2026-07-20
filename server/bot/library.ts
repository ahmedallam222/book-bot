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


/** SET: مستخدمون لديهم كتاب واحد على الأقل بحالة أقرؤه */
export const READING_USERS_KEY = "lib:reading_users";

export async function markUserHasReading(userId: string): Promise<void> {
  try {
    await redis.sadd(READING_USERS_KEY, userId);
  } catch { /* */ }
}

export async function refreshReadingMembership(userId: string): Promise<void> {
  try {
    const st = await redis.hgetall(STKEY(userId));
    const has = Object.values(st || {}).some((v) => v === "reading");
    if (has) await redis.sadd(READING_USERS_KEY, userId);
    else await redis.srem(READING_USERS_KEY, userId);
  } catch { /* */ }
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
    // إن لم تكن له حالة سابقة: "أقرؤه" — أقرب لنية التحميل
    // (لا نكتب فوق reading/done/want)
    pipe.hsetnx(STKEY(userId), title, "reading");
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
    markUserHasReading(userId).catch(() => {});
    redis.incr("tel:lib:record").catch(() => {});
    redis.incr("tel:lib:status:reading").catch(() => {});
    // trim oldest beyond MAX_LIB
    const n = await redis.zcard(ZKEY(userId));
    if (n > MAX_LIB) {
      await redis.zremrangebyrank(ZKEY(userId), 0, n - MAX_LIB - 1);
    }
  } catch { /* fail-open */ }
}


/** مرة واحدة لكل مستخدم: تلميح أن التحميل دخل «مكتبتي» */
export async function maybeLibraryWelcomeTip(userId: string): Promise<string | null> {
  try {
    const ok = await redis.set(`lib:welcome_tip:${userId}`, "1", "EX", 400 * 86400, "NX");
    if (ok !== "OK") return null;
    redis.incr("tel:lib:welcome_tip").catch(() => {});
    return "📚 _أُضيف إلى «مكتبتي» بحالة أقرؤه — غيّر الحالة من الزر أو /library_";
  } catch {
    return null;
  }
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
    redis.incr(`tel:lib:status:${next}`).catch(() => {});
    refreshReadingMembership(userId).catch(() => {});
    return next;
  } catch {
    return "have";
  }
}

export async function setLibStatus(
  userId: string,
  title: string,
  status: LibStatus,
): Promise<void> {
  const t = clean(title);
  if (!t) return;
  try {
    await redis.hset(STKEY(userId), t, status);
    await redis.expire(STKEY(userId), TTL);
    // ensure it's in the zset
    await redis.zadd(ZKEY(userId), Date.now(), t);
    await redis.expire(ZKEY(userId), TTL);
    redis.incr(`tel:lib:status:${status}`).catch(() => {});
    refreshReadingMembership(userId).catch(() => {});
  } catch { /* fail-open */ }
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
    // allow one refresh path: if zcard 0 even after flag, still fill
    if (flag !== "OK") {
      const n2 = await redis.zcard(ZKEY(userId));
      if (n2 > 0) return 0;
    }
    const hist = await storage.getUserSearchHistory(userId, 100);
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

export async function buildLibraryMessage(userId: string, filter?: string): Promise<string> {
  await maybeBackfillLibrary(userId);
  let items = await getLibrary(userId, 40);
  const last = await getLastBook(userId);
  const q = (filter || "").trim().toLowerCase();
  if (q) {
    items = items.filter((it) => it.title.toLowerCase().includes(q));
  }
  items = items.slice(0, 15);

  if (items.length === 0) {
    if (q) {
      return (
        `📚 *مكتبتي — بحث*\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `لا نتائج لـ «${escMd((filter || "").slice(0, 40))}».\n\n` +
        `_جرّب كلمة أقصر أو افتح المكتبة بلا فلتر: /library_`
      );
    }
    return (
      `📚 *مكتبتي — ${BOT_NAME}*\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `_فارغة بعد. حمّل أي كتاب وسيُحفظ هنا تلقائياً._\n\n` +
      `*ابدأ الآن:*\n` +
      `◦ اكتب عنوان كتاب في المحادثة\n` +
      `◦ أو «كتاب مفاجأة» / «كتاب اليوم»\n` +
      `◦ أو /lists لقوائم جاهزة\n\n` +
      `*لاحقًا ستجد:*\n` +
      `◦ حالة القراءة (لديه / أقرؤه / أنهيت)\n` +
      `◦ «أكمل رحلتي» لآخر كتاب\n` +
      `◦ إعادة التحميل بضغطة\n\n` +
      `_تلميح: /library كلمة_ للبحث داخل مكتبتك._`
    );
  }

  let reading = 0, done = 0, have = 0, want = 0;
  for (const it of items) {
    if (it.status === "reading") reading++;
    else if (it.status === "done") done++;
    else if (it.status === "want") want++;
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
    (q ? `🔎 فلتر: «${escMd((filter || "").slice(0, 40))}»\n\n` : "") +
    `📊 لديّ: *${have}* · أقرأ: *${reading}* · أنهيت: *${done}*` +
    (want ? ` · لاحقاً: *${want}*` : "") +
    `\n\n` +
    `*آخر ${items.length} كتاباً:*\n${lines}\n\n` +
    `_📥 تحميل · 🔄 غيّر الحالة · /library كلمة للبحث · /share للمشاركة_`
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
  rows.push([
    { text: "📋  انسخ قائمتي", callback_data: "lib_export" },
    { text: "🕊  لحظة", callback_data: "micro_open" },
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


/** نص قابل للنسخ/المشاركة لقائمة المكتبة */
export async function exportLibraryText(userId: string, limit = 25): Promise<string> {
  await maybeBackfillLibrary(userId);
  const items = await getLibrary(userId, limit);
  if (items.length === 0) {
    return `مكتبة فارغة بعد — حمّل كتاباً عبر ${BOT_NAME}.`;
  }
  const lines = items.map((it, i) => `${i + 1}. ${it.title} (${ST_LABEL[it.status]})`);
  return (
    `📚 مكتبتي في ${BOT_NAME}\n` +
    `━━━━━━━━━━━━━━━━\n` +
    lines.join("\n") +
    `\n━━━━━━━━━━━━━━━━\n` +
    `${items.length} كتاباً · اكتب العنوان في رفيق لإعادة التحميل`
  );
}
