// Verify the admin-agent module is wired into the bot startup and
// bundled into dist/index.cjs. Pure static checks — no runtime.

import fs   from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.log(`  ✗ ${name}`); }
}

console.log("\n─── A1: server/bot/index.ts wires startAdminAgent ───");
const idxSrc = fs.readFileSync(path.join("server", "bot", "index.ts"), "utf8");
ok("index.ts imports startAdminAgent",       /import.*startAdminAgent.*from.*adminAgent\/index/.test(idxSrc));
ok("index.ts calls startAdminAgent() in startBot",
   /startAdminAgent\(\)/.test(idxSrc));

console.log("\n─── A2: adminAgent module files exist ───");
const files = ["index.ts", "llm.ts", "tools.ts", "prompt.ts", "conversation.ts"];
for (const f of files) {
  const p = path.join("server", "bot", "adminAgent", f);
  ok(`server/bot/adminAgent/${f} exists`, fs.existsSync(p));
}

console.log("\n─── A3: tools.ts registers expected tool names ───");
const toolsSrc = fs.readFileSync(path.join("server", "bot", "adminAgent", "tools.ts"), "utf8");
const expected = [
  // read
  "get_counters", "get_queue_status", "get_dlq_jobs", "get_today_stats",
  "get_weekly_stats", "get_total_stats", "get_funnel_stats", "get_top_books",
  "get_source_health", "get_recent_traces", "get_user", "get_premium_info",
  "get_pdf_validation_stats", "get_blacklist_stats", "get_recent_logs",
  "get_maintenance_status",
  // write
  "set_premium", "grant_premium_30d", "revoke_premium",
  "pause_source", "unpause_source", "clear_dlq", "cancel_user_jobs",
  "clear_cache", "toggle_maintenance", "broadcast",
];
for (const t of expected) {
  ok(`tool "${t}" declared`, new RegExp(`name:\\s*"${t}"`).test(toolsSrc));
}

console.log("\n─── A4: write tools are isWrite=true (gated) ───");
const writeTools = ["set_premium", "grant_premium_30d", "revoke_premium",
  "pause_source", "unpause_source", "clear_dlq", "cancel_user_jobs",
  "clear_cache", "toggle_maintenance", "broadcast"];
for (const t of writeTools) {
  // Find the tool block and check for isWrite: true within ~20 lines.
  const idx = toolsSrc.indexOf(`name:        "${t}"`);
  const ok2 = idx >= 0 && /isWrite:\s*true/.test(toolsSrc.slice(idx, idx + 2000));
  ok(`${t} → isWrite: true`, ok2);
}

console.log("\n─── A5: bundled dist/index.cjs contains admin-agent markers ───");
const distPath = path.join("dist", "index.cjs");
if (!fs.existsSync(distPath)) {
  console.log("  (skipped — dist/index.cjs not built; run `npm run build` first)");
} else {
  const dist = fs.readFileSync(distPath, "utf8");
  ok("bundle contains startAdminAgent",       dist.includes("startAdminAgent"));
  ok("bundle contains ADMIN_BOT_TOKEN env",   dist.includes("ADMIN_BOT_TOKEN"));
  ok("bundle contains TOOL_GET_COUNTERS-like signature", /get_counters/.test(dist));
  ok("bundle contains confirm phrase regex",  /CONFIRM_PHRASES_RE|confirm/i.test(dist));
}

console.log(`\n${pass}/${pass + fail} probes passed`);
if (fail > 0) process.exit(1);
