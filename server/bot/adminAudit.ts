// ══════════════════════════════════════════════
// ADMIN AUDIT — سجل دائم لعمليات الأدمن (Redis)
// ══════════════════════════════════════════════

import { redis } from "./redis.js";
import { escMd } from "./text.js";

const KEY = "admin:audit:log";
const MAX = 300;

export interface AuditEntry {
  ts: number;
  who: string;
  action: string;
}

export async function recordAdminAudit(who: string, action: string): Promise<void> {
  try {
    const entry: AuditEntry = { ts: Date.now(), who, action: action.slice(0, 400) };
    await redis.lpush(KEY, JSON.stringify(entry));
    await redis.ltrim(KEY, 0, MAX - 1);
    await redis.expire(KEY, 180 * 86400);
  } catch { /* fail-open */ }
}

export async function getAdminAudit(limit = 40): Promise<AuditEntry[]> {
  try {
    const raw = await redis.lrange(KEY, 0, Math.max(0, limit - 1));
    const out: AuditEntry[] = [];
    for (const r of raw) {
      try {
        const e = JSON.parse(r) as AuditEntry;
        if (e && e.ts && e.action) out.push(e);
      } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

export async function buildAdminAuditMessage(limit = 35): Promise<string> {
  const list = await getAdminAudit(limit);
  if (list.length === 0) {
    return (
      `📜 *سجل التحكم*\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `_فارغ بعد. كل إجراء أدمن سيُسجَّل هنا._`
    );
  }
  const lines = list.map((e, i) => {
    const d = new Date(e.ts).toLocaleString("ar-EG", {
      timeZone: "Africa/Cairo",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${i + 1}. \`${escMd(String(e.who).slice(0, 14))}\` · ${escMd(e.action.slice(0, 60))}\n   _${escMd(d)}_`;
  });
  return (
    `📜 *سجل التحكم* (آخر ${list.length})\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    lines.join("\n\n") +
    `\n\n_بتوقيت القاهرة · يُحفظ ~300 حدث_`
  );
}
