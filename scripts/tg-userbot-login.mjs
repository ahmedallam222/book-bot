#!/usr/bin/env node
// ══════════════════════════════════════════════
// One-shot StringSession generator for the gramjs userbot.
//
// Usage:
//   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node scripts/tg-userbot-login.mjs
//
// The script will prompt for:
//   1. Phone number (international format, e.g. +201xxxxxxxxx)
//   2. The verification code Telegram sends to that account
//   3. Cloud password (only if the account has 2FA enabled)
//
// It then prints the StringSession to stdout. Add it to your env as
// TELEGRAM_USERBOT_SESSION — the bot loads it at startup so we never
// have to re-authenticate (until the account session is revoked).
//
// SECURITY: the StringSession grants full read/send access to the
// account. Store it as a secret, never commit it to git, and rotate
// it if you suspect a leak.
// ══════════════════════════════════════════════

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const apiId   = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
  console.error("Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in env.");
  console.error("Get them from https://my.telegram.org/apps and re-run:");
  console.error("  TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node scripts/tg-userbot-login.mjs");
  process.exit(1);
}

const rl = readline.createInterface({ input, output });

const session = new StringSession(""); // empty → fresh login
const client  = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

try {
  await client.start({
    phoneNumber:     async () => (await rl.question("Phone (e.g. +201xxxxxxxxx): ")).trim(),
    phoneCode:       async () => (await rl.question("Code from Telegram:        ")).trim(),
    password:        async () => (await rl.question("2FA password (or blank):   ")).trim(),
    onError:         (err) => console.error("[login error]", err?.message || err),
  });

  const me = await client.getMe();
  console.error("");
  console.error(`✓ Logged in as: ${me.firstName ?? ""} ${me.lastName ?? ""} (id=${me.id})`);
  console.error(`  username: ${me.username ? "@" + me.username : "(none)"}`);
  console.error("");
  console.error("StringSession — store this as TELEGRAM_USERBOT_SESSION:");
  console.error("════════════════════════════════════════════════════════════");
  console.log(client.session.save());
  console.error("════════════════════════════════════════════════════════════");
} finally {
  rl.close();
  await client.disconnect();
  process.exit(0);
}
