# Test plan — PR #12 (recover advanced bot version + Firecrawl fix)

## What changed (user-visible)

- Production bot was reset on May 2 03:33 to a different ("kholasa-v28") codebase that lacked `/wishlist`, `/premium`, the random/weekly/wishlist/premium buttons in `/start`, and was sending the wrong Firecrawl request shape (HTTP 400 silent failures).
- This PR restores the user's earlier advanced version (server commit `6d3eb00` + the working-tree changes captured in the May 2 03:33 deploy backup) and fixes the search request to use `(site:domain1 OR site:domain2 OR …)` as a query operator instead of the deprecated `includeDomains` parameter.

## Primary flow under test

A real Arabic book request goes through the deployed worker, hits the live Firecrawl API with the new query shape, returns >0 results, and the bot replies to the admin's Telegram chat.

## Test cases

### T1 — Runtime health (deployed bundle is alive and singleton)
**Steps**
1. SSH to `ubuntu@<production-host>`.
2. `cd /home/ubuntu/book-bot && docker compose ps` and `curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:5000/api/health`.
3. `docker compose exec -T bot ps -ef | grep node`.

**Pass criteria (all must hold)**
- `docker compose ps` shows `bot`, `db`, `redis` all `Up` and **`healthy`**.
- `/api/health` returns **HTTP 200** and JSON body where `ok === true`.
- `ps -ef` shows exactly one `tini` process AND exactly one `node dist/index.cjs` child (PPID = the tini PID). Anything else (two `node dist/index.cjs` lines) is a fail — that would indicate dual polling.

### T2 — Deployed bundle contains the advanced UI
**Steps**
1. `docker compose exec -T bot cat /app/dist/index.cjs > /tmp/index.cjs.deployed` on the server.
2. Grep the bundle for callback keys, command regexes, and the Firecrawl fix shape.

**Pass criteria (all must hold)**
- `grep -c '"rg:any"' /tmp/index.cjs.deployed` ≥ 1 (random-book button)
- `grep -c '"weekly_refresh"' /tmp/index.cjs.deployed` ≥ 1 (weekly button)
- `grep -c '"wishlist_view"' /tmp/index.cjs.deployed` ≥ 1 (wishlist button)
- `grep -c '"premium_buy"' /tmp/index.cjs.deployed` ≥ 1 (premium-upgrade button)
- `grep -c '/wishlist' /tmp/index.cjs.deployed` ≥ 1 (command regex)
- `grep -c '/premium' /tmp/index.cjs.deployed` ≥ 1 (command regex)
- `grep -c '"XTR"' /tmp/index.cjs.deployed` ≥ 1 (Telegram Stars currency)
- `grep -c 'pre_checkout_query' /tmp/index.cjs.deployed` ≥ 1 (Stars purchase flow)
- `grep -oE 'domain: "[a-z0-9.-]+"' /tmp/index.cjs.deployed | sort -u | wc -l` = **13** (sources count, matches the "13 مصدر عربي" the user wants).
- `grep -c 'site:' /tmp/index.cjs.deployed` ≥ 1 — the new query shape **must** be present in the deployed bundle.
- `grep -c 'includeDomains' /tmp/index.cjs.deployed` = **0** — the deprecated parameter must be gone from the bundle.

A broken implementation (e.g. wrong commit deployed, build skipped, or only the engine fix landed without the recovery) would fail at least one of these.

### T3 — Live end-to-end search through the deployed worker
**Steps**
1. From inside the running bot container, run a Node script that:
   - JSON-builds a real `QueueJob` for chatId `5469997406` (admin), `bookName = "حوار مع صديقي الملحد"`, priority `high`, and `RPUSH`es it onto `queue:high` in Redis.
2. Immediately tail `docker compose logs --no-color --since=1m bot` for ~60 seconds.
3. After the job completes, read recent Telegram outbound calls from logs.

**Pass criteria (all must hold)**
- Logs contain a line like `[INFO] [worker] ⏳ Job <id> processing` followed (within ~30s) by `[INFO] [worker] ✅ Job <id> done` for the same id.
- Logs do **NOT** contain `Firecrawl HTTP 4` (no 4xx) or `Firecrawl rate limited`/`Firecrawl quota exceeded`/`Firecrawl auth error` for that window.
- Logs contain at least one `[INFO] [download] ⬇️  Starting` OR `[WARN] [worker] Job <id> failed: …` (the latter is acceptable only if the failure is "no PDF found" — which still proves the search returned results and the verifier rejected them — but `Firecrawl HTTP 200` must have been seen at least once and engine returned >0 results).
- The admin (`5469997406`) actually receives a Telegram message for this job — confirmed by absence of `Bad Request: chat not found` or `403 Forbidden` in the logs and presence of an outbound `sendMessage` for chat `5469997406`.

A broken implementation (engine still using `includeDomains`, or the recovery overwrote the worker, or the bundle didn't get rebuilt) would fail: the worker would log `Firecrawl HTTP 400` and a 0-results path, or the job would never get `processing`/`done` logs.

### T4 — Negative control: old request shape really does fail
**Steps**
1. From inside the bot container, POST directly to `https://api.firecrawl.dev/v1/search` with `{"includeDomains":["foulabook.com"], "query":"كتاب", "limit":3}` using the live `FIRECRAWL_API_KEY` env var.

**Pass criteria**
- Response is **HTTP 400** with body containing `"unrecognized_keys"` and `"includeDomains"`. This is the exact failure mode that was silently breaking production before this PR. If this passed (200), the fix wouldn't have been needed and our claim of root cause would be wrong.

## Out of scope (intentionally not tested here)
- Real `/start` rendering on Telegram (requires a real human user account; we instead grep the bundle).
- Premium purchase end-to-end (would require Telegram Stars).
- `/wishlist add` Redis-backed persistence — handler registration is verified via bundle grep but the Redis flow is not exercised.

These can be added if the user wants, but they don't change the core proof: the recovery + Firecrawl fix are deployed and search works.
