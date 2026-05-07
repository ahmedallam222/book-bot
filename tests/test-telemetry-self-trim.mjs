// ═══════════════════════════════════════════════════════════════════
// Deterministic test for telemetry self-trim (PR #4)
//
// المشكلة: telemetry:traces list كانت تفضل بـ IDs ميتة بعد ما الـ
//   per-trace keys (telemetry:trace:{id}) انتهى TTL بتاعهم (1h).
//   النتيجة: getRecentTraces ترجع [] لأن mget كل الـ IDs ترجع null،
//   حتى لو الـ list فيها IDs.
//
// الإصلاح:
//   1. expire على telemetry:traces عند كل lpush (TRACES_LIST_TTL_SEC = 2h)
//      → الـ list نفسها تختفي بعد سكون طويل.
//   2. getRecentTraces بعد ما تعمل mget، لو لقيت stale IDs:
//        - كل الـ window stale → DEL على الـ list (أرخص من LREM متعدد)
//        - بعض stale → LREM لكل واحد (fire-and-forget pipeline)
// ═══════════════════════════════════════════════════════════════════

const TRACES_LIST   = "telemetry:traces";
const TRACE_TTL_SEC = 3600;
const TRACES_MAX    = 500;
const TRACES_LIST_TTL_SEC = TRACE_TTL_SEC * 2;

// In-memory Redis stub
let now = 1_700_000_000_000;
const data = {
  strings: new Map(), // key -> { val, expiresAt | null }
  lists:   new Map(), // key -> { items: string[], expiresAt | null }
};
function jumpForward(seconds) { now += seconds * 1000; }
function isAlive(entry) {
  if (!entry) return false;
  if (entry.expiresAt === null || entry.expiresAt === undefined) return true;
  return entry.expiresAt > now;
}
function gcExpired() {
  for (const [k, v] of data.strings) if (!isAlive(v)) data.strings.delete(k);
  for (const [k, v] of data.lists)   if (!isAlive(v)) data.lists.delete(k);
}

const redis = {
  async lrange(key, start, stop) {
    gcExpired();
    const e = data.lists.get(key);
    if (!isAlive(e)) return [];
    const items = e.items;
    const len = items.length;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const t = stop  < 0 ? len + stop : stop;
    return items.slice(s, t + 1);
  },
  async mget(...keys) {
    gcExpired();
    return keys.map((k) => {
      const e = data.strings.get(k);
      return isAlive(e) ? e.val : null;
    });
  },
  async del(key) {
    const had = data.strings.has(key) || data.lists.has(key);
    data.strings.delete(key);
    data.lists.delete(key);
    return had ? 1 : 0;
  },
  pipeline() {
    const ops = [];
    const api = {
      set(key, val, _ex, ttlSec) {
        ops.push(() => {
          data.strings.set(key, { val, expiresAt: now + ttlSec * 1000 });
        });
        return api;
      },
      lpush(key, ...items) {
        ops.push(() => {
          let e = data.lists.get(key);
          if (!isAlive(e)) e = { items: [], expiresAt: null };
          e.items = [...items.reverse(), ...e.items];
          data.lists.set(key, e);
        });
        return api;
      },
      ltrim(key, start, stop) {
        ops.push(() => {
          const e = data.lists.get(key);
          if (!e) return;
          const len = e.items.length;
          const s = start < 0 ? Math.max(0, len + start) : start;
          const t = stop  < 0 ? len + stop : stop;
          e.items = e.items.slice(s, t + 1);
        });
        return api;
      },
      expire(key, ttlSec) {
        ops.push(() => {
          if (data.lists.has(key))   data.lists.get(key).expiresAt   = now + ttlSec * 1000;
          if (data.strings.has(key)) data.strings.get(key).expiresAt = now + ttlSec * 1000;
        });
        return api;
      },
      lrem(key, count, value) {
        ops.push(() => {
          const e = data.lists.get(key);
          if (!e) return;
          // count=0 → احذف كل المطابقات (per ioredis semantics)
          e.items = e.items.filter((i) => i !== value);
        });
        return api;
      },
      async exec() { for (const op of ops) op(); return ops.map(() => [null, "OK"]); },
    };
    return api;
  },
};

// ── Replicate telemetry.ts logic ────────────────────────────────
async function saveTrace(id, payload) {
  await redis.pipeline()
    .set(`telemetry:trace:${id}`, JSON.stringify(payload), "EX", TRACE_TTL_SEC)
    .lpush(TRACES_LIST, id)
    .ltrim(TRACES_LIST, 0, TRACES_MAX - 1)
    .expire(TRACES_LIST, TRACES_LIST_TTL_SEC)
    .exec();
}

