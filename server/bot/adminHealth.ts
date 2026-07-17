// ══════════════════════════════════════════════
// ADMIN HEALTH — صحة النظام بنقرة
// ══════════════════════════════════════════════

import { redis } from "./redis.js";
import { storage } from "../storage.js";
import { getQueueStats } from "./queue.js";
import { getDeliveryStats } from "./deliveryMetrics.js";
import { cairoDateString, escMd } from "./text.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const BACKUP_DIR = "/home/ubuntu/book-bot-backups";
const BACKUP_SCRIPT = "/home/ubuntu/book-bot/scripts/backup_bookbot.sh";

function ok(b: boolean): string {
  return b ? "🟢" : "🔴";
}

export async function buildSystemHealthMessage(): Promise<string> {
  const day = cairoDateString();
  let redisOk = false;
  let redisPing = "";
  try {
    const t0 = Date.now();
    const pong = await redis.ping();
    redisOk = pong === "PONG";
    redisPing = `${Date.now() - t0}ms`;
  } catch (e) {
    redisPing = String(e).slice(0, 40);
  }

  let dbOk = false;
  let dbUsers = 0;
  try {
    const s = await storage.getStats();
    dbOk = true;
    dbUsers = s.totalUsers;
  } catch { /* */ }

  const qs = await getQueueStats().catch(() => ({
    highQueue: -1,
    normalQueue: -1,
    dlqSize: -1,
    totalActiveJobs: -1,
  }));

  const ds = await getDeliveryStats(day).catch(() => null);

  const mem = process.memoryUsage();
  const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const upMin = Math.round(process.uptime() / 60);

  const queueOk = qs.dlqSize >= 0 && qs.dlqSize < 50;
  const overall = redisOk && dbOk && queueOk;

  return (
    `🏥 *صحة النظام — رفيق*\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `الحالة العامة: ${overall ? "🟢 سليم" : "🟡 انتبه"}\n` +
    `📅 ${escMd(day)}\n\n` +
    `${ok(redisOk)} *Redis:* ${redisOk ? `PONG · ${redisPing}` : redisPing}\n` +
    `${ok(dbOk)} *Postgres:* ${dbOk ? `متصل · ${dbUsers} مستخدم` : "فشل"}\n` +
    `${ok(queueOk)} *الطابور:* H${qs.highQueue} N${qs.normalQueue} DLQ${qs.dlqSize} نشط${qs.totalActiveJobs}\n` +
    `🟢 *العملية:* Node ${process.version} · uptime ~${upMin}د\n\n` +
    (ds
      ? `📦 *تسليم اليوم:* نجاح ${ds.successRate}% · p50 ${(ds.p50Ms / 1000).toFixed(1)}ث · p95 ${(ds.p95Ms / 1000).toFixed(1)}ث · عينات ${ds.samples}\n\n`
      : "") +
    `💾 *الذاكرة:* heap ~${heapMb}MB · RSS ~${rssMb}MB\n`
  );
}

export async function listBackupFiles(): Promise<{ name: string; size: number; mtime: number }[]> {
  try {
    const names = await readdir(BACKUP_DIR);
    const out: { name: string; size: number; mtime: number }[] = [];
    for (const name of names) {
      try {
        const st = await stat(join(BACKUP_DIR, name));
        if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
      } catch { /* */ }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, 12);
  } catch {
    return [];
  }
}

export async function buildBackupStatusMessage(): Promise<string> {
  const files = await listBackupFiles();
  if (files.length === 0) {
    return (
      `💾 *النسخ الاحتياطي*\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `_لا ملفات في_ \`${BACKUP_DIR}\`\n` +
      `يمكنك تشغيل نسخة الآن من الزر.\n` +
      `_السكربت:_ \`${BACKUP_SCRIPT}\``
    );
  }
  const lines = files.map((f, i) => {
    const mb = (f.size / 1024 / 1024).toFixed(1);
    const d = new Date(f.mtime).toLocaleString("ar-EG", {
      timeZone: "Africa/Cairo",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${i + 1}. \`${escMd(f.name)}\` · ${mb}MB · _${escMd(d)}_`;
  });
  return (
    `💾 *النسخ الاحتياطي*\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `المجلد: \`${BACKUP_DIR}\`\n\n` +
    lines.join("\n") +
    `\n\n_احتفاظ تقريبي 14 يوماً (حسب السكربت)._`
  );
}

export async function runBackupNow(): Promise<{ ok: boolean; log: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [BACKUP_SCRIPT], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    const log = `${stdout || ""}\n${stderr || ""}`.trim().slice(-1500);
    return { ok: true, log: log || "تم بدون مخرجات" };
  } catch (e: any) {
    const log = String(e?.stderr || e?.message || e).slice(0, 800);
    return { ok: false, log };
  }
}
