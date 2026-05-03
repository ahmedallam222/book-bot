#!/usr/bin/env node
// One-shot migration for the Premium TTL fix.
//
// Before this fix:
//   isPremium() only checked SISMEMBER. When a paid sub's TTL expired,
//   the user stayed in the set forever — pay once, premium for life.
//
// After this fix:
//   isPremium = inSet AND (premium:exp:{uid} OR premium:manual:{uid})
//   Anyone in the set without either key is treated as expired and
//   removed by lazy cleanup on next isPremium() call.
//
// Migration policy chosen by the operator: treat ALL pre-existing
// premium:users members without an exp key as admin grants (premium
// forever) by setting premium:manual:{uid} for them. This preserves
// access for users who were already premium under the old broken code,
// without surprising them by suddenly downgrading.
//
// Usage (run inside the bot container OR with REDIS_URL pointing at prod):
//   docker compose exec -T bot node script/migrate-premium-to-manual.mjs
//   docker compose exec -T bot node script/migrate-premium-to-manual.mjs --dry-run
//
// Idempotent: re-running it does nothing for users who already have
// either an exp or manual key.

import IORedis from "ioredis";

const dryRun = process.argv.includes("--dry-run");
const url    = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const redis = new IORedis(url, { maxRetriesPerRequest: 3 });

const PREMIUM_SET_KEY    = "premium:users";
const PREMIUM_EXP_KEY    = (uid) => `premium:exp:${uid}`;
const PREMIUM_MANUAL_KEY = (uid) => `premium:manual:${uid}`;

async function main() {
  console.log(`[migrate] connecting to ${url}`);
  console.log(`[migrate] dry-run: ${dryRun}`);

  const members = await redis.smembers(PREMIUM_SET_KEY);
  console.log(`[migrate] premium:users size = ${members.length}`);

  let migrated = 0;
  let alreadyPaid = 0;
  let alreadyManual = 0;

  for (const uid of members) {
    const [hasExp, hasManual] = await Promise.all([
      redis.exists(PREMIUM_EXP_KEY(uid)),
      redis.exists(PREMIUM_MANUAL_KEY(uid)),
    ]);

    if (hasExp === 1) {
      alreadyPaid++;
      continue;
    }
    if (hasManual === 1) {
      alreadyManual++;
      continue;
    }

    // Stale entry — the legacy bug case.
    if (dryRun) {
      console.log(`[migrate] DRY would set premium:manual:${uid}`);
    } else {
      // Use SET NX so a concurrent admin/payment write wins.
      await redis.set(PREMIUM_MANUAL_KEY(uid), `migrated@${Date.now()}`, "NX");
      console.log(`[migrate] set premium:manual:${uid}`);
    }
    migrated++;
  }

  console.log("");
  console.log("=== summary ===");
  console.log(`already paid   (premium:exp present):    ${alreadyPaid}`);
  console.log(`already manual (premium:manual present): ${alreadyManual}`);
  console.log(`${dryRun ? "would migrate" : "migrated"} (no key → manual):       ${migrated}`);
  console.log(`total members in set:                    ${members.length}`);

  await redis.quit();
}

main().catch(async (err) => {
  console.error("[migrate] fatal:", err);
  try { await redis.quit(); } catch {}
  process.exit(1);
});
