# Server sync plan

Goal: make `/home/ubuntu/book-bot` reproducible from GitHub without touching the separate daily-posting Python app.

## Preserve before any sync

- `/home/ubuntu/book-bot/.env` — production secrets, never commit or print.
- `/home/ubuntu/posts` — separate Python app for the daily 9 AM post. Do not delete, move, reset, or include in bot deployments.
- Docker volumes: `book-bot_pgdata`, `book-bot_redis_data`, `book-bot_bot_temp`.

## Current risk

The production checkout is `main...origin/main [ahead 109, behind 4]` with local modified/untracked files. Avoid `git reset --hard`, `git clean`, or direct branch replacement until server-only changes are reviewed and either merged or explicitly archived.

## Safe sync approach

1. Create a server backup branch/tag from the current production commit.
2. Export a patch of tracked local changes and a manifest of untracked files.
3. Copy `.env` outside the repo backup location with restrictive permissions.
4. Review server-only changes and port only required production fixes into GitHub PRs.
5. After GitHub contains the wanted bot code, deploy by pulling a clean release branch into `/home/ubuntu/book-bot`.
6. Recreate only the `bot` service with Docker Compose and verify health/logs.

## Never touch

- `/home/ubuntu/posts/**`
- production `.env` contents
- database/redis Docker volumes
