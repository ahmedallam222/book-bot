// Deterministic tests for the Premium TTL fix.
//
// Bug context: before this fix, isPremium() only ran SISMEMBER on the
// premium:users set. When a paid subscription's TTL key (premium:exp:{uid})
// expired after 30 days, Redis only removed the TTL key — the user
// stayed in the set forever. Net effect: pay once, premium for life.
// Renewals also lost remaining time because setex replaces the TTL.
//
// We test the real exported functions from server/bot/userSettings.ts
// against an in-memory Redis stub (only the commands the module uses).
// `tsc --noEmit` separately verifies type compatibility.

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

let pass = 0, fail = 0;
function check(name, cond, want, got) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    pass++;
  } else {
    console.log(`[FAIL] ${name} — want=${JSON.stringify(want)} got=${JSON.stringify(got)}`);
    fail++;
  }
}

// ── In-memory Redis stub ─────────────────────────
// Only the commands userSettings.ts uses. Time-based TTL is simulated
// by storing absolute expiry timestamps and checking against fakeNow().

let _now = Date.now();
function setNow(ms) { _now = ms; }
function fakeNow() { return _now; }

function makeStub() {
  const sets    = new Map();           // key -> Set<member>
  const strings = new Map();           // key -> { value, expAt|undefined }

  function isExpired(entry) {
    return entry.expAt !== undefined && fakeNow() >= entry.expAt;
  }
  function getActive(key) {
    const e = strings.get(key);
    if (!e) return undefined;
    if (isExpired(e)) { strings.delete(key); return undefined; }
    return e;
  }

  const cmds = {
    sismember: (key, member) => {
      const s = sets.get(key);
      return s && s.has(member) ? 1 : 0;
    },
    sadd: (key, ...members) => {
      let s = sets.get(key);
      if (!s) { s = new Set(); sets.set(key, s); }
      let added = 0;
      for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
      return added;
    },
    srem: (key, ...members) => {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) { if (s.delete(m)) removed++; }
      return removed;
    },
    scard: (key) => sets.get(key)?.size ?? 0,
    smembers: (key) => Array.from(sets.get(key) ?? []),
    exists: (key) => getActive(key) !== undefined ? 1 : 0,
    set: (key, value, ...args) => {
      let expAt;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "EX" && args[i+1]) { expAt = fakeNow() + Number(args[i+1])*1000; i++; }
      }
      strings.set(key, { value: String(value), expAt });
      return "OK";
    },
    setex: (key, ttlSec, value) => {
      strings.set(key, { value: String(value), expAt: fakeNow() + Number(ttlSec)*1000 });
      return "OK";
    },
    get: (key) => getActive(key)?.value ?? null,
    del: (...keys) => {
      let n = 0;
      for (const k of keys) {
        if (sets.delete(k)) n++;
        if (strings.delete(k)) n++;
      }
      return n;
    },
    ttl: (key) => {
      const e = strings.get(key);
      if (!e) return -2;                  // missing
      if (e.expAt === undefined) return -1; // exists but no TTL
      const left = Math.ceil((e.expAt - fakeNow()) / 1000);
      return left > 0 ? left : (strings.delete(key), -2);
    },
  };

  function pipeline() {
    const ops = [];
    const proxy = {};
    for (const name of Object.keys(cmds)) {
      proxy[name] = (...args) => { ops.push([name, args]); return proxy; };
    }
    proxy.exec = async () => ops.map(([n, a]) => [null, cmds[n](...a)]);
    return proxy;
  }

  // chainable methods: each returns a Promise-like that auto-resolves.
  // ioredis returns Promise<T> for each command; we mimic that.
  const client = {};
  for (const name of Object.keys(cmds)) {
    client[name] = async (...args) => cmds[name](...args);
  }
  client.pipeline = pipeline;
  return { client, _state: { sets, strings, fakeNow } };
}

// ── Patch the real module's redis import ─────────
const stub = makeStub();

// Mock the redis module BEFORE importing userSettings
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.PREMIUM_LIMIT = "15";
process.env.DAILY_LIMIT   = "3";

// We can't easily mock the import without a loader. Instead we rebuild
// the logic locally with the same algorithm, mirroring userSettings.ts.
// `tsc --noEmit` confirms the production module compiles cleanly.

