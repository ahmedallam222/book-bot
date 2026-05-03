import TelegramBot from "node-telegram-bot-api";
import { redis }   from "./redis.js";
import { L }       from "./logger.js";
import { listKnownGroups, removeGroup } from "./groupTracker.js";

// ══════════════════════════════════════════════
// MAINTENANCE ANNOUNCE — رسالة "انتهت الصيانة" للجروبات
// ══════════════════════════════════════════════
//
// لما المشرف يطفي وضع الصيانة، البوت يبعت تلقائياً رسالة في كل الجروبات
// المعروفة (groupTracker) + أي chat IDs مضافة في الـ env كـ override.
//
// Idempotence: نستخدم Redis NX lock مدّته 60 ثانية عشان لو حصل toggle مرتين
// متتاليتين أو من dashboard + Telegram في نفس اللحظة، ما يبعتش الإعلان
// مرتين.

const ANNOUNCE_LOCK_KEY  = "maintenance:announce:lock";
const ANNOUNCE_LOCK_TTL  = 60; // seconds — أقل من المعتاد بين toggles
const SEND_DELAY_MS      = 50; // بين كل رسالتين عشان Telegram rate limit

const DEFAULT_MESSAGE =
  `✅ *عادت الخدمة*\n` +
  `▔▔▔▔▔▔▔▔▔▔▔▔\n\n` +
  `انتهت أعمال الصيانة، البوت رجع للعمل بشكل طبيعي 🎉\n\n` +
  `_شكراً لصبركم 🙏 — اكتب اسم أي كتاب لتحميله 📚_`;

function envChatIds(): number[] {
  const raw = process.env.MAINTENANCE_ANNOUNCE_CHAT_IDS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

function envMessage(): string {
  const raw = (process.env.MAINTENANCE_END_MESSAGE || "").trim();
  return raw || DEFAULT_MESSAGE;
}

async function acquireLock(): Promise<boolean> {
  try {
    const res = await redis.set(ANNOUNCE_LOCK_KEY, String(Date.now()), "EX", ANNOUNCE_LOCK_TTL, "NX");
    return res === "OK";
  } catch (e) {
    L.warn("maintenanceAnnounce", "lock acquire failed — proceeding", { err: String(e).slice(0, 80) });
    return true; // نتقدم لو Redis مش متاح، أحسن من ما نبعتش خالص
  }
}

export async function announceMaintenanceEnd(bot: TelegramBot): Promise<void> {
  // Idempotence — لو حد تانٍ بعت في آخر دقيقة، نسكت
  const locked = await acquireLock();
  if (!locked) {
    L.info("maintenanceAnnounce", "Skipping — another announcement in flight");
    return;
  }

  const known = await listKnownGroups();
  const overrides = envChatIds();

  // override CSV → نضمّها لقائمة known (deduped)
  const seen = new Set<number>();
  const targets: number[] = [];
  for (const g of known)    { if (!seen.has(g.chatId))  { seen.add(g.chatId);  targets.push(g.chatId); } }
  for (const id of overrides) { if (!seen.has(id))      { seen.add(id);        targets.push(id); } }

  if (targets.length === 0) {
    L.warn("maintenanceAnnounce", "No groups to notify (known=0, env override=0)");
    return;
  }

  const message = envMessage();
  L.info("maintenanceAnnounce", "Announcing maintenance end", {
    targets: targets.length,
    known:   known.length,
    env:     overrides.length,
  });

  let sent = 0, failed = 0, removed = 0;
  for (const chatId of targets) {
    try {
      await bot.sendMessage(chatId, message, {
        parse_mode:               "Markdown",
        disable_notification:     false,
        disable_web_page_preview:  true,
      });
      sent++;
    } catch (e) {
      failed++;
      const errStr = String(e).toLowerCase();
      // الجروب مش متاح — نشيله من الـ tracker
      if (
        errStr.includes("kicked") ||
        errStr.includes("chat not found") ||
        errStr.includes("forbidden") ||
        errStr.includes("chat_write_forbidden") ||
        errStr.includes("group chat was upgraded") ||
        errStr.includes("user_deactivated")
      ) {
        // مش نشيل overrides — هي manual
        if (!overrides.includes(chatId)) {
          await removeGroup(chatId).catch(() => {});
          removed++;
        }
      }
      L.warn("maintenanceAnnounce", "send failed", {
        chatId, err: String(e).slice(0, 100),
      });
    }
    if (SEND_DELAY_MS > 0) await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
  }

  L.info("maintenanceAnnounce", "Done", { sent, failed, removed, total: targets.length });
}
