---
name: testing-book-bot
description: Test the Telegram book-bot production runtime, source quality, and deterministic backend cache/search behavior.
---

# Testing book-bot production runtime

## When to use

Use this skill when testing the Telegram book-bot production deployment for search/result quality, Arabic UX copy, source-health analytics, source auto-disable, deployment health, smart cached-PDF behavior, or admin-toggle/event-driven features such as maintenance-mode announcements.

## Devin Secrets Needed

- `FIRECRAWL_API_KEY` — needed for local/dev Firecrawl-backed searches if running the bot outside production.
- `AWS_UBUNTU_SSH_PRIVATE_KEY` or an equivalent SSH key provisioned at `$HOME/.ssh/devin_aws_ubuntu_key` — needed to access the production Ubuntu server.
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — needed for the gramjs userbot (PR #144). The matching `TELEGRAM_USERBOT_SESSION` lives only in the prod `.env` (regenerate locally if needed; see below).
- For the AI summary engine: `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_MODELS_TOKEN`, `MISTRAL_API_KEY`, `CLOUDFLARE_AI_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN`, `YOU_COM_API_KEY`. All optional except Gemini — the registry degrades gracefully.

Do not print production `.env` values. Production runtime secrets live in `/home/ubuntu/book-bot/.env` on the server.

## Production environment

- AWS server: `ubuntu@<production-host>`, SSH port 22.
- Deployment directory: `/home/ubuntu/book-bot`.
- Runtime: Docker Compose services `bot`, `db`, and `redis`.
- Health/status: `cd /home/ubuntu/book-bot && docker compose ps bot`.
- Logs: `cd /home/ubuntu/book-bot && docker compose logs --tail=120 bot`.
- Dashboard/admin API is served by the running bot server on port 5000. Use `DASHBOARD_SECRET` from inside the bot container for authenticated admin API probes.
- `/home/ubuntu/posts/bot.py` is a separate daily-posting script. Do not modify or delete it during book-bot tests.

## Critical safety rules

Do **not** run `node -e 'require("/app/dist/index.cjs")'` or otherwise import the bundled production entrypoint inside the running bot container. Importing the entrypoint starts a second Telegram polling process and can cause `ETELEGRAM 409 Conflict` errors. Additionally, the bundle only exposes the bot's CLI entry — internal modules (e.g. `searchTelegramChannels`) are **not** re-exported and `require()` will return them as `undefined`.

The bot container does **not** include `curl` — only `wget` (used by the healthcheck) is available inside it. For HTTP probes, either:

- Run `curl` from the host against `http://127.0.0.1:5000` (the bot's port mapping is `5000:5000`), reading `DASHBOARD_SECRET` via `docker compose exec -T bot printenv DASHBOARD_SECRET`, or
- Use the embedded-`node` snippet pattern shown in the health check below.

Instead of importing the bundle, test through the already-running process using:

```bash
cd /home/ubuntu/book-bot
# public health
docker compose exec -T bot node - <<'NODE'
const http = require('http');
http.get('http://127.0.0.1:5000/api/health', (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => { console.log(res.statusCode, body); process.exit(res.statusCode === 200 ? 0 : 1); });
}).on('error', (err) => { console.error(err.message); process.exit(1); });
NODE
```

## Deploy a merged PR to production and verify

Verified pattern when a PR is merged into `main` and the production server needs to be rolled forward.

```bash
ssh -i $HOME/.ssh/devin_aws_ubuntu_key ubuntu@<production-host>
cd /home/ubuntu/book-bot

# 1. Stash untracked .env.backup-* files so they survive a branch switch.
#    The server may have leftover env-rotation artifacts that should not be lost.
git stash push -u -m "pre-deploy-$(date +%s)" -- '.env.backup-*' '.env.bak.*' || true

# 2. Fast-forward to origin/main. The server may sit on an old Devin work
#    branch — confirm there are no unique commits before checkout.
git fetch --quiet origin
git log --oneline HEAD..origin/main      # commits to be deployed
git log --oneline origin/main..HEAD      # MUST be empty before continuing
git checkout main && git pull --ff-only origin main

# 3. Rebuild the image. compose builds bot from . so this regenerates dist.
docker compose build bot

# 4. Recreate the container and wait ~30 s for the healthcheck.
docker compose up -d bot
sleep 30
docker compose ps bot              # expect: Up <time> (healthy)

# 5. Confirm the deploy actually shipped the new code by greping a unique
#    marker introduced by the PR inside the bundled output. Choose a token
#    that did not exist before (a new identifier, comment, or string literal).
docker compose exec -T bot grep -c '<NEW_MARKER>' /app/dist/index.cjs

# 6. Restore the env backup.
git stash pop || true
```

Fail signals: `git pull` reports a non-fast-forward, `docker compose ps` reports `unhealthy`, the marker grep returns `0` (deploy used a stale layer or wrong branch), or the post-deploy logs contain `ETELEGRAM 409 Conflict` (old container did not stop).

## Telegram userbot session management (PR #144)

The `TELEGRAM_USERBOT_SESSION` StringSession powers the Telegram-channels fallback search leg. It is **bound to the IP/machine it was generated on**: connecting from a different host raises `RPCError 401: AUTH_KEY_UNREGISTERED` on the next `users.GetUsers` and the bot's leg returns `[]` (graceful degradation, but no Telegram results).

Rules:
- Generate the StringSession on the **same host that will use it**. For prod, that means running `scripts/tg-userbot-login.mjs` directly on the EC2 instance, not on the Devin VM.
- Do not run the login script (or any gramjs client) from a second machine using the same StringSession — Telegram will terminate the existing session.
- If the user has another active Telegram session for the userbot account (e.g. mobile app), do not touch "Terminate session" under Settings → Devices on Telegram itself — that revokes the bot's session.

### Regenerate the prod StringSession from EC2

When the prod session is invalidated (you'll see `[tg] connect failed` in bot logs with `AUTH_KEY_UNREGISTERED`):

```bash
ssh -i $HOME/.ssh/devin_aws_ubuntu_key ubuntu@<production-host>
cd /home/ubuntu/book-bot

# Host node does not have telegram pkg installed (it lives only inside the
# Docker image). Install it transiently without persisting to package.json.
[ -d node_modules/telegram ] || npm install telegram --no-save

# Run the login script. It prompts for phone, OTP, and 2FA password.
TELEGRAM_API_ID=... TELEGRAM_API_HASH=... node scripts/tg-userbot-login.mjs
# Ask the user for the OTP that arrives in the Telegram service-account chat
# on the userbot account. The OTP is valid for ~2 minutes.
```

Then update `.env` and restart:

```bash
# Replace the existing line (do not append a duplicate).
sed -i 's|^TELEGRAM_USERBOT_SESSION=.*|TELEGRAM_USERBOT_SESSION=<NEW_SESSION>|' .env
docker compose restart bot && sleep 20 && docker compose ps bot
```

Verify the new session works on the next user request by tailing logs for `[tg] userbot connected` and checking Redis counters:

```bash
for k in tel:tg:searched tel:tg:found tel:tg:no_results tel:tg:connect_failed tel:tg:downloaded; do
  v=$(docker compose exec -T redis redis-cli GET $k | tr -d '\r\n')
  echo "$k = ${v:-(nil)}"
done
```

`tel:tg:connect_failed` should stay `nil` after the restart — if it increments, the new session is also revoked.

## Testing internal modules that need the bot's Redis (sidecar-container pattern)

When testing a module that imports `./server/bot/redis.js` (e.g. AI providers, validators, suggestions, transliteration), running `npx tsx _harness.ts` directly on the EC2 host **fails with `ECONNREFUSED 127.0.0.1:6379`**. The bot's docker-compose Redis is on the internal `book-bot_default` network with no port binding to host.

Run the harness as a sidecar container on the same network instead:

```bash
docker run --rm \
  --network book-bot_default \
  -e REDIS_HOST=redis -e REDIS_PORT=6379 \
  -v /home/ubuntu/book-bot:/app \
  -w /app \
  node:22-bookworm \
  bash -lc 'npm install --no-save -D tsx && npx tsx _harness.ts'
```

Key points:
- `--network book-bot_default` puts the harness on the same Docker network as `redis` and `bot`.
- `REDIS_HOST=redis` matches what the bot uses internally; `redis.ts` reads `REDIS_HOST`/`REDIS_PORT` from env.
- Source code is mounted in (the bot image only contains `dist/`, not the TypeScript sources).
- `tsx` is installed transiently so package.json is not modified.

Use this any time you need to import bot-module source code on prod for testing without restarting the bot container.
