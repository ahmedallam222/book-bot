#!/bin/bash
# ══════════════════════════════════════════
# خلاصة الكتب v30 — Deploy Script
# يُشغَّل على السيرفر: bash deploy.sh
# ══════════════════════════════════════════

set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✅]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠️]${NC} $1"; }

cd ~/book-bot

log "Pulling latest changes..."
git pull origin main

log "Rebuilding Docker containers..."
sudo docker-compose down
sudo docker-compose up -d --build

log "Waiting for services to start..."
sleep 5

log "Checking status..."
sudo docker-compose ps

log "Showing last 20 log lines..."
sudo docker logs $(sudo docker ps --format "{{.Names}}" | grep bot | head -1) --tail 20 2>&1

log "Deploy complete! ✅"
echo ""
echo "  📊 Dashboard: http://<production-host>:5000/dashboard"
echo "  📋 Logs: sudo docker logs book-bot-bot-1 -f"
echo ""
