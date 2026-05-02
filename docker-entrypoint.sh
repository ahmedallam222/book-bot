#!/bin/sh
set -e

echo "⏳ Waiting for DB..."
until pg_isready -h "${PGHOST:-db}" -U "${PGUSER:-bookbot}" 2>/dev/null; do
  sleep 1
done
echo "✅ DB ready"

echo "⏳ Pushing DB schema..."
npm run db:push || echo "⚠️ db:push failed — continuing"

echo "🚀 Starting bot..."
exec "$@"
