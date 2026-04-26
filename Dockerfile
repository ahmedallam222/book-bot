# syntax=docker/dockerfile:1.6
# ══════════════════════════════════════════════════════════════
# خلاصة الكتب — Multi-stage Dockerfile
# ══════════════════════════════════════════════════════════════

# ── Stage 1: install all deps + build ─────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# نسخ ملفات الـ manifests فقط أولاً للاستفادة من Docker cache
COPY package.json package-lock.json* ./

# تثبيت كل deps (بما فيها dev) — نحتاج tsx + esbuild للبناء
RUN npm ci --no-audit --no-fund

# نسخ بقية الكود
COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY script ./script
COPY client ./client

# بناء الـ backend bundle → dist/index.cjs
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────
FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# tini للـ signal handling السليم (graceful shutdown)
RUN apk add --no-cache tini

# نسخ الـ manifests وتثبيت production deps فقط
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# نسخ الـ build output
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/shared ./shared

# مجلد الملفات المؤقتة
RUN mkdir -p /app/temp && chown -R node:node /app

USER node

EXPOSE 5000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.cjs"]