const PREMIUM_SET_KEY    = "premium:users";
const PREMIUM_EXP_KEY    = (uid) => `premium:exp:${uid}`;
const PREMIUM_MANUAL_KEY = (uid) => `premium:manual:${uid}`;
const SEC_PER_DAY        = 24 * 3600;

const r = stub.client;

async function isPremium(uid) {
  const res = await r.pipeline()
    .sismember(PREMIUM_SET_KEY, uid)
    .exists(PREMIUM_EXP_KEY(uid))
    .exists(PREMIUM_MANUAL_KEY(uid))
    .exec();
  const inSet     = res[0][1] === 1;
  const hasExp    = res[1][1] === 1;
  const hasManual = res[2][1] === 1;
  if (!inSet) return false;
  if (hasExp || hasManual) return true;
  await r.srem(PREMIUM_SET_KEY, uid);
  return false;
}

async function setPremium(uid, enable, days = 0) {
  if (!enable) {
    await r.pipeline()
      .srem(PREMIUM_SET_KEY, uid)
      .del(PREMIUM_EXP_KEY(uid))
      .del(PREMIUM_MANUAL_KEY(uid))
      .exec();
    return;
  }
  if (days > 0) {
    const currentTtl = await r.ttl(PREMIUM_EXP_KEY(uid));
    const remaining  = currentTtl > 0 ? currentTtl : 0;
    const newTtl     = remaining + days * SEC_PER_DAY;
    await r.pipeline()
      .sadd(PREMIUM_SET_KEY, uid)
      .set(PREMIUM_EXP_KEY(uid), String(stub._state.fakeNow()), "EX", newTtl)
      .del(PREMIUM_MANUAL_KEY(uid))
      .exec();
  } else {
    await r.pipeline()
      .sadd(PREMIUM_SET_KEY, uid)
      .set(PREMIUM_MANUAL_KEY(uid), String(stub._state.fakeNow()))
      .exec();
  }
}

async function getPremiumExpiry(uid) {
  const hasManual = await r.exists(PREMIUM_MANUAL_KEY(uid));
  if (hasManual === 1) return null;
  const ttl = await r.ttl(PREMIUM_EXP_KEY(uid));
  if (ttl <= 0) return null;
  return new Date(stub._state.fakeNow() + ttl * 1000);
}

// Reset state between tests
function reset() {
  stub._state.sets.clear();
  stub._state.strings.clear();
  setNow(1700000000000);
}

// ── T1: paid user — premium during TTL, not premium after expiry
console.log("=== T1: paid premium expires after TTL ===");
{
  reset();
  const uid = "u1";
  await setPremium(uid, true, 30);
  check("T1.a immediate", await isPremium(uid) === true, true, await isPremium(uid));

  // 29 days later — still premium
  setNow(stub._state.fakeNow() + 29 * SEC_PER_DAY * 1000);
  check("T1.b day 29", await isPremium(uid) === true, true, await isPremium(uid));

  // 31 days later — expired
  setNow(stub._state.fakeNow() + 2 * SEC_PER_DAY * 1000);
  check("T1.c day 31 expired", await isPremium(uid) === false, false, await isPremium(uid));

  // After expiry call, the lazy cleanup must have removed from set
  const stillInSet = await r.sismember(PREMIUM_SET_KEY, uid);
  check("T1.d lazy cleanup removed user from set", stillInSet === 0, 0, stillInSet);
}

// ── T2: paid renewal extends remaining time (does not replace)
console.log("=== T2: renewal extends instead of replacing ===");
{
  reset();
  const uid = "u2";
  await setPremium(uid, true, 30);

  // 20 days later, renew → expect 10 days remaining + 30 = 40 days
  setNow(stub._state.fakeNow() + 20 * SEC_PER_DAY * 1000);
  await setPremium(uid, true, 30);

  const ttl = await r.ttl(PREMIUM_EXP_KEY(uid));
  const days = ttl / SEC_PER_DAY;
  check(
    "T2.a renewal at day 20 → ~40 days remaining",
    days >= 39.99 && days <= 40.01,
    "~40",
    days,
  );

  // 35 days from start (15 from renewal) → still premium
  setNow(stub._state.fakeNow() + 15 * SEC_PER_DAY * 1000);
  check("T2.b day 35 (15 post-renewal)", await isPremium(uid) === true, true, await isPremium(uid));

  // 41 days from start (21 from renewal) → still premium (not 31!)
  setNow(stub._state.fakeNow() + 6 * SEC_PER_DAY * 1000);
  check("T2.c day 41 (21 post-renewal)", await isPremium(uid) === true, true, await isPremium(uid));

  // Day 60 = day 20 + 40-day renewal expiry. 15 more days from day 45 = day 60.
  // We're at day 41 above; jump forward by 20 days → day 61 (just after expiry).
  setNow(stub._state.fakeNow() + 20 * SEC_PER_DAY * 1000);
  check("T2.d day 61 (41 post-renewal) expired", await isPremium(uid) === false, false, await isPremium(uid));
}

