---
name: testing-book-bot
description: Test the Telegram book-bot production runtime, source quality, and deterministic backend cache/search behavior.
---

# Testing book-bot production runtime

## When to use

Use this skill when testing the Telegram book-bot production deployment for search/result quality, Arabic UX copy, source-health analytics, source auto-disable, deployment health, smart cached-PDF behavior, admin-toggle/event-driven features such as maintenance-mode announcements, or admin agent tools (exec_command, generate_report, web_search, scheduled tasks).

## Devin Secrets Needed

- `FIRECRAWL_API_KEY` — needed for local/dev Firecrawl-backed searches if running the bot outside production.
- `AWS_UBUNTU_SSH_PRIVATE_KEY` or an equivalent SSH key provisioned at `$HOME/.ssh/devin_aws_ubuntu_key` — needed to access the production Ubuntu server.
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

Do **not** run `node -e 'require("/app/dist/index.cjs")'` or otherwise import the bundled production entrypoint inside the running bot container. Importing the entrypoint starts a second Telegram polling process and can cause `ETELEGRAM 409 Conflict` errors.

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
git stash push -u -m "pre-deploy-$(date +%s)" -- '.env.backup-*' || true

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
```

Alternative (faster when code is already on server, e.g. after `git merge` on server):

```bash
cd /home/ubuntu/book-bot
npm run build          # produces dist/index.cjs
docker compose restart bot
sleep 3
docker compose logs bot --tail 10   # verify startup
```

After deploy, verify new code is in the bundle:

```bash
# Grep for marker strings from the PR
grep -o 'exec_command\|generate_report\|web_search\|list_schedules' dist/index.cjs | sort | uniq -c
```

## Testing admin agent tools (Phase 4+5)

### Pattern: sidecar Node.js for tool testing

Admin agent tools run inside the bot process. To test their logic without triggering a Telegram conversation, use the sidecar container pattern — run Node.js snippets inside the bot container that replicate the tool's logic against the same Redis:

```bash
ssh -i $HOME/.ssh/devin_aws_ubuntu_key ubuntu@<production-host>
cd /home/ubuntu/book-bot && docker compose exec -T bot node - <<'NODE'
const Redis = require("ioredis");
const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");
// ... your test logic here ...
await redis.quit();
NODE
```

### Testing exec_command whitelist + security

The `exec_command` tool uses prefix-based whitelisting (21 prefixes) and a regex to block dangerous patterns (`;`, `&`, `|`, `` ` ``, `$`, `>>`).

To test:
1. **Whitelisted command**: Run `df -h` via `child_process.exec` — should return filesystem output
2. **Non-whitelisted**: Check that `rm -rf /tmp` does NOT match any prefix → returns `"الأمر مش مسموح"` + `allowed_prefixes` array
3. **Injection attempt**: `df -h; rm -rf /` — passes whitelist but regex catches semicolon → throws `"أحرف غير مسموح بيها"`

Key gotcha: The tool runs inside the Docker container with `cwd: "/home/ubuntu/book-bot"`. Inside the container, paths are relative to `/app`.

### Testing generate_report

Replicate the report tool by reading the same Redis keys:
- Daily stats: `stats:YYYYMMDD` hash
- Queue: `llen queue:high`, `llen queue:normal`, `llen dlq`
- Sources: source health stats from the storage layer

Expected output shape: `{ generated_at, period, today: { requests, found, success_rate, downloads, cache_hits, searches }, queue: { highQueue, normalQueue, dlqSize } }`

### Testing web_search

The tool uses DuckDuckGo Instant Answer API (`https://api.duckduckgo.com/?q=...&format=json`). Test from inside the container to verify outbound HTTPS works:

```bash
docker compose exec -T bot node -e "fetch('https://api.duckduckgo.com/?q=test&format=json').then(r=>r.json()).then(d=>console.log('OK',Object.keys(d).length)).catch(e=>console.log('FAIL',e.message))"
```

Expected result structure: `{ query, results_count, results: [{ title, url, snippet }] }`

### Testing scheduled tasks (CRUD)

Schedules are stored in Redis hash `admin:agent:schedules`. Test the full lifecycle:

1. **Add**: `redis.hset("admin:agent:schedules", id, JSON.stringify(task))` with a read tool (e.g. `get_today_stats`)
2. **List**: `redis.hgetall("admin:agent:schedules")` — verify task appears
3. **Toggle**: Parse, set `enabled: false`, write back
4. **Remove**: `redis.hdel("admin:agent:schedules", id)` — verify returns 1
5. **Verify removal**: `redis.hget` returns null

**Safety gate test**: Attempting to schedule a write tool (e.g. `clear_cache`) should be rejected with `"لا يمكن جدولة write tools"`.

### Schedule runner observability limitation

The schedule runner uses `setInterval(callback, 60_000)` with a silent top-level `catch {}`. This makes it **impossible to observe from outside the process** whether the timer is actually firing.

The runner logic itself (Redis read → findTool → execute → store result) works correctly when executed manually in a sidecar. But verifying the actual background timer requires either:
- Adding `L.info("scheduleRunner", "tick")` logging inside the callback
- Checking `admin:agent:schedule_result:<id>` keys after waiting >60s

If the result key doesn't appear after 90s with a past-due task, the runner may not be executing. This is a known observability gap.

## Testing admin agent sidecar container pattern

For testing tools that interact with Redis (knowledge base, scheduled tasks, etc.), always use the sidecar pattern:

```bash
docker compose exec -T bot node - <<'NODE'
const Redis = require("ioredis");
const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

async function test() {
  // Test knowledge base
  await redis.hset("admin:agent:kb", "test_key", JSON.stringify({ value: "test", updatedAt: Date.now() }));
  const result = await redis.hget("admin:agent:kb", "test_key");
  console.log("KB write/read:", result ? "OK" : "FAIL");
  await redis.hdel("admin:agent:kb", "test_key");

  // Always clean up test data
  await redis.quit();
}
test();
NODE
```