async function pruneStaleTraceIds(staleIds, fetchedCount) {
  if (staleIds.length === fetchedCount) {
    await redis.del(TRACES_LIST);
    return;
  }
  const pipe = redis.pipeline();
  for (const id of staleIds) pipe.lrem(TRACES_LIST, 0, id);
  await pipe.exec();
}

async function getRecentTraces(limit = 50) {
  const ids  = await redis.lrange(TRACES_LIST, 0, limit - 1);
  if (!ids.length) return [];
  const raws = await redis.mget(...ids.map((id) => `telemetry:trace:${id}`));
  const staleIds = [];
  const result   = [];
  for (let i = 0; i < ids.length; i++) {
    const raw = raws[i];
    if (raw === null || raw === undefined) { staleIds.push(ids[i]); continue; }
    try { result.push(JSON.parse(raw)); }
    catch { staleIds.push(ids[i]); }
  }
  if (staleIds.length > 0) {
    await pruneStaleTraceIds(staleIds, ids.length);
  }
  return result;
}

// ── Tests ────────────────────────────────────────────────────────
let failed = 0, total = 0;
function expect(name, ok, info) {
  total++;
  if (ok) console.log(`[PASS] ${name}`);
  else    { console.log(`[FAIL] ${name}`, info ?? ""); failed++; }
}
async function clear() {
  data.strings.clear();
  data.lists.clear();
  now = 1_700_000_000_000;
}

console.log("=== T1: list TTL prevents perpetual growth ===");
await clear();
await saveTrace("t1", { id: "t1", book: "A" });
{
  const e = data.lists.get(TRACES_LIST);
  expect("T1.a list has TTL set",      e.expiresAt !== null);
  expect("T1.b list TTL = 2h ahead",   e.expiresAt === now + TRACES_LIST_TTL_SEC * 1000);
}
jumpForward(TRACES_LIST_TTL_SEC + 100);
{
  gcExpired();
  expect("T1.c list expires after 2h silence", !data.lists.has(TRACES_LIST));
}

console.log("=== T2: stale IDs are removed by getRecentTraces ===");
await clear();
await saveTrace("a", { id: "a" });
await saveTrace("b", { id: "b" });
await saveTrace("c", { id: "c" });

// Jump 1.5h → per-trace keys expire (TTL=1h), list still alive (TTL=2h)
jumpForward(TRACE_TTL_SEC + 100);
gcExpired();
{
  const e = data.lists.get(TRACES_LIST);
  expect("T2.a list still present after 1h", isAlive(e));
  expect("T2.b list has 3 stale IDs",        e.items.length === 3);
  expect("T2.c per-trace keys all expired",
    !data.strings.has("telemetry:trace:a") &&
    !data.strings.has("telemetry:trace:b") &&
    !data.strings.has("telemetry:trace:c"));
}

const traces = await getRecentTraces();
expect("T2.d getRecentTraces returns empty", traces.length === 0);
expect("T2.e list deleted after all-stale prune", !data.lists.has(TRACES_LIST));

console.log("=== T3: partial stale → LREM individually ===");
await clear();
await saveTrace("old1", { id: "old1" });
await saveTrace("old2", { id: "old2" });
jumpForward(TRACE_TTL_SEC + 100); // expire old1, old2
await saveTrace("fresh", { id: "fresh" }); // refresh list TTL
expect("T3.a list has 3 items (2 stale + 1 fresh)",
  data.lists.get(TRACES_LIST).items.length === 3);

const traces2 = await getRecentTraces();
expect("T3.b returns 1 fresh trace",       traces2.length === 1);
expect("T3.c fresh trace ID is 'fresh'",   traces2[0].id === "fresh");
{
  const e = data.lists.get(TRACES_LIST);
  expect("T3.d list still exists",         e !== undefined);
  expect("T3.e list pruned to 1 item",     e.items.length === 1);
  expect("T3.f remaining ID is 'fresh'",   e.items[0] === "fresh");
}

console.log("=== T4: empty list → no-op ===");
await clear();
const traces3 = await getRecentTraces();
expect("T4.a empty list returns []",       traces3.length === 0);
expect("T4.b list not created",            !data.lists.has(TRACES_LIST));

console.log("=== T5: all alive → no prune happens ===");
await clear();
await saveTrace("x", { id: "x" });
await saveTrace("y", { id: "y" });
const traces4 = await getRecentTraces();
expect("T5.a returns 2 traces",            traces4.length === 2);
expect("T5.b list unchanged (2 items)",    data.lists.get(TRACES_LIST).items.length === 2);

console.log(`\nResults: ${total - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