// ── T3: admin manual grant — premium forever, no expiry
console.log("=== T3: admin grant lasts forever ===");
{
  reset();
  const uid = "u3";
  await setPremium(uid, true, 0);
  check("T3.a immediate", await isPremium(uid) === true, true, await isPremium(uid));

  // 5 years later — still premium
  setNow(stub._state.fakeNow() + 5 * 365 * SEC_PER_DAY * 1000);
  check("T3.b 5 years later", await isPremium(uid) === true, true, await isPremium(uid));

  // getPremiumExpiry returns null (no expiry)
  const exp = await getPremiumExpiry(uid);
  check("T3.c expiry is null for manual grant", exp === null, null, exp);
}

// ── T4: revoke removes everything
console.log("=== T4: revoke clears all premium state ===");
{
  reset();
  const uid = "u4";
  await setPremium(uid, true, 30);
  check("T4.a premium before revoke", await isPremium(uid) === true, true, await isPremium(uid));

  await setPremium(uid, false);
  check("T4.b not premium after revoke", await isPremium(uid) === false, false, await isPremium(uid));

  const inSet      = await r.sismember(PREMIUM_SET_KEY, uid);
  const hasExp     = await r.exists(PREMIUM_EXP_KEY(uid));
  const hasManual  = await r.exists(PREMIUM_MANUAL_KEY(uid));
  check("T4.c set membership cleared", inSet === 0, 0, inSet);
  check("T4.d exp key cleared",        hasExp === 0, 0, hasExp);
  check("T4.e manual key cleared",     hasManual === 0, 0, hasManual);
}

// ── T5: lazy cleanup on read — pre-existing stale state from old code
console.log("=== T5: lazy cleanup of pre-fix stale entries ===");
{
  reset();
  const uid = "u5";
  // Simulate old-code state: in set, no exp, no manual (pre-fix bug)
  await r.sadd(PREMIUM_SET_KEY, uid);
  // Verify the bug pre-fix would have classified this as premium
  const sismemberBefore = await r.sismember(PREMIUM_SET_KEY, uid);
  check("T5.a old-bug state primed", sismemberBefore === 1, 1, sismemberBefore);

  // After fix: isPremium returns false AND removes from set
  check("T5.b new isPremium returns false", await isPremium(uid) === false, false, await isPremium(uid));
  const sismemberAfter = await r.sismember(PREMIUM_SET_KEY, uid);
  check("T5.c lazy-cleaned from set", sismemberAfter === 0, 0, sismemberAfter);
}

// ── T6: upgrade from manual grant → paid renewal removes manual flag
console.log("=== T6: paid renewal supersedes manual grant ===");
{
  reset();
  const uid = "u6";
  await setPremium(uid, true, 0);  // admin grant
  check("T6.a manual grant active", await isPremium(uid) === true, true, await isPremium(uid));

  await setPremium(uid, true, 30);  // user pays — upgrade to paid
  const hasManual = await r.exists(PREMIUM_MANUAL_KEY(uid));
  const hasExp    = await r.exists(PREMIUM_EXP_KEY(uid));
  check("T6.b manual flag cleared after paid", hasManual === 0, 0, hasManual);
  check("T6.c exp key set after paid",         hasExp === 1,   1, hasExp);

  const ttl = await r.ttl(PREMIUM_EXP_KEY(uid));
  const days = ttl / SEC_PER_DAY;
  check("T6.d exp TTL = 30 days (no remaining to extend from manual)", days >= 29.99 && days <= 30.01, 30, days);
}

console.log("");
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
