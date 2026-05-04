#!/bin/bash
# ══════════════════════════════════════════
# خلاصة الكتب — Deploy Script
# يُشغَّل على السيرفر: bash deploy.sh
# ══════════════════════════════════════════
#
# ملاحظات:
#   - يستخدم docker compose v2 (subcommand) — متطابق مع docs/RUNBOOK.md
#     و .agents/skills/testing-book-bot/SKILL.md.
#   - لا sudo افتراضياً: على السيرفر، الـ user ubuntu في docker group.
#     لو احتجت sudo اضبط: SUDO=sudo bash deploy.sh

set -euo pipefail
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✅]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠️]${NC} $1"; }
err()  { echo -e "${RED}[❌]${NC} $1" >&2; }

SUDO="${SUDO:-}"
DC=("$SUDO" docker compose)
# إذا كان SUDO فاضي، شيل العنصر الأول من الـ array لتجنب command-not-found
if [ -z "$SUDO" ]; then DC=(docker compose); fi

cd ~/book-bot

log "Pulling latest changes..."
git pull --ff-only origin main

log "Rebuilding bot service (db/redis تبقى شغالة)..."
"${DC[@]}" up -d --build --force-recreate bot

log "Waiting for healthcheck..."
sleep 30

log "Checking status..."
"${DC[@]}" ps

log "Showing last 20 log lines..."
"${DC[@]}" logs --tail=20 bot 2>&1 || true

log "Deploy complete!"
echo ""
echo "  📊 Dashboard: http://54.196.55.152:5000/dashboard"
echo "  📋 Logs:      ${DC[*]} logs -f bot"
echo ""
