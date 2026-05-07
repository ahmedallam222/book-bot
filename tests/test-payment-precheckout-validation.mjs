/**
 * test-payment-precheckout-validation.mjs
 *
 * Verifies that pre_checkout_query approval is gated on:
 *   1. payload starts with "premium:"
 *   2. currency === "XTR"
 *   3. total_amount === PREMIUM_STARS_PRICE (100)
 *
 * Bug #24 from the post-deploy audit: the original handler called
 * `answerPreCheckoutQuery(query.id, true)` unconditionally, which would
 * approve stale invoices from a previous price tier or any forged invoice
 * regardless of payload/currency/amount.
 *
 * Bug #28: structured logging for amount/currency/payload reasons so that
 * replay attacks or anomalies are visible in logs.
 *
 * Approach: static-analyze server/bot/commands.ts AND the compiled bundle
 * for the validation gate, since spinning up a real Telegram bot to fire
 * synthetic pre_checkout_query events is impractical here.
 */
import fs from "node:fs";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { console.log(`PASS  ${name}`); pass++; }
  else      { console.log(`FAIL  ${name}`); fail++; }
}

const SRC    = fs.readFileSync("server/bot/commands.ts",   "utf8");
const BUNDLE = fs.existsSync("dist/index.cjs")
  ? fs.readFileSync("dist/index.cjs", "utf8")
  : "";

// ── E1: source-level guards ──
console.log("\n── E1: source guards in commands.ts ──");
ok("payload-prefix check",
   /payload\.startsWith\(\s*['"]premium:['"]\s*\)/.test(SRC));
ok("currency check (XTR)",
   /currency\s*!==\s*['"]XTR['"]/.test(SRC));
ok("amount check vs PREMIUM_STARS_PRICE",
   /amount\s*!==\s*PREMIUM_STARS_PRICE/.test(SRC));

// ── E2: rejection path explicitly responds with approved=false ──
console.log("\n── E2: rejection path ──");
ok("answerPreCheckoutQuery accepts an `approved` boolean (not hardcoded true)",
   /answerPreCheckoutQuery\(\s*query\.id\s*,\s*approved\s*[,)]/.test(SRC));
ok("rejection includes a user-facing error_message",
   /error_message:\s*['"][^'"]+['"]/.test(SRC));
ok("rejection log path exists",
   /pre_checkout rejected/.test(SRC));
ok("rejection counter incremented",
   /tel:payment:precheckout_rejected/.test(SRC));

// ── E3: approval log includes amount/currency/payload (Bug #28) ──
console.log("\n── E3: structured logging (Bug #28) ──");
const approvalBlock = SRC.match(/pre_checkout approved[\s\S]{0,300}/);
ok("approval log block present",     !!approvalBlock);
if (approvalBlock) {
  ok("logs amount on approval",   /amount/.test(approvalBlock[0]));
  ok("logs currency on approval", /currency/.test(approvalBlock[0]));
  ok("logs payload on approval",  /payload/.test(approvalBlock[0]));
}
const rejectBlock = SRC.match(/pre_checkout rejected[\s\S]{0,300}/);
if (rejectBlock) {
  ok("rejection log includes structured reason",  /reason/.test(rejectBlock[0]));
  ok("rejection log includes amount",             /amount/.test(rejectBlock[0]));
}

// ── E4: bundle ships these strings ──
console.log("\n── E4: bundle markers ──");
if (BUNDLE) {
  ok("bundle ships rejection log string",  BUNDLE.includes("pre_checkout rejected"));
  ok("bundle ships rejection counter",     BUNDLE.includes("tel:payment:precheckout_rejected"));
  // esbuild escapes Arabic to \uXXXX sequences (uppercase hex) in the bundle,
  // so match case-insensitively against the escaped form of "هذه الفاتورة".
  ok("bundle ships error_message Arabic (escaped)",
     /\\u0647\\u0630\\u0647 \\u0627\\u0644\\u0641\\u0627\\u062[Aa]\\u0648\\u0631\\u0629/i
       .test(BUNDLE));
  ok("bundle ships approval check",        /payload\.startsWith\(\s*["']premium:["']\s*\)/.test(BUNDLE));
} else {
  ok("bundle present (skipped — run npm run build first)", true);
}

// ── E5: regression — old unconditional approval is gone ──
console.log("\n── E5: regression — old code path removed ──");
ok("no unconditional answerPreCheckoutQuery(query.id, true)",
   !/answerPreCheckoutQuery\(\s*query\.id\s*,\s*true\s*\)/.test(SRC));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
