// Deterministic probes for the welib Cloudflare Worker proxy wiring.
//
// Why this matters:
//   welib's CDN (welib-public.org and friends) blocks public-cloud egress
//   IPs. Production runs on AWS EC2 so direct fetches of the signed URL
//   time out at 90s. The Cloudflare Worker proxy in
//   `cloudflare/welib-proxy/` solves this by relaying the fetch from a
//   non-blocked IP. This test pins the wiring contract:
//
//     1. The bot-side helper `buildProxyFetchTarget` must:
//          - return the signed URL untouched when the proxy is not
//            configured (fallback path),
//          - return a worker URL with `?url=` and `Authorization: Bearer`
//            header when both env vars are set,
//          - fall back gracefully when WELIB_PROXY_URL is malformed.
//     2. The Worker source `cloudflare/welib-proxy/src/worker.js` must:
//          - require a bearer secret (no anonymous access),
//          - restrict outbound fetch to the welib-public.org allowlist,
//          - never log secrets,
//          - expose a /health endpoint without auth.
//     3. config.ts must export WELIB_PROXY_URL / WELIB_PROXY_SECRET as
//        trimmed strings (so trailing newlines from .env files don't
//        leak into the Authorization header).
//
// The Worker is not actually executed here (no wrangler in CI). We
// validate its source via static checks; live behaviour is verified
// after deploy via the `wrangler tail` smoke test in the PR description.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ── P1: Import the helper directly from the resolver. ──
//
// We use a dynamic import after stubbing the env vars so any
// module-level reads see deterministic values. welibResolver.ts only
// touches playwright-core via dynamic import inside getBrowser(), so a
// plain import is safe in CI.

console.log("─── P1: buildProxyFetchTarget — fallback path ───");
let buildProxyFetchTarget;
try {
  ({ buildProxyFetchTarget } = await import("../server/bot/welibResolver.ts"));
  check("imported buildProxyFetchTarget from welibResolver.ts",
        typeof buildProxyFetchTarget === "function");
} catch (e) {
  check("imported buildProxyFetchTarget", false, String(e).slice(0, 120));
  console.log("\n────────────────────────────────────────────────");
  console.log(`Total pass=${passed}  fail=${failed}`);
  process.exit(1);
}

const SIGNED = "https://s2.welib-public.org/abc123/Book.pdf";

// 1a. No proxy configured → returns signed URL verbatim, no Auth header.
{
  const r = buildProxyFetchTarget(SIGNED, "", "");
  check("no proxy: viaProxy=false",  r.viaProxy === false);
  check("no proxy: fetchUrl unchanged", r.fetchUrl === SIGNED);
  check("no proxy: no Authorization header",
        !("Authorization" in r.headers),
        `headers: ${Object.keys(r.headers).join(",")}`);
  check("no proxy: User-Agent set",
        typeof r.headers["User-Agent"] === "string" && r.headers["User-Agent"].length > 10);
}

// 1b. Only URL set, secret missing → fallback (we treat as not-configured).
{
  const r = buildProxyFetchTarget(SIGNED, "https://welib-proxy.example.workers.dev/", "");
  check("partial config (no secret): viaProxy=false", r.viaProxy === false);
  check("partial config (no secret): fetchUrl unchanged", r.fetchUrl === SIGNED);
}

// 1c. Only secret set, URL missing → fallback.
{
  const r = buildProxyFetchTarget(SIGNED, "", "deadbeef");
  check("partial config (no url): viaProxy=false", r.viaProxy === false);
  check("partial config (no url): fetchUrl unchanged", r.fetchUrl === SIGNED);
}

// ── P2: Proxy configured ─────────────────────────────────────────
console.log("\n─── P2: buildProxyFetchTarget — proxied path ───");
{
  const PROXY  = "https://welib-proxy.example.workers.dev/";
  const SECRET = "s3cret-token-32-bytes-or-whatever-you-set";
  const r = buildProxyFetchTarget(SIGNED, PROXY, SECRET);

  check("viaProxy=true", r.viaProxy === true);

  const u = new URL(r.fetchUrl);
  check("host = workers.dev", u.host === "welib-proxy.example.workers.dev");
  check("?url= contains signed URL (decoded)", u.searchParams.get("url") === SIGNED);
  check("Authorization header is Bearer + secret",
        r.headers["Authorization"] === `Bearer ${SECRET}`);
  check("User-Agent preserved on proxy path",
        typeof r.headers["User-Agent"] === "string" && r.headers["User-Agent"].length > 10);
}

// 2b. URL with existing query string is preserved + url param added.
{
  const PROXY  = "https://welib-proxy.example.workers.dev/?debug=1";
  const SECRET = "x";
  const r = buildProxyFetchTarget(SIGNED, PROXY, SECRET);
  const u = new URL(r.fetchUrl);
  check("existing ?debug=1 preserved", u.searchParams.get("debug") === "1");
  check("?url= still added",            u.searchParams.get("url")   === SIGNED);
}

