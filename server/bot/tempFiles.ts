import * as fs from "fs";
import * as path from "path";
import { TEMP_DIR, TEMP_FILE_MAX_AGE } from "./config.js";
import { L } from "./logger.js";

// ══════════════════════════════════════════════
// TEMP FILE MANAGEMENT — مع إحصائيات وlogging
// ══════════════════════════════════════════════

export function ensureTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export function safeDeleteTemp(fp: string): void {
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

export interface TempStats {
  totalFiles:  number;
  totalBytes:  number;
  oldestAgeMs: number;
}

export function getTempStats(): TempStats {
  if (!fs.existsSync(TEMP_DIR)) return { totalFiles: 0, totalBytes: 0, oldestAgeMs: 0 };
  const now  = Date.now();
  let totalFiles = 0, totalBytes = 0, oldestAgeMs = 0;
  try {
    for (const f of fs.readdirSync(TEMP_DIR)) {
      const fp = path.join(TEMP_DIR, f);
      try {
        const stat = fs.statSync(fp);
        totalFiles++;
        totalBytes  += stat.size;
        oldestAgeMs  = Math.max(oldestAgeMs, now - stat.mtimeMs);
      } catch {}
    }
  } catch {}
  return { totalFiles, totalBytes, oldestAgeMs };
}

/**
 * تنظيف الملفات المؤقتة القديمة.
 * يُنادى كل TEMP_CLEANUP_INTERVAL من الـ index.
 */
export function cleanTempFiles(cleaners: Array<() => void> = []): void {
  const now     = Date.now();
  let cleaned   = 0;
  let freedBytes = 0;

  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        const fp = path.join(TEMP_DIR, f);
        try {
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > TEMP_FILE_MAX_AGE) {
            freedBytes += stat.size;
            fs.unlinkSync(fp);
            cleaned++;
          }
        } catch {}
      }
    }
  } catch {}

  if (cleaned > 0) {
    L.tempClean(cleaned, freedBytes / 1024 / 1024);
  } else {
    L.debug("system", `Temp cleanup: nothing to delete`);
  }

  for (const clean of cleaners) {
    try { clean(); } catch {}
  }
}
