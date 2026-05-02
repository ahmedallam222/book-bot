import * as fs   from "fs";
import * as path from "path";
import { TEMP_DIR } from "./config.js";
import { L }        from "./logger.js";

// ══════════════════════════════════════════════
// TEMP FILES — إدارة الملفات المؤقتة
// ══════════════════════════════════════════════

let _dirEnsured = false;

/** يُنشئ مجلد الملفات المؤقتة إن لم يكن موجوداً */
export function ensureTempDir(): void {
  if (_dirEnsured) return;
  try {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    _dirEnsured = true;
  } catch (e) {
    L.error("tempFiles", `Cannot create temp dir: ${TEMP_DIR}`, { err: String(e).slice(0, 100) });
  }
}

/** يحذف ملفاً مؤقتاً بأمان — لا يُلقي exceptions */
export function safeDeleteTemp(filePath: string): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // تجاهل أخطاء الحذف — الـ OS سيتعامل معها
  }
}

/** يُحصي عدد الملفات وحجمها الإجمالي في مجلد temp */
export function getTempStats(): { totalFiles: number; totalBytes: number } {
  let totalFiles = 0;
  let totalBytes = 0;
  try {
    if (!fs.existsSync(TEMP_DIR)) return { totalFiles, totalBytes };
    for (const file of fs.readdirSync(TEMP_DIR)) {
      const fp = path.join(TEMP_DIR, file);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile()) {
          totalFiles++;
          totalBytes += stat.size;
        }
      } catch {}
    }
  } catch {}
  return { totalFiles, totalBytes };
}

/** تنظيف الملفات القديمة (أكبر من maxAgeMs) */
export function cleanOldTempFiles(maxAgeMs = 3_600_000): void {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    const now   = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const fp  = path.join(TEMP_DIR, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAgeMs) {
        safeDeleteTemp(fp);
      }
    }
  } catch {
    // تجاهل أخطاء التنظيف
  }
}
