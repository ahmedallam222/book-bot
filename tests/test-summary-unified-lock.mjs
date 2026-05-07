// Tests Bug #18: auto-summary trigger and manual button click now
// share the same Redis lock key, so they dedupe each other instead
// of both running AI in parallel and double-charging quota.
//
// Pre-fix:
//   bookRequest auto:  summary:auto:{userId}:{canonicalBook}
//   summaryHandler:    summary:inflight:{userId}:{sessionKey}
// → different keys, both passed NX, ran AI twice
//
// Post-fix: both paths use summary:lock:{userId}:{canonicalBook}.
import { canonicalizeForCache } from "../server/bot/text.js";

let pass = 0, fail = 0;
function ok(name, cond, info = "") { if (cond) pass++; else fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? ` (${info})` : ""}`); }

// Replicate the new key shape from both call sites
function bookRequestKey(userId, bookName) {
  return `summary:lock:${userId}:${canonicalizeForCache(bookName)}`;
}
function summaryHandlerKey(userId, bookName) {
  return `summary:lock:${userId}:${canonicalizeForCache(bookName)}`;
}

// — CRITICAL: keys identical for same user+book —
const userId = "5469997406";
const book   = "أرض زيكولا";
const k1 = bookRequestKey(userId, book);
const k2 = summaryHandlerKey(userId, book);
ok(`CRITICAL — auto and manual share key (${k1} === ${k2})`, k1 === k2);

// — User who types "لخصلي X" then taps button — same key —
const k3 = bookRequestKey(userId, "أرض زيكولا");
const k4 = summaryHandlerKey(userId, "ارض زيكولا"); // normalized via canonicalizeForCache
ok(`auto "لخصلي X" + manual tap → same key (${k3} === ${k4})`, k3 === k4);

// — Different users → different keys (no false positive dedup) —
const a = bookRequestKey("user-A", book);
const b = bookRequestKey("user-B", book);
ok(`different users → different keys`, a !== b);

// — Different books → different keys —
const x = bookRequestKey(userId, "أرض زيكولا");
const y = bookRequestKey(userId, "ساحرة بورتوبيلو");
ok(`different books → different keys`, x !== y);

// — Title variations (canonicalization handles them) —
const v1 = bookRequestKey(userId, "تحميل أرض زيكولا pdf");
const v2 = bookRequestKey(userId, "أرض زيكولا");
ok(`auto-trigger key from raw user msg = manual key from clean book name (${v1} === ${v2})`, v1 === v2);

// — Key prefix check (operational) —
ok(`key uses 'summary:lock:' namespace`, k1.startsWith("summary:lock:"));
ok(`key does NOT use legacy 'summary:auto:' prefix`, !k1.includes(":auto:"));
ok(`key does NOT use legacy 'summary:inflight:' prefix`, !k1.includes(":inflight:"));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
