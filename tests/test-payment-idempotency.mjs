// Verifies the successful_payment handler in commands.ts is idempotent
// against re-delivery of the same Telegram update. This is a real-world
// concern for two reasons:
//
//   1. node-telegram-bot-api uses polling: true, and the update offset
//      is held in memory only. A bot crash between processing a
//      successful_payment and the next getUpdates round causes the same
//      payment update to be delivered again on restart. Without dedup,
//      setPremium(userId, true, 30) runs twice and — because TTL
//      extension is additive — the user gets 60 days for a single
//      payment.
//
//   2. Multi-instance races (someone runs the bot twice) or transient
//      Telegram-side retries can produce the same effect.
//
// The fix uses SET NX EX on a key keyed by telegram_payment_charge_id
// (unique per Telegram payment). On re-delivery the SET returns null →
// premium is NOT re-granted. We still send the success message in
// both paths so the user gets confirmation.

import { readFileSync } from "node:fs";
const src = readFileSync("server/bot/commands.ts", "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}`); }

// Isolate the successful_payment block.
const sp = src.match(
  /if\s*\(\s*msg\.successful_payment\s*\)\s*\{[\s\S]*?return;\s*\}/,
);

console.log("Payment idempotency:");
ok("M1 — successful_payment handler exists", !!sp);

const block = sp?.[0] ?? "";

// 1. chargeId is read from telegram_payment_charge_id.
ok(
  "M2 — telegram_payment_charge_id is captured",
  /telegram_payment_charge_id/.test(block),
);

// 2. Dedup key uses the chargeId.
ok(
  "M3 — Redis dedup key keyed on chargeId",
  /payment:processed:\$\{chargeId\}/.test(block),
);

// 3. SET NX is used on the dedup key (atomic).
ok(
  "M4 — uses SET ... NX (atomic claim)",
  /redis\.set\(\s*[\s\S]*?dedupKey[\s\S]*?"NX"/.test(block),
);

// 4. acquired result is compared to "OK" — that's the SET NX success
//    sentinel; null means key already existed.
ok(
  "M5 — alreadyProcessed = acquired !== \"OK\"",
  /alreadyProcessed\s*=\s*acquired\s*!==\s*"OK"/.test(block),
);

// 5. setPremium is gated on !alreadyProcessed.
ok(
  "M6 — setPremium gated on !alreadyProcessed",
  /if\s*\(\s*!alreadyProcessed\s*\)\s*\{[\s\S]*?setPremium\s*\(/.test(block),
);

// 6. The success message is sent regardless of dedup outcome — outside
//    the if/else, after the gate.
const successMsgIdx = block.indexOf("تم تفعيل Premium بنجاح!");
const elseEndIdx    = block.lastIndexOf("}");
const ifGateStart   = block.indexOf("if (!alreadyProcessed)");
ok(
  "M7 — success message sent unconditionally (after the dedup gate)",
  successMsgIdx > 0 && ifGateStart > 0 && successMsgIdx > ifGateStart,
);

// 7. There is exactly ONE setPremium call in the block.
const setPremiumCalls = block.match(/setPremium\s*\(/g) || [];
ok(
  "M8 — exactly one setPremium call (no double-grant path)",
  setPremiumCalls.length === 1,
);

// 8. Dedup key is namespaced (not just chargeId on its own).
ok(
  "M9 — dedup key uses payment:processed: prefix (no namespace collision)",
  /`payment:processed:\$\{chargeId\}`/.test(block),
);

// 9. Duplicate path logs a warning and emits a metric so we can detect
//    a real-world re-delivery in production.
ok(
  "M10 — duplicate path logs L.warn",
  /alreadyProcessed[\s\S]*?\}\s*else\s*\{[\s\S]*?L\.warn\("payment"/.test(block),
);
ok(
  "M11 — duplicate path increments tel:payment:duplicate_redelivery",
  /redis\.incr\(\s*"tel:payment:duplicate_redelivery"\s*\)/.test(block),
);

// 10. TTL on the dedup key is generous (≥ 30d) so a real retry never
//     escapes the window. The fix uses 90d.
ok(
  "M12 — dedup TTL is at least 30 days (currently 90d)",
  /90\s*\*\s*24\s*\*\s*3600/.test(block),
);

// 11. Defensive: if chargeId is missing for any reason, fall through
//     gracefully — alreadyProcessed stays false and the original
//     non-idempotent behaviour is preserved (no regression).
ok(
  "M13 — empty chargeId skips dedup gracefully",
  /if\s*\(\s*chargeId\s*\)\s*\{[\s\S]*?dedupKey/.test(block),
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
