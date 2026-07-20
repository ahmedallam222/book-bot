#!/usr/bin/env node
// Smoke checks after deploy — no Telegram network required for core checks.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${info ? " → " + info : ""}`); }
}

console.log("═══ smoke_rafiq ═══");

// Files present
const must = [
  "server/bot/adminAgent/tools.ts",
  "server/bot/adminAgent/toolHelpers.ts",
  "server/bot/adminAgent/toolTypes.ts",
  "server/bot/adminAgent/skills.ts",
  "server/bot/adminAgent/agentV4Tools.ts",
  "server/bot/observability.ts",
  "server/bot/i18n.ts",
  "server/bot/adminRoles.ts",
  "server/bot/continueReading.ts",
];
for (const f of must) ok(`exists ${f}`, existsSync(join(ROOT, f)));

// Health endpoint if server up
const port = process.env.PORT || "5000";
try {
  const r = spawnSync("curl", ["-sf", `http://127.0.0.1:${port}/api/health`], { encoding: "utf8" });
  ok("GET /api/health", r.status === 0 && /"ok"\s*:\s*true/.test(r.stdout || ""), r.stdout?.slice(0, 80));
} catch (e) {
  ok("GET /api/health", false, String(e));
}

// Typecheck-sensitive markers
const tools = readFileSync(join(ROOT, "server/bot/adminAgent/tools.ts"), "utf8");
ok("tools imports toolHelpers", /toolHelpers/.test(tools));
ok("tools has V4", /V4_TOOLS|getSubAgentTool/.test(tools));

const idx = readFileSync(join(ROOT, "server/bot/adminAgent/index.ts"), "utf8");
ok("agent has skill routing", /inferSkill/.test(idx));
ok("agent has confirm continue or skill", /inferSkill|أُكمل التحليل|handleMessage/.test(idx));

// Unit subset
const unit = spawnSync("npx", ["tsx", "tests/test-tool-helpers.mjs"], {
  cwd: ROOT, encoding: "utf8", shell: false,
});
ok("unit test-tool-helpers", unit.status === 0, unit.stderr?.slice(0, 200));

console.log(`\nsmoke pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
