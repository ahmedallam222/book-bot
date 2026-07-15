// Candidate diversity + rescue config pins
import {
  RESCUE_MIN_CANDIDATES,
  RESCUE_MAX_FALLBACKS,
  WELIB_SEARCH_ENABLED,
  WELIB_EMPTY_STREAK_OPEN,
  MAX_PDF_SIZE,
} from "../server/bot/config.ts";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + " got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)); }
}

check("RESCUE_MIN_CANDIDATES default >= 3", RESCUE_MIN_CANDIDATES >= 3, true);
check("RESCUE_MAX_FALLBACKS default >= 3", RESCUE_MAX_FALLBACKS >= 3, true);
check("WELIB_SEARCH_ENABLED is boolean-ish true by default", WELIB_SEARCH_ENABLED, true);
check("WELIB_EMPTY_STREAK_OPEN default >= 3", WELIB_EMPTY_STREAK_OPEN >= 3, true);
check("MAX_PDF_SIZE under 50MB", MAX_PDF_SIZE < 50 * 1024 * 1024, true);

// Pure diversify logic mirror (keep in sync with bookRequest.ts)
function diversifyUrlsByDomain(urls) {
  if (urls.length <= 2) return urls;
  const buckets = new Map();
  const order = [];
  for (const u of urls) {
    let host = "";
    try { host = new URL(u.startsWith("tg://") ? "https://t.me.local" : u).hostname.toLowerCase(); }
    catch { host = (u.split("/")[2] || "unknown").toLowerCase(); }
    if (u.includes("t.me/") || u.startsWith("tg://")) host = "t.me";
    if (!buckets.has(host)) { buckets.set(host, []); order.push(host); }
    buckets.get(host).push(u);
  }
  if (buckets.size <= 1) return urls;
  const out = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const h of order) {
      const arr = buckets.get(h);
      if (arr.length > 0) { out.push(arr.shift()); progress = true; }
    }
  }
  return out;
}

const mixed = [
  "https://t.me/a/1",
  "https://t.me/a/2",
  "https://t.me/a/3",
  "https://downloads.hindawi.org/x.pdf",
  "https://foulabook.com/y",
];
const div = diversifyUrlsByDomain(mixed);
check("diversity length preserved", div.length, mixed.length);
check("diversity first not all same host as second if multi", div[0].includes("t.me") && div[1].includes("t.me"), false);
// first three should interleave: t.me, hindawi, foulabook
check("diversity round-robin hosts", [div[0].includes("t.me"), div[1].includes("hindawi"), div[2].includes("foulabook")], [true, true, true]);

console.log(pass + " passed, " + fail + " failed");
if (fail) process.exit(1);