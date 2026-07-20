#!/bin/bash
# Daily backup: Postgres + Redis AOF snapshot path note
# Install: crontab -e → 0 3 * * * /home/ubuntu/book-bot/scripts/backup_bookbot.sh
set -euo pipefail
ROOT=/home/ubuntu/book-bot
OUT=/home/ubuntu/book-bot-backups
mkdir -p "$OUT"
DAY=$(date -u +%Y%m%d)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# Load POSTGRES_PASSWORD from .env without sourcing whole file
if [[ -f "$ROOT/.env" ]]; then
  export $(grep -E '^POSTGRES_PASSWORD=' "$ROOT/.env" | xargs -0 2>/dev/null || true)
  # safer parse
  POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' "$ROOT/.env" | head -1 | cut -d= -f2-)
  export POSTGRES_PASSWORD
fi

cd "$ROOT"
echo "[$STAMP] starting backup..."
docker compose exec -T db pg_dump -U bookbot -d bookbot --no-owner --format=custom \
  > "$OUT/pg_bookbot_${DAY}.dump" 2>/dev/null || \
docker compose exec -T db pg_dump -U bookbot bookbot \
  > "$OUT/pg_bookbot_${DAY}.sql"

# Redis RDB via BGSAVE + copy
docker compose exec -T redis redis-cli BGSAVE >/dev/null || true
sleep 2
docker compose cp redis:/data/dump.rdb "$OUT/redis_${DAY}.rdb" 2>/dev/null || true

# retention 14 days
find "$OUT" -type f -mtime +14 -delete 2>/dev/null || true
echo "[$STAMP] backup done → $OUT"
ls -lah "$OUT" | tail -10