// 2c. Malformed proxy URL → graceful fallback (no exception thrown).
{
  let threw = false;
  let r;
  try {
    r = buildProxyFetchTarget(SIGNED, "not-a-valid-url", "s");
  } catch (e) {
    threw = true;
  }
  check("malformed proxy URL: did not throw", threw === false);
  check("malformed proxy URL: viaProxy=false", r && r.viaProxy === false);
  check("malformed proxy URL: fetchUrl falls back to signed", r && r.fetchUrl === SIGNED);
}

// ── P3: Worker source has the expected guards. ───────────────────
console.log("\n─── P3: Worker source static checks ───");
const WORKER = readFileSync("cloudflare/welib-proxy/src/worker.js", "utf-8");
check("worker has Authorization check", /authorization/i.test(WORKER));
check("worker rejects when secret unset",
      /WELIB_PROXY_SECRET/.test(WORKER) && /worker_misconfigured|503/.test(WORKER));
check("worker validates host allowlist",
      /welib-public\.org/.test(WORKER) && /isAllowedHost|ALLOWED_HOSTS/.test(WORKER));
check("worker uses Bearer scheme",
      /Bearer\s/.test(WORKER));
check("worker handles missing ?url=", /missing_url_param|missing_url|missing_target/i.test(WORKER));
check("worker streams response (no buffering)",
      /upstream\.body/.test(WORKER));
check("worker exposes /health endpoint",
      /\/health(z)?/.test(WORKER) && /\bok\b/.test(WORKER));
check("worker does not log Authorization or secret",
      !/console\.\w+\([^)]*(authorization|WELIB_PROXY_SECRET|Bearer)/i.test(WORKER),
      "no Authorization/secret in console.* calls");
check("worker only allows GET/HEAD/OPTIONS",
      /method_not_allowed|405/.test(WORKER));

// ── P4: Worker README + wrangler config sanity. ──────────────────
console.log("\n─── P4: Deployment artifacts ───");
const WRANGLER = readFileSync("cloudflare/welib-proxy/wrangler.toml", "utf-8");
check("wrangler.toml: name = welib-proxy", /name\s*=\s*"welib-proxy"/.test(WRANGLER));
check("wrangler.toml: main points at worker.js", /main\s*=\s*"src\/worker\.js"/.test(WRANGLER));
check("wrangler.toml: compatibility_date set", /compatibility_date\s*=/.test(WRANGLER));
check("wrangler.toml: secret NOT inlined",
      !/WELIB_PROXY_SECRET\s*=\s*"/.test(WRANGLER),
      "secret must be set via `wrangler secret put`, never committed");

const README = readFileSync("cloudflare/welib-proxy/README.md", "utf-8");
check("README: documents `wrangler login`",  /wrangler\s+login/.test(README));
check("README: documents `wrangler deploy`", /wrangler\s+deploy/.test(README));
check("README: documents `wrangler secret put WELIB_PROXY_SECRET`",
      /wrangler\s+secret\s+put\s+WELIB_PROXY_SECRET/.test(README));
check("README: shows .env wiring", /WELIB_PROXY_URL/.test(README) && /WELIB_PROXY_SECRET/.test(README));

// ── P5: config.ts trims env vars (no trailing newline leakage). ──
console.log("\n─── P5: config.ts env var hygiene ───");
const CONFIG = readFileSync("server/bot/config.ts", "utf-8");
check("config.ts: WELIB_PROXY_URL is trim()'d",
      /WELIB_PROXY_URL\s*=\s*\(process\.env\.WELIB_PROXY_URL\s*\|\|\s*""\)\.trim\(\)/.test(CONFIG));
check("config.ts: WELIB_PROXY_SECRET is trim()'d",
      /WELIB_PROXY_SECRET\s*=\s*\(process\.env\.WELIB_PROXY_SECRET\s*\|\|\s*""\)\.trim\(\)/.test(CONFIG));
check("config.ts: WELIB_PROXY_ENABLED requires both vars",
      /WELIB_PROXY_ENABLED\s*=\s*WELIB_PROXY_URL\.length\s*>\s*0\s*&&\s*WELIB_PROXY_SECRET\.length\s*>\s*0/.test(CONFIG));

// ── P6: welibResolver.ts wires through buildProxyFetchTarget ─────
console.log("\n─── P6: welibResolver.ts integration ───");
const RESOLVER = readFileSync("server/bot/welibResolver.ts", "utf-8");
check("welibResolver imports proxy config",
      /WELIB_PROXY_URL/.test(RESOLVER) && /WELIB_PROXY_SECRET/.test(RESOLVER));
check("streamSignedUrlToFile uses buildProxyFetchTarget",
      /buildProxyFetchTarget\s*\(/.test(RESOLVER));
check("streamSignedUrlToFile logs viaProxy flag (for debuggability)",
      /viaProxy/.test(RESOLVER));

// ── Summary ──
console.log("\n────────────────────────────────────────────────");
console.log(`Total: pass=${passed}  fail=${failed}`);
if (failed > 0) process.exit(1);
