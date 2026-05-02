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

RUN apk add --no-cache tini procps wget

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/shared ./shared

RUN mkdir -p /app/temp && chown -R node:node /app

USER node

EXPOSE 5000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.cjs"]
