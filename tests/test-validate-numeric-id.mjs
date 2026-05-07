// ══════════════════════════════════════════════
// FIX-AUDIT: validateNumericId المحكم بـ Number.isSafeInteger
//
// Telegram user IDs الحالية ~10 أرقام (3.4×10^9 قصوى رصدت)، لكن الـ schema
// يقبل حتى 15 رقم. عند الوصول لـ 16 رقم يبدأ الـ floating-point error
// — Number("9007199254740993") === 9007199254740992 (silently lost a digit).
// الـ regex {5,15} يمنع 16+، لكن نضيف Number.isSafeInteger كحارس مزدوج.
// ══════════════════════════════════════════════

// نسخة محلية من الدالة (مكافئة لـ server/routes.ts)
function validateNumericId(id) {
  if (!/^\d{5,15}$/.test(id)) return false;
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0;
}

let passed = 0, failed = 0;
const cases = [
  // ── valid IDs ──
  { id: "12345",            expect: true,  reason: "5 digits — minimum allowed" },
  { id: "123456789",        expect: true,  reason: "typical 9-digit Telegram ID" },
  { id: "1234567890",       expect: true,  reason: "10 digits — current Telegram range" },
  { id: "999999999999999",  expect: true,  reason: "15 digits — schema max, still safe" },

  // ── rejected: format ──
  { id: "1234",             expect: false, reason: "4 digits — too short" },
  { id: "1234567890123456", expect: false, reason: "16 digits — exceeds regex" },
  { id: "abc12345",         expect: false, reason: "non-digits" },
  { id: "@username",        expect: false, reason: "Telegram @username (not numeric)" },
  { id: "12345.6",          expect: false, reason: "decimal" },
  { id: "-1234567",         expect: false, reason: "negative" },
  { id: "",                 expect: false, reason: "empty" },
  { id: " 12345 ",          expect: false, reason: "whitespace" },

  // ── rejected: bigint range (the audit fix) ──
  // 2^53 = 9007199254740992 = 16 digits — the regex blocks; in case some future
  // refactor relaxes the regex, isSafeInteger holds the line.
];

for (const c of cases) {
  const got = validateNumericId(c.id);
  const ok  = got === c.expect;
  if (ok) {
    passed++;
    console.log(`✓ ${c.id.padEnd(20)} → ${got} (${c.reason})`);
  } else {
    failed++;
    console.log(`✗ ${c.id.padEnd(20)} → got=${got} expected=${c.expect} (${c.reason})`);
  }
}

console.log(`\n──────────\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
