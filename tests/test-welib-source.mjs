// Deterministic probes for ar.welib.st source addition.
// Mirrors the style of test-mktbtypdf-source.mjs but adapted to the
// welibResolver Playwright flow:
//   1. Replicates `coerceToSlowDownloadUrl` and `isWelibHost` as pure
//      functions and exhaustively cases them.
//   2. Probes ARABIC_SOURCES wiring via a build-marker check on
//      dist/index.cjs.
//   3. Probes the throttle behaviour of `withWelibLock` by observing
//      the queue-tail Promise chain serialization (we don't import the
//      bot — Redis init would hang — so we re-implement the mutex
//      identically and prove it serializes).
//
// Does NOT actually launch Playwright (CI has no Chromium reliably).
// The Playwright integration is exercised by smoke tests inside the
// EC2 container after deploy.

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

// ── Replicated logic (must stay in sync with welibResolver.ts) ──

const MD5_PATH_RE  = /\/md5\/([a-f0-9]{32})/i;
const SLOW_PATH_RE = /\/slow_download\/([a-f0-9]{32})\/(\d+)\/(\d+)(?:\/convert)?/i;
const FAST_PATH_RE = /\/fast_download\/([a-f0-9]{32})\/(\d+)\/(\d+)(?:\/convert)?/i;

function isWelibHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(?:^|\.)welib\.(?:st|org)$/.test(host);
  } catch {
    return false;
  }
}

function coerceToSlowDownloadUrl(url) {
  try {
    const u = new URL(url);
    if (!isWelibHost(url)) return null;
    let m = u.pathname.match(SLOW_PATH_RE);
    if (m) return `https://${u.hostname}/slow_download/${m[1]}/${m[2]}/${m[3]}/convert`;
    m = u.pathname.match(FAST_PATH_RE);
    if (m) return `https://${u.hostname}/slow_download/${m[1]}/${m[2]}/${m[3]}/convert`;
    m = u.pathname.match(MD5_PATH_RE);
    if (m) return `https://${u.hostname}/slow_download/${m[1]}/0/0/convert`;
    return null;
  } catch {
    return null;
  }
}

// ── W1: isWelibHost ─────────────────────────────────────────────

console.log("─── W1: isWelibHost ───");
const HOST_CASES = [
  // welib mirrors → true
  ["https://ar.welib.st/md5/abc",                 true],
  ["https://welib.st/md5/abc",                    true],
  ["https://en.welib.st/",                        true],
  ["http://ar.welib.org/",                        true],
  ["https://welib.org/whatever",                  true],
  // similar but unrelated → false
  ["https://welib.com/md5/abc",                   false],
  ["https://notwelib.st/",                        false],
  ["https://welib-public.org/",                   false], // signed-CDN host, NOT the same domain
  ["https://s2.welib-public.org/abc",             false],
  ["https://google.com/url?q=https://welib.st",   false],
  // junk
  ["",                                            false],
  ["not-a-url",                                   false],
];
for (const [url, expected] of HOST_CASES) {
  const actual = isWelibHost(url);
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${(url || "(empty)").slice(0, 60).padEnd(60)} → ${actual}  (expected ${expected})`);
  if (ok) passed++; else failed++;
}

// ── W2: coerceToSlowDownloadUrl ─────────────────────────────────

console.log("\n─── W2: coerceToSlowDownloadUrl ───");
const MD5 = "dafd0ea674c31252270e61abc17457bc"; // user-provided real hash
const COERCE_CASES = [
  // /md5/{hash} → slow_download
  [
    `https://ar.welib.st/md5/${MD5}`,
    `https://ar.welib.st/slow_download/${MD5}/0/0/convert`,
  ],
  // /md5/{hash}#anchor → slow_download (fragments stripped by URL parse)
  [
    `https://ar.welib.st/md5/${MD5}#info`,
    `https://ar.welib.st/slow_download/${MD5}/0/0/convert`,
  ],
  // already-slow → normalized to /convert
  [
    `https://ar.welib.st/slow_download/${MD5}/0/0`,
    `https://ar.welib.st/slow_download/${MD5}/0/0/convert`,
  ],
  [
    `https://ar.welib.st/slow_download/${MD5}/0/0/convert`,
    `https://ar.welib.st/slow_download/${MD5}/0/0/convert`,
  ],
  // /fast_download → switched to slow
  [
    `https://ar.welib.st/fast_download/${MD5}/0/0/convert`,
    `https://ar.welib.st/slow_download/${MD5}/0/0/convert`,
  ],
  // alternative subdomains preserved
  [
    `https://en.welib.st/md5/${MD5}`,
    `https://en.welib.st/slow_download/${MD5}/0/0/convert`,
  ],
  // welib.org mirror
  [
    `https://welib.org/md5/${MD5}`,
    `https://welib.org/slow_download/${MD5}/0/0/convert`,
  ],

  // unrecognizable shapes → null
  [`https://ar.welib.st/search?q=foo`,             null],
  [`https://ar.welib.st/`,                         null],
  [`https://ar.welib.st/md5/short`,                null], // not 32 hex
  [`https://welib-public.org/${MD5}`,              null], // signed CDN, not the metadata host
  [`https://annas-archive.org/md5/${MD5}`,         null],
  [``,                                             null],
  [`not-a-url`,                                    null],
];
for (const [input, expected] of COERCE_CASES) {
  const actual = coerceToSlowDownloadUrl(input);
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${(input || "(empty)").slice(0, 65).padEnd(65)} → ${actual ?? "null"}`);
  if (ok) passed++; else failed++;
}

// ── W3: Throttle (withWelibLock serialization) ──────────────────
//
// We replicate the promise-chain mutex used in welibResolver.ts and
// verify that two concurrent calls to it execute strictly in series:
// the second call's start time must come AFTER the first call's end
// time.

console.log("\n─── W3: throttle (withWelibLock) ───");
{
  let _tail = Promise.resolve();
  function withLock(fn) {
    const next = _tail.then(() => fn(), () => fn());
    _tail = next.catch(() => undefined);
    return next;
  }

  const events = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const a = withLock(async () => {
    events.push({ task: "a", phase: "start", t: Date.now() });
    await sleep(40);
    events.push({ task: "a", phase: "end",   t: Date.now() });
    return "a";
  });
  const b = withLock(async () => {
    events.push({ task: "b", phase: "start", t: Date.now() });
    await sleep(15);
    events.push({ task: "b", phase: "end",   t: Date.now() });
    return "b";
  });

  const [ra, rb] = await Promise.all([a, b]);
  const aEnd   = events.find((e) => e.task === "a" && e.phase === "end").t;
  const bStart = events.find((e) => e.task === "b" && e.phase === "start").t;

  const okOrdering = ra === "a" && rb === "b";
  const okSerial   = bStart >= aEnd;

  console.log(`  ${okOrdering ? "PASS" : "FAIL"}  call order preserved (a, b)`);
  console.log(`  ${okSerial   ? "PASS" : "FAIL"}  task B starts only after task A ends (b.start=${bStart - aEnd}ms after a.end)`);
  if (okOrdering) passed++; else failed++;
  if (okSerial)   passed++; else failed++;
}

// ── W4: Throttle survives task error ────────────────────────────
//
// If task A throws, the queue tail must NOT be left in a rejected
// state — task B should still run. This guards against the
// "first welib resolver throws → all subsequent welib calls hang"
// regression that plain `tail = tail.then(fn)` would cause.

console.log("\n─── W4: throttle survives task error ───");
{
  let _tail = Promise.resolve();
  function withLock(fn) {
    const next = _tail.then(() => fn(), () => fn());
    _tail = next.catch(() => undefined);
    return next;
  }

  const a = withLock(async () => { throw new Error("boom"); });
  const b = withLock(async () => "ok");

  let aErr = null;
  try { await a; } catch (e) { aErr = e; }
  const bResult = await b;

  const okErrPropagated = aErr !== null && /boom/.test(String(aErr.message));
  const okBRan          = bResult === "ok";

  console.log(`  ${okErrPropagated ? "PASS" : "FAIL"}  task A's error propagated to caller`);
  console.log(`  ${okBRan          ? "PASS" : "FAIL"}  task B still ran after A's failure`);
  if (okErrPropagated) passed++; else failed++;
  if (okBRan)          passed++; else failed++;
}

