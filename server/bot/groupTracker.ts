import { redis } from "./redis.js";
import { L }     from "./logger.js";

// ══════════════════════════════════════════════
// GROUP TRACKER — تتبّع المجموعةات اللي البوت موجود فيها
// ══════════════════════════════════════════════
//
// الـ Telegram bot ما عندوش API بيرجّع كل المجموعةات اللي عضو فيها (تصميم
// متعمّد للحفاظ على الـ privacy). الحل المعتمد: نتعرّف على المجموعة لأول مرة
// لما يبعت رسالة + نسجّله في Redis. لما يحصل event عام (مثلاً انتهاء الصيانة)
// نعمل announcement لكل المجموعةات المعروفة.
//
// Redis schema:
//   - SET   `bot:known_groups`               → كل الـ chat IDs (string)
//   - HASH  `bot:known_groups:meta`          → field=chatId → value={title,lastSeen}
//
// الـ TTL ضمني: نزيل أي chatId الـ sendMessage بترجع له خطأ "kicked" أو
// "chat not found" — يعني المجموعة اتشال أو طُرد البوت منه. كده الـ set
// بيتنضف ذاتياً مع الوقت بدون cron.

const SET_KEY  = "bot:known_groups";
const HASH_KEY = "bot:known_groups:meta";

export interface KnownGroup {
  chatId: number;
  title:  string;
  lastSeen: number;
}

export async function recordGroup(chatId: number, title: string = ""): Promise<void> {
  try {
    const id = String(chatId);
    const meta = JSON.stringify({ title: title.slice(0, 200), lastSeen: Date.now() });
    await redis.pipeline()
      .sadd(SET_KEY, id)
      .hset(HASH_KEY, id, meta)
      .exec();
  } catch (e) {
    // tracking ما يصحش يكسر أي flow — نسجّله warning بس
    L.warn("groupTracker", "recordGroup failed", { chatId, err: String(e).slice(0, 80) });
  }
}

export async function listKnownGroups(): Promise<KnownGroup[]> {
  try {
    const ids = await redis.smembers(SET_KEY);
    if (ids.length === 0) return [];
    const meta = await redis.hmget(HASH_KEY, ...ids);
    return ids.map((id, i) => {
      const m = meta[i];
      let parsed: { title?: string; lastSeen?: number } = {};
      if (m) { try { parsed = JSON.parse(m); } catch { /* legacy entry — safe defaults */ } }
      return {
        chatId:   parseInt(id, 10),
        title:    parsed.title || "",
        lastSeen: parsed.lastSeen || 0,
      };
    }).filter((g) => Number.isFinite(g.chatId));
  } catch (e) {
    L.error("groupTracker", "listKnownGroups failed", { err: String(e).slice(0, 80) });
    return [];
  }
}

export async function removeGroup(chatId: number): Promise<void> {
  try {
    const id = String(chatId);
    await redis.pipeline()
      .srem(SET_KEY, id)
      .hdel(HASH_KEY, id)
      .exec();
  } catch (e) {
    L.warn("groupTracker", "removeGroup failed", { chatId, err: String(e).slice(0, 80) });
  }
}
