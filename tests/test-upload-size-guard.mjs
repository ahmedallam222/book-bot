// Pins oversized PDF / Telegram 413 config + pure size-error detection.
// (Does not import download.ts — that module pulls Redis/Telegram on load.)
import { MAX_PDF_SIZE, TELEGRAM_BOT_UPLOAD_MAX } from "../server/bot/config.ts";

function isTelegramUploadSizeError(err) {
  const e = String((err && err.message) || err || "").toLowerCase();
  return (
    e.includes("413") ||
    e.includes("request entity too large") ||
    e.includes("file is too big") ||
    e.includes("file_too_big") ||
    e.includes("payload too large") ||
    (e.includes("document_invalid") && e.includes("size"))
  );
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + " got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)); }
}

check("MAX_PDF_SIZE under 50MB", MAX_PDF_SIZE < 50 * 1024 * 1024, true);
check("MAX_PDF_SIZE at least 40MB", MAX_PDF_SIZE >= 40 * 1024 * 1024, true);
check("TELEGRAM_BOT_UPLOAD_MAX alias", TELEGRAM_BOT_UPLOAD_MAX, MAX_PDF_SIZE);
check("detects 413", isTelegramUploadSizeError("ETELEGRAM: 413 Request Entity Too Large"), true);
check("detects entity too large", isTelegramUploadSizeError(new Error("Request Entity Too Large")), true);
check("detects file too big", isTelegramUploadSizeError("file is too big"), true);
check("ignores network", isTelegramUploadSizeError("ECONNRESET"), false);
check("ignores timeout", isTelegramUploadSizeError("UPLOAD_TIMEOUT"), false);

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exit(1);