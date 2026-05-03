// ═══════════════════════════════════════════════════════════════════
// Deterministic test for dedup-isPremium optimization (PR #3)
//
// قبل الإصلاح: كل hot-path call site كان بيـ trigger isPremium مرتين
//   (مرة صريحة + مرة جوا getUserDailyLimit).
//   isPremium ذاتها بتعمل 3 Redis ops (sismember + 2x exists).
//   النتيجة: 6 round-trips على نفس الـ user data في request واحد.
//
// بعد الإصلاح:
//   - getUserDailyLimit(userId, premHint?) لو متمرر premHint → ما يعملش isPremium داخلياً.
//   - getWishlistMax(userId, premHint?) نفس الفكرة.
//   - bookRequest.processBookRequest: يقرا ulimit + isPremium مرة واحدة، يحسب dailyLimit synchronously.
//
// هذه الاختبارات بتعد كم مرة isPremium نُديت بـ stub redis client.
// ═══════════════════════════════════════════════════════════════════

const PREMIUM_SET_KEY = "premium:users";
const DAILY_LIMIT     = 3;
const PREMIUM_LIMIT   = 15;

let callCount = { sismember: 0, exists: 0, get: 0 };
function resetCounts() { callCount = { sismember: 0, exists: 0, get: 0 }; }

const data = {
  sets:    new Map(),
  strings: new Map(),
};

function fakePipeline() {
  const ops = [];
  const api = {
    sismember(key, member) {
      ops.push(() => {
        callCount.sismember++;
        return data.sets.has(key) && data.sets.get(key).has(member) ? 1 : 0;
      });
      return api;
    },
    exists(key) {
      ops.push(() => {
        callCount.exists++;
        return data.strings.has(key) ? 1 : 0;
      });
      return api;
    },
    get(key) {
      ops.push(() => {
        callCount.get++;
        return data.strings.has(key) ? data.strings.get(key) : null;
      });
      return api;
    },
    async exec() { return ops.map(op => [null, op()]); },
  };
  return api;
}

const redis = {
  pipeline: fakePipeline,
  async sismember(key, member) {
    callCount.sismember++;
    return data.sets.has(key) && data.sets.get(key).has(member) ? 1 : 0;
  },
  async exists(key) {
    callCount.exists++;
    return data.strings.has(key) ? 1 : 0;
  },
  async get(key) {
    callCount.get++;
    return data.strings.has(key) ? data.strings.get(key) : null;
  },
  async srem() { return 1; },
};

// ── Replicate userSettings.ts logic ──────────────────────────────
const PREMIUM_EXP_KEY    = (uid) => `premium:exp:${uid}`;
const PREMIUM_MANUAL_KEY = (uid) => `premium:manual:${uid}`;
const ULIMIT_KEY         = (uid) => `ulimit:${uid}`;

async function isPremium(userId) {
  const res = await redis.pipeline()
    .sismember(PREMIUM_SET_KEY, userId)
    .exists(PREMIUM_EXP_KEY(userId))
    .exists(PREMIUM_MANUAL_KEY(userId))
    .exec();
  if (!res) return false;
  const inSet     = res[0]?.[1] === 1;
  const hasExp    = res[1]?.[1] === 1;
  const hasManual = res[2]?.[1] === 1;
  if (!inSet) return false;
  return hasExp || hasManual;
}

function computeDailyLimit(prem, override) {
  if (override !== null) {
    const n = parseInt(override, 10);
    if (!isNaN(n)) return n;
  }
  return prem ? PREMIUM_LIMIT : DAILY_LIMIT;
}

async function getUserDailyLimit(userId, premHint) {
  const [prem, override] = await Promise.all([
    premHint !== undefined ? Promise.resolve(premHint) : isPremium(userId),
    redis.get(ULIMIT_KEY(userId)),
  ]);
  return computeDailyLimit(prem, override);
}

// ── Tests ────────────────────────────────────────────────────────
let failed = 0;
function expect(name, ok, info) {
  if (ok) console.log(`[PASS] ${name}`);
  else    { console.log(`[FAIL] ${name}`, info ?? ""); failed++; }
}

console.log("=== T1: computeDailyLimit pure logic ===");
expect("T1.a free no override",     computeDailyLimit(false, null) === DAILY_LIMIT);
expect("T1.b premium no override",  computeDailyLimit(true,  null) === PREMIUM_LIMIT);
expect("T1.c override 99 wins",     computeDailyLimit(false, "99") === 99);
expect("T1.d override empty",       computeDailyLimit(true,  "")  === PREMIUM_LIMIT);
expect("T1.e override garbage",     computeDailyLimit(true,  "abc") === PREMIUM_LIMIT);
expect("T1.f override zero",        computeDailyLimit(false, "0") === 0);

console.log("=== T2: getUserDailyLimit without premHint hits isPremium ===");
data.sets.clear(); data.strings.clear();
data.sets.set(PREMIUM_SET_KEY, new Set(["u1"]));
data.strings.set(PREMIUM_EXP_KEY("u1"), "ts");
resetCounts();
const limit1 = await getUserDailyLimit("u1");
expect("T2.a returns PREMIUM_LIMIT", limit1 === PREMIUM_LIMIT);
expect("T2.b sismember called once",  callCount.sismember === 1, callCount);
expect("T2.c exists called twice",    callCount.exists === 2);
expect("T2.d get called once (ulimit)", callCount.get === 1);

console.log("=== T3: getUserDailyLimit WITH premHint skips isPremium ===");
resetCounts();
const limit2 = await getUserDailyLimit("u1", true);
expect("T3.a returns PREMIUM_LIMIT", limit2 === PREMIUM_LIMIT);
expect("T3.b sismember NOT called",  callCount.sismember === 0, callCount);
expect("T3.c exists NOT called",     callCount.exists === 0);
expect("T3.d only ulimit get",       callCount.get === 1);

console.log("=== T4: hot-path simulated: prem + dailyLimit pattern ===");
// Old pattern: Promise.all([isPremium, getUserDailyLimit]) → 2 isPremium internally
// New pattern: prem = isPremium; Promise.all([getUserDailyLimit(uid, prem), ...]) → 1 isPremium total
data.sets.set(PREMIUM_SET_KEY, new Set(["u2"]));
data.strings.set(PREMIUM_MANUAL_KEY("u2"), "ts");
data.strings.set(ULIMIT_KEY("u2"), "10");

resetCounts();
const prem = await isPremium("u2");
const [lim, _other] = await Promise.all([
  getUserDailyLimit("u2", prem),
  Promise.resolve("dl_count_stub"),
]);
expect("T4.a prem detected", prem === true);
expect("T4.b override 10 wins", lim === 10);
expect("T4.c sismember total = 1", callCount.sismember === 1, callCount);
expect("T4.d exists total = 2",    callCount.exists === 2);

console.log("=== T5: free user no override → DAILY_LIMIT ===");
data.sets.clear(); data.strings.clear();
data.sets.set(PREMIUM_SET_KEY, new Set([]));
resetCounts();
const free = await isPremium("u3");
const limFree = await getUserDailyLimit("u3", free);
expect("T5.a not premium", free === false);
expect("T5.b free DAILY_LIMIT",  limFree === DAILY_LIMIT);
expect("T5.c sismember = 1",     callCount.sismember === 1);

console.log(`\nResults: ${20 - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
