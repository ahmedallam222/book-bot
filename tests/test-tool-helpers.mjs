// Unit tests for admin agent toolHelpers + skills + i18n + roles
import { asStr, asNum, asBool, sanitizePattern, deriveRates } from "../server/bot/adminAgent/toolHelpers.ts";
import { inferSkill, toolsForSkill } from "../server/bot/adminAgent/skills.ts";
import { t, isLocale } from "../server/bot/i18n.ts";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${info ? " → " + info : ""}`); }
}

console.log("toolHelpers");
ok("asStr", asStr("x") === "x" && asStr(1) === "");
ok("asNum", asNum("3.5") === 3.5 && asNum("no", 2) === 2);
ok("asBool", asBool("yes") === true && asBool("0") === false);
ok("sanitize ok", sanitizePattern("cache:welib:*") === "cache:welib:*");
try { sanitizePattern("*"); ok("sanitize broad throws", false); }
catch { ok("sanitize broad throws", true); }
const d = deriveRates({ requests: 10, found: 8, downloads: 5, cache_hits: 2, searches: 20 });
ok("derive success 80", d.derived.success_rate_pct === 80);
ok("derive delivery 70", d.derived.delivery_rate_pct === 70);

console.log("skills");
ok("infer diagnostic", inferSkill("ليه البوت بطيء") === "diagnostic");
ok("infer analytics", inferSkill("تقرير إحصاءات الأسبوع") === "analytics");
ok("infer ops", inferSkill("pause source welib") === "ops");
ok("toolsForSkill has core", toolsForSkill("general").has("think"));

console.log("i18n");
ok("isLocale", isLocale("ar") && isLocale("en") && !isLocale("fr"));
ok("t ar maint", t("ar", "maint.title").includes("صيانة"));
ok("t en maint", t("en", "maint.title").toLowerCase().includes("maintenance"));

console.log("roles (static markers)");
import fs from "node:fs";
const rolesSrc = fs.readFileSync("server/bot/adminRoles.ts", "utf8");
ok("adminRoles exports getAdminRole", /export function getAdminRole/.test(rolesSrc));
ok("adminRoles exports canWrite", /export function canWrite/.test(rolesSrc));
ok("adminRoles exports assertCanRunTool", /export function assertCanRunTool/.test(rolesSrc));

console.log(`\nresult pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
process.exit(0);
