# syntax=docker/dockerfile:1.6
# ══════════════════════════════════════════════════════════════
# خلاصة الكتب — Multi-stage Dockerfile
# ══════════════════════════════════════════════════════════════

# ── Stage 1: install all deps + build ─────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY script ./script
COPY client ./client

RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Chromium + خطوط عربية لازمين لـ noor-book Playwright resolver:
#   - chromium / chromium-swiftshader: المتصفح + GPU stub (للـ headless)
#   - فونتات: Noto Naskh Arabic + DejaVu + freefont = ضمان عرض النصوص
#     العربية في الـ JS challenge وفي صفحة الكتاب
#   - nss + freetype + harfbuzz + ca-certificates: dependencies لازمة
#     لـ chromium في Alpine
RUN apk add --no-cache \
      tini procps wget \
      chromium chromium-swiftshader \
      nss freetype harfbuzz ca-certificates \
      font-noto font-noto-arabic ttf-freefont \
      font-noto-cjk dbus

# نخلي playwright-core يعرف يستخدم chromium المثبت بدل ما ينزل واحد جديد
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/dev/null
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist   ./dist
COPY --from=builder /app/shared ./shared
# script/ holds one-shot ops scripts (e.g. migrate-premium-to-manual.mjs).
# They are not loaded at startup, but operators run them ad-hoc with
# `docker compose exec -T bot node script/<file>.mjs`.
COPY --from=builder /app/script ./script

RUN mkdir -p /app/temp && chown -R node:node /app

USER node

EXPOSE 5000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.cjs"]
