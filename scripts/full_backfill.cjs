const { Pool } = require('pg');
const Redis = require('ioredis');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

(async () => {
  console.log('=== Full backfill: PostgreSQL → Redis ===');

  const pipe = redis.pipeline();

  // 1) Sources from cached_books.source_url
  const srcs = await pool.query(`
    SELECT
      REGEXP_REPLACE(REGEXP_REPLACE(source_url, '^https?://([^/]+).*$', '\\1'), '^www\\.', '') AS domain,
      COUNT(*) AS books,
      COALESCE(SUM(times_served), 0) AS served
    FROM cached_books
    WHERE source_url IS NOT NULL AND source_url != ''
    GROUP BY domain
    ORDER BY books DESC
  `);
  console.log('Sources:', srcs.rows.length);
  for (const r of srcs.rows) {
    pipe.hset(`stats:source:${r.domain}`, 'ok', String(parseInt(r.books) + parseInt(r.served)));
    pipe.hset(`stats:source:${r.domain}`, 'fail', '0');
  }

  // 2) Active users today (distinct telegram_user_id from search_logs for today)
  const today = new Date().toISOString().slice(0,10);
  const auTo = await pool.query(`
    SELECT COUNT(DISTINCT telegram_user_id) AS active
    FROM search_logs
    WHERE TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $1
  `, [today]);
  const cacheHitsTotal = await pool.query('SELECT COALESCE(SUM(times_served),0) AS hits FROM cached_books');
  const todaySearches = await pool.query(`
    SELECT COUNT(*) AS s,
           COUNT(*) FILTER (WHERE book_found=true) AS f,
           COUNT(*) FILTER (WHERE pdf_sent=true) AS d
    FROM search_logs
    WHERE TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $1
  `, [today]);
  const ts = todaySearches.rows[0];
  const todayKey = `stats:daily:${today}`;
  pipe.hset(todayKey, 'searches', ts.s);
  pipe.hset(todayKey, 'requests', ts.s);
  pipe.hset(todayKey, 'found', ts.f);
  pipe.hset(todayKey, 'success', ts.f);
  pipe.hset(todayKey, 'downloads', ts.d);
  pipe.hset(todayKey, 'activeUsers', auTo.rows[0].active);
  pipe.hset(todayKey, 'users', auTo.rows[0].active);
  // 3) Distinct active users overall
  const distinctU = await pool.query('SELECT COUNT(DISTINCT telegram_user_id) AS u FROM search_logs');
  pipe.hset('stats:total', 'distinctSearchers', distinctU.rows[0].u);
  pipe.hset('stats:total', 'cacheHitsTotal', cacheHitsTotal.rows[0].hits);

  // 4) Per-day with derived 'success' and 'cacheHits' fields
  const allDays = await pool.query(`
    SELECT
      TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      COUNT(*) AS searches,
      COUNT(*) FILTER (WHERE book_found=true) AS success,
      COUNT(*) FILTER (WHERE pdf_sent=true) AS downloads,
      COUNT(DISTINCT telegram_user_id) AS active
    FROM search_logs
    GROUP BY day
  `);
  for (const r of allDays.rows) {
    const key = `stats:daily:${r.day}`;
    pipe.hset(key, 'searches', r.searches);
    pipe.hset(key, 'requests', r.searches);
    pipe.hset(key, 'found', r.success);
    pipe.hset(key, 'success', r.success);
    pipe.hset(key, 'downloads', r.downloads);
    pipe.hset(key, 'activeUsers', r.active);
    pipe.hset(key, 'users', r.active);
  }

  await pipe.exec();
  console.log('=== Done ===');
  await redis.quit();
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
