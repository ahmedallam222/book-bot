// Deterministic probes for promoting Cloudflare Workers AI to
// primary LLM provider in the admin agent (server/bot/adminAgent/
// llmProviders.ts).
//
// Background: the admin agent was originally seeded with Cerebras
// gpt-oss-120b → Groq fallback. In prod we hit HTTP 404 on the
// Cerebras model name + HTTP 429 throttle on the Groq free tier
// almost daily, so the agent would fail with "All LLM providers
// failed". Cloudflare Workers AI hosts the same gpt-oss-120b model
// behind an OpenAI-compatible endpoint (with function calling) and
// has a much higher daily quota (10k neurons free + cheap PAYG),
// so we promote it to priority 1 and demote everyone else.
//
// We test:
//  C1 — static markers on the source file (priority order + URL)
//  C2 — index.ts wires the migration on startup
//  C3 — bundled dist/index.cjs ships the new code
//  C4 — runtime check: imported DEFAULT_PROVIDERS sorts Cloudflare
//       first AND the baseUrl interpolates the account id env var.

import fs   from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); }
}

const ROOT     = process.cwd();
const PROV_PATH = path.join(ROOT, "server", "bot", "adminAgent", "llmProviders.ts");
const IDX_PATH  = path.join(ROOT, "server", "bot", "adminAgent", "index.ts");
const provSrc   = fs.readFileSync(PROV_PATH, "utf8");
const idxSrc    = fs.readFileSync(IDX_PATH,  "utf8");

// ─── C1 — static markers on llmProviders.ts ────────────────────────
console.log("C1 — static markers (llmProviders.ts)");
ok("imports CLOUDFLARE_AI_ACCOUNT_ID + TOKEN from config",
   /CLOUDFLARE_AI_ACCOUNT_ID/.test(provSrc) && /CLOUDFLARE_AI_API_TOKEN/.test(provSrc));
ok("exports CLOUDFLARE_PROVIDER_ID constant",
   /export\s+const\s+CLOUDFLARE_PROVIDER_ID\s*=\s*"cloudflare-llama-3.3-70b"/.test(provSrc));
ok("exports ensureCloudflarePrimary function",
   /export\s+async\s+function\s+ensureCloudflarePrimary/.test(provSrc));
