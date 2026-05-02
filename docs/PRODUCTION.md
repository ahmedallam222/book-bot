# Production notes

- Bot deployment path: `/home/ubuntu/book-bot`.
- Runtime: Docker Compose project `book-bot` (`bot`, `db`, `redis`).
- Active env file: `/home/ubuntu/book-bot/.env` and must never be committed or printed.
- External daily posting app: `/home/ubuntu/posts`.
  - This is a separate Python project for the daily 9 AM post.
  - Do not delete, move, reset, or include it in bot deployments.
- Safe bot deploy command after code changes:

```bash
cd /home/ubuntu/book-bot
docker compose up -d --build --force-recreate bot
docker compose ps bot
docker compose logs --tail=120 bot
```

Current server sizing is acceptable for normal traffic: the bot/db/redis containers use low memory, swap usage is small, and disk has healthy free space. Revisit RAM only if queue latency grows, swap usage stays high, or Docker builds repeatedly fail from memory pressure.