Key Redis keys for admin agent:
- `admin:agent:kb` — knowledge base (hash)
- `admin:agent:schedules` — scheduled tasks (hash)
- `admin:agent:proactive_log` — health check history (list)
- `admin:agent:schedule_result:<id>` — runner execution results (string, 7d TTL)
- `admin:agent:schedule_error:<id>` — runner execution errors (string, 1d TTL)

## Sidecar gotchas

- Counter constants like `EXEC_TIMEOUT_MS`, `EXEC_MAX_OUTPUT`, `MAX_SCHEDULES` are hardcoded in the bundle. In sidecar tests, replicate the same values (15000ms, 3000 chars, 10 max).
- The bot container uses `ioredis` (not `redis`). Import with `require("ioredis")`.
- `redis.incr` is fire-and-forget in some contexts — add a 200ms delay after writes before reading back.
- The bot container does NOT have `curl` — use `wget` or Node.js `http`/`fetch` for HTTP.

## Testing AI summary flow

Six deterministic test cases for the AI summary pipeline:

1. **PDF-tier success path** — Gemini 2.5-flash via v1beta, `thinkingBudget: 0` (required), 3-paragraph Arabic summary
2. **Novel spoiler-protection gate** — Novel titles should include spoiler warning in summary
3. **Cache hit** — Second request for same title should return cached result (check `tel:cache:hit` counter)
4. **Failover** — When Gemini is down, falls back to next provider in chain
5. **Keyboard wiring** — "تحميل" and "ملخص" inline buttons should be present in response
6. **Quota cap** — After daily quota exhausted, returns quota-exceeded message

Gemini gotchas:
- Use `thinkingBudget: 0` for 2.5-flash (otherwise it hangs)
- `1.5-flash` is retired from `v1beta` — use `v1` endpoint for it
- Test accounts may not have Gemini quota — check provider stats first

## Testing maintenance toggle and announcements

Toggle maintenance mode via dashboard API and verify the announcement side-effect:

```bash
# Read the dashboard secret
TOKEN=$(docker compose exec -T bot printenv DASHBOARD_SECRET)

# Enable maintenance
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":true}'

# Disable maintenance (triggers announcement)
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":false}'
```

Expected log sequence (within a few seconds):

```
[admin] 🔧maintenance OFF {"who":"dashboard"}
[maintenanceAnnounce] Announcing maintenance end {"targets":N,"known":K,"env":E}
[maintenanceAnnounce] Done {"sent":N,"failed":0,"removed":0,"total":N}
```

### Pattern: simulate "known group" without involving the user

The groupTracker (`bot:known_groups` Redis SET) is normally populated when a user posts in a group. To test the announcement path immediately, inject the admin's own bot DM chatId so the test message lands in the tester's own Telegram conversation with the bot:

```bash
ADMIN_DM_CHAT_ID='<positive-numeric-id>'   # e.g. the admin who runs /start
sudo docker compose exec -T redis redis-cli SADD bot:known_groups "$ADMIN_DM_CHAT_ID"
sudo docker compose exec -T redis redis-cli HSET bot:known_groups:meta "$ADMIN_DM_CHAT_ID" \
  '{"title":"Admin DM (synthetic test target)","lastSeen":0}'
```

Then run the toggle pattern above. The bot will deliver the announcement to that DM — verifiable with a single screenshot.

Alternatively, use `MAINTENANCE_ANNOUNCE_CHAT_IDS=<csv>` in the prod `.env` to pin permanent broadcast targets without touching Redis.

### Pattern: testing the 60-second NX lock for idempotence

The routes.ts handler only emits the event on a real ON→OFF transition (it reads `wasActive` before the toggle). To force a *second* `announceMaintenanceEnd` call within the lock window, manually flip the flag back to ON via Redis between PUT calls:

```bash
# After the first OFF (which has already fired the announcement), the lock
# `maintenance:announce:lock` is set with TTL up to 60s.
sudo docker compose exec -T redis redis-cli TTL maintenance:announce:lock
sudo docker compose exec -T redis redis-cli SET flag:maintenance 1   # bypass routes.ts guard
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":false}'
```

Expected log line: `[maintenanceAnnounce] Skipping — another announcement in flight`. The lock value should be **unchanged** — proving `SET ... NX` refused to overwrite.

Clean up after testing:

```bash
sudo docker compose exec -T redis redis-cli DEL bot:known_groups bot:known_groups:meta maintenance:announce:lock flag:maintenance
```

### Critical gotcha: `docker compose restart` does NOT reload `.env`

If you add or change an env var in `/home/ubuntu/book-bot/.env`, a plain `docker compose restart bot` will **not** pick it up — the variable will appear empty inside the container. To reload env vars you must recreate the container:

```bash
cd /home/ubuntu/book-bot
sudo docker compose up -d bot
sleep 8
sudo docker compose exec -T bot printenv MY_NEW_ENV_VAR   # verify it loaded
```

## Reporting limitations

If no logged-in Telegram Web/test-chat session is available, explicitly mark literal chat UI testing as untested. Ask Ahmed to send messages while logs are monitored, or provide a test Telegram session, if full chat UI proof is required. For event-driven side-effect features (announcements, alerts), a single visual confirmation from the user is usually enough — the dashboard-PUT pattern above proves the dispatch logic without involving Telegram.

For the schedule runner, mark background execution testing as inconclusive if the `setInterval` callback cannot be observed. The runner logic can be verified via manual simulation in a sidecar container.