ok("DEFAULT_PROVIDERS first entry is cloudflare (buildCloudflareProvider call)",
   /DEFAULT_PROVIDERS:[\s\S]*?=\s*\[\s*[/\s\S]*?buildCloudflareProvider\(1\)/.test(provSrc));
ok("baseUrl uses Cloudflare OpenAI-compat path `/ai/v1`",
   /accounts\/\$\{CLOUDFLARE_AI_ACCOUNT_ID\}\/ai\/v1/.test(provSrc));
ok("model is @cf/meta/llama-3.3-70b-instruct-fp8-fast",
   /"@cf\/meta\/llama-3\.3-70b-instruct-fp8-fast"/.test(provSrc));
ok("legacy model gpt-oss-120b listed for migration",
   /CLOUDFLARE_LEGACY_MODELS[\s\S]*?@cf\/openai\/gpt-oss-120b/.test(provSrc));
ok("legacy id cloudflare-gpt-oss-120b listed for migration",
   /CLOUDFLARE_LEGACY_IDS[\s\S]*?cloudflare-gpt-oss-120b/.test(provSrc));
ok("migration handles model_migrated branch",
   /reason:\s*"model_migrated"/.test(provSrc));
ok("migration handles id_migrated branch",
   /reason:\s*"id_migrated"/.test(provSrc));
ok("cerebras priority bumped to 2",
   /id:\s*"cerebras-gpt-oss-120b"[\s\S]{0,300}?priority:\s*2/.test(provSrc));
ok("groq-gpt-oss priority bumped to 3",
   /id:\s*"groq-gpt-oss-120b"[\s\S]{0,300}?priority:\s*3/.test(provSrc));
ok("groq-llama priority bumped to 4",
   /id:\s*"groq-llama-3.3-70b"[\s\S]{0,300}?priority:\s*4/.test(provSrc));
ok("ensureCloudflarePrimary skips when keys missing",
   /reason:\s*"no_keys"/.test(provSrc));
ok("ensureCloudflarePrimary skips when admin already configured one",
   /reason:\s*"already_set"/.test(provSrc));

// ─── C2 — index.ts wires the migration ─────────────────────────────
console.log("\nC2 — index.ts wires ensureCloudflarePrimary on startup");
ok("index.ts imports ensureCloudflarePrimary",
   /import\s*\{[^}]*ensureCloudflarePrimary[^}]*\}\s*from\s*["']\.\/llmProviders/.test(idxSrc));
ok("index.ts awaits ensureCloudflarePrimary() during startAdminAgent",
   /await\s+ensureCloudflarePrimary\s*\(\s*\)/.test(idxSrc));

// ─── C3 — bundled cjs ships the new code ──────────────────────────
console.log("\nC3 — bundled dist/index.cjs ships the new code");
const distPath = path.join(ROOT, "dist", "index.cjs");
if (!fs.existsSync(distPath)) {
  console.log("  (skipped — dist/index.cjs not built; run `npm run build` first)");
} else {
  const dist = fs.readFileSync(distPath, "utf8");
  ok("bundle includes cloudflare-llama-3.3-70b id",     dist.includes("cloudflare-llama-3.3-70b"));
  ok("bundle includes llama-3.3-70b-instruct-fp8-fast model", dist.includes("@cf/meta/llama-3.3-70b-instruct-fp8-fast"));
  ok("bundle includes ensureCloudflarePrimary symbol",  /ensureCloudflarePrimary/.test(dist));
  ok("bundle keeps Cerebras fallback id",               dist.includes("cerebras-gpt-oss-120b"));
  ok("bundle keeps legacy id for migration",            dist.includes("cloudflare-gpt-oss-120b"));
}

// ─── C4 — runtime check: DEFAULT_PROVIDERS shape ──────────────────
console.log("\nC4 — runtime: DEFAULT_PROVIDERS shape");
// Pre-set env vars so config.ts captures them at import time.
process.env.CLOUDFLARE_AI_ACCOUNT_ID = process.env.CLOUDFLARE_AI_ACCOUNT_ID || "test-account-id";
process.env.CLOUDFLARE_AI_API_TOKEN  = process.env.CLOUDFLARE_AI_API_TOKEN  || "test-token-xxxxxxxxxxxx";

const mod = await import(path.join(ROOT, "server", "bot", "adminAgent", "llmProviders.ts"));
const { DEFAULT_PROVIDERS, CLOUDFLARE_PROVIDER_ID } = mod;

ok("DEFAULT_PROVIDERS is non-empty array",
   Array.isArray(DEFAULT_PROVIDERS) && DEFAULT_PROVIDERS.length >= 4);

const cf = DEFAULT_PROVIDERS.find(p => p.id === CLOUDFLARE_PROVIDER_ID);
ok("Cloudflare entry present", !!cf);
ok("Cloudflare priority === 1", cf?.priority === 1);
ok("Cloudflare enabled === true", cf?.enabled === true);
ok("Cloudflare baseUrl interpolates account id",
   cf?.baseUrl === "https://api.cloudflare.com/client/v4/accounts/test-account-id/ai/v1",
   cf?.baseUrl);
ok("Cloudflare model is @cf/meta/llama-3.3-70b-instruct-fp8-fast",
   cf?.model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast", cf?.model);

const cerebras = DEFAULT_PROVIDERS.find(p => p.id === "cerebras-gpt-oss-120b");
ok("Cerebras present at priority 2", cerebras?.priority === 2);

// Sorted ascending by priority?
const sorted = [...DEFAULT_PROVIDERS].sort((a, b) => a.priority - b.priority);
ok("DEFAULT_PROVIDERS first in priority order is Cloudflare",
   sorted[0]?.id === CLOUDFLARE_PROVIDER_ID);

console.log(`\n${pass}/${pass + fail} probes passed`);
// The runtime import above opens a Redis connection via the module
// dependency chain (logger → ... → redis). Force-exit so the test
// runner doesn't hang on the dangling ioredis reconnect loop. We
// keep the exit synchronous and only after all probes have run so
// failures still propagate.
process.exit(fail > 0 ? 1 : 0);
