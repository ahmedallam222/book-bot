#!/usr/bin/env node
// ══════════════════════════════════════════════
// Bulk-join Arabic book channels using a stored gramjs StringSession.
//
// Usage:
//   TELEGRAM_API_ID=... \
//   TELEGRAM_API_HASH=... \
//   TELEGRAM_USERBOT_SESSION=... \
//   node scripts/tg-channel-join.mjs [path/to/channels.json] [--delay-ms=60000]
//
// Reads tier_1_large_libraries + tier_2_specialized arrays from the
// channels.json file and joins each. Rate-limits to one join per
// JOIN_DELAY_MS (default 60s) to stay well below Telegram's anti-spam
// thresholds.
//
// SAFE TO RERUN: USER_ALREADY_PARTICIPANT errors are treated as a
// no-op, not a failure. Failures (private / deleted / username
// changed) are logged but do not stop the run.
// ══════════════════════════════════════════════

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "node:fs/promises";
import path from "node:path";

const apiId      = Number(process.env.TELEGRAM_API_ID);
const apiHash    = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_USERBOT_SESSION;

if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash || !sessionStr) {
  console.error("Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_USERBOT_SESSION env vars.");
  process.exit(1);
}

// Parse args
const args = process.argv.slice(2);
let channelsPath = "config/telegram-channels.json";
let delayMs = 60_000;
for (const a of args) {
  if (a.startsWith("--delay-ms=")) {
    delayMs = Number(a.split("=")[1]) || delayMs;
  } else if (!a.startsWith("--")) {
    channelsPath = a;
  }
}
const absPath = path.isAbsolute(channelsPath)
  ? channelsPath
  : path.resolve(process.cwd(), channelsPath);

console.log(`Reading channels from: ${absPath}`);
const json = JSON.parse(await fs.readFile(absPath, "utf-8"));

const channels = [
  ...(json.tier_1_large_libraries || []),
  ...(json.tier_2_specialized     || []),
];
console.log(`Loaded ${channels.length} channels to attempt.\n`);

const session = new StringSession(sessionStr);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
await client.connect();

let joined = 0, alreadyIn = 0, failed = 0;
const results = [];

for (let i = 0; i < channels.length; i++) {
  const ch = channels[i];
  const tag = `[${i + 1}/${channels.length}] @${ch.username}`;
  try {
    const resolved = await client.invoke(
      new Api.contacts.ResolveUsername({ username: ch.username }),
    );
    const channel = resolved.chats?.[0];
    if (!channel) {
      console.log(`${tag} SKIP — username did not resolve`);
      failed++;
      results.push({ username: ch.username, status: "not_found" });
      continue;
    }

    try {
      await client.invoke(
        new Api.channels.JoinChannel({
          channel: new Api.InputChannel({
            channelId:  channel.id,
            accessHash: channel.accessHash,
          }),
        }),
      );
      console.log(`${tag} JOINED — ${ch.title}`);
      joined++;
      results.push({
        username:  ch.username,
        title:     ch.title,
        channelId: String(channel.id),
        status:    "joined",
      });
    } catch (e) {
      const msg = String(e?.message || e);
      if (/USER_ALREADY_PARTICIPANT/.test(msg)) {
        console.log(`${tag} OK — already in`);
        alreadyIn++;
        results.push({
          username:  ch.username,
          title:     ch.title,
          channelId: String(channel.id),
          status:    "already_in",
        });
      } else if (/FLOOD_WAIT_(\d+)/.test(msg)) {
        const secs = Number(msg.match(/FLOOD_WAIT_(\d+)/)?.[1] || 60);
        console.warn(`${tag} FLOOD_WAIT ${secs}s — sleeping then continuing`);
        await new Promise((r) => setTimeout(r, (secs + 5) * 1000));
        i--; // retry same channel
        continue;
      } else if (/CHANNELS_TOO_MUCH/.test(msg)) {
        console.error(`${tag} ABORT — account hit the 500-channel cap. Stopping.`);
        failed++;
        break;
      } else {
        console.warn(`${tag} FAIL — ${msg.slice(0, 100)}`);
        failed++;
        results.push({
          username: ch.username,
          status:   "failed",
          error:    msg.slice(0, 100),
        });
      }
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (/FLOOD_WAIT_(\d+)/.test(msg)) {
      const secs = Number(msg.match(/FLOOD_WAIT_(\d+)/)?.[1] || 60);
      console.warn(`${tag} FLOOD_WAIT ${secs}s — sleeping then continuing`);
      await new Promise((r) => setTimeout(r, (secs + 5) * 1000));
      i--; // retry
      continue;
    }
    console.warn(`${tag} resolve-fail — ${msg.slice(0, 100)}`);
    failed++;
    results.push({ username: ch.username, status: "resolve_failed", error: msg.slice(0, 100) });
  }

  // Rate-limit: pause between joins
  if (i < channels.length - 1) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

console.log(
  `\n══════════════════════════════════════════\n` +
  `DONE: ${joined} joined, ${alreadyIn} already-in, ${failed} failed.\n` +
  `══════════════════════════════════════════`,
);

// Write back results summary
const outPath = absPath.replace(/\.json$/, ".joined.json");
await fs.writeFile(outPath, JSON.stringify({
  ts:     new Date().toISOString(),
  joined,
  alreadyIn,
  failed,
  results,
}, null, 2));
console.log(`Wrote results: ${outPath}`);

await client.disconnect();
process.exit(0);
