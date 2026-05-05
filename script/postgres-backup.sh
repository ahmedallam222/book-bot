#!/usr/bin/env bash
# ══════════════════════════════════════════════
# Postgres backup script — كان مفقود (مفيش backup قبل الـ audit)
# ══════════════════════════════════════════════
#
# Usage:
#   sudo ./script/postgres-backup.sh
#
# Cron (يومي 4 صباحاً UTC):
#   sudo crontab -e
#   0 4 * * * /home/ubuntu/book-bot/script/postgres-backup.sh >> /var/log/bookbot-backup.log 2>&1
#
# الأرشيف يُحفظ في /var/backups/bookbot/ ويتم تنظيف أي ملف أقدم من 14 يوماً تلقائياً.
# هذا backup محلي على الـ EBS — لو الـ instance ضاع، الـ backup ضاع معاه.
# للـ disaster recovery الحقيقي، اضِف خطوة aws s3 cp لـ S3 bucket في region ثاني.

set -euo pipefail

BACKUP_DIR="/var/backups/bookbot"
RETENTION_DAYS=14
TS=$(date -u +"%Y%m%d-%H%M%S")
DATE_DAY=$(date -u +"%F")
OUT="${BACKUP_DIR}/bookbot-${DATE_DAY}.sql.gz"
CONTAINER="book-bot-db-1"

mkdir -p "$BACKUP_DIR"

# تحقق من الـ container شغّال
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "[$(date -u)] FATAL: container $CONTAINER not running — backup skipped" >&2
  exit 1
fi

echo "[$(date -u)] Starting backup → $OUT"

# pg_dump بـ ضغط gzip — DB صغير (~63MB raw) ينضغط لـ ~5MB
docker exec -t "$CONTAINER" pg_dump -U bookbot -d bookbot --no-owner --no-acl \
  | gzip -9 > "${OUT}.tmp"

# atomic rename (لو الـ dump فشل في النص، الـ .tmp ما يحلش محل الملف القديم)
mv "${OUT}.tmp" "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
echo "[$(date -u)] Backup OK: $OUT ($SIZE)"

# نظّف القديم
DELETED=$(find "$BACKUP_DIR" -name "bookbot-*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "[$(date -u)] Pruned $DELETED backup(s) older than ${RETENTION_DAYS} days"
fi

echo "[$(date -u)] Done. Total backups: $(ls -1 "$BACKUP_DIR"/bookbot-*.sql.gz 2>/dev/null | wc -l)"