// ── W5: Bundle marker check ──────────────────────────────────────
//
// Confirms tsx + esbuild emitted welibResolver into dist/index.cjs.
// Catches: dead-code elimination, accidentally-not-imported function.

console.log("\n─── W5: Bundle marker check (dist/index.cjs) ───");
try {
  const fs = await import("node:fs");
  const bundle = fs.readFileSync("dist/index.cjs", "utf-8");
  const checks = [
    ["downloadWelibPdf",                 1],   // welibDownloadAndSend imports it
    ["isWelibHost",                      1],   // download.ts uses it for routing
    ["welibDownloadAndSend",             1],   // download.ts internal handler
    ["shutdownWelibBrowser",             1],   // index.ts shutdown hook
    ["coerceToSlowDownloadUrl",          1],   // welibResolver internal
    ["welib-public.org",                 1],   // anchor href filter literal
    ["welib.st",                         3],   // sources.ts + welibResolver host check
    ["slow_download",                    1],   // url coercion template literal
  ];
  for (const [marker, minCount] of checks) {
    const count = (bundle.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    const ok = count >= minCount;
    console.log(`  ${ok ? "PASS" : "FAIL"}  marker "${marker}" found ${count} time(s) (expected ≥ ${minCount})`);
    if (ok) passed++; else failed++;
  }
} catch (e) {
  console.log(`  FAIL  bundle marker check error: ${String(e).slice(0, 120)}`);
  failed++;
}

// ── W6: ARABIC_SOURCES contains welib ───────────────────────────
//
// Read sources.ts directly (we can't import — Redis would hang in CI)
// and check that welib.st is present with the expected priority.

console.log("\n─── W6: ARABIC_SOURCES wiring (sources.ts) ───");
try {
  const fs = await import("node:fs");
  const src = fs.readFileSync("server/bot/sources.ts", "utf-8");
  const okDomain   = /domain:\s*"welib\.st"/.test(src);
  const okSearch   = /https:\/\/ar\.welib\.st\/search\?index=&q=/.test(src);
  const okIsArabic = /domain:\s*"welib\.st"[\s\S]{0,400}isArabic:\s*true/.test(src);
  console.log(`  ${okDomain ? "PASS" : "FAIL"}  sources.ts declares domain "welib.st"`);
  console.log(`  ${okSearch ? "PASS" : "FAIL"}  sources.ts wires ar.welib.st search URL`);
  console.log(`  ${okIsArabic ? "PASS" : "FAIL"}  welib entry has isArabic: true`);
  if (okDomain) passed++; else failed++;
  if (okSearch) passed++; else failed++;
  if (okIsArabic) passed++; else failed++;
} catch (e) {
  console.log(`  FAIL  sources.ts read error: ${String(e).slice(0, 120)}`);
  failed++;
}

console.log(`\n${passed}/${passed + failed} probes passed`);
assert.equal(failed, 0, `${failed} welib probes failed`);
process.exit(failed === 0 ? 0 : 1);
