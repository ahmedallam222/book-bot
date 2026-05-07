<div align="center">

# 📚 Kholasa Books Bot — خلاصة الكتب

### Arabic-first Telegram bot that searches **14 Arabic libraries** in parallel, AI-validates the PDF, and delivers the file inside Telegram in under 10 seconds.

#### بوت تيليغرام عربي يبحث في **١٤ مكتبة عربية** بالتوازي، يتحقق من الـ PDF بنظام ذكي متعدد المراحل، ويرسل الكتاب مباشرة داخل تيليغرام في أقل من ١٠ ثوانٍ.

<br/>

[![CI](https://github.com/ahmedallam222/book-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmedallam222/book-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docker.com)

![Lines of Code](https://img.shields.io/badge/Lines_of_Code-18k+-blueviolet?style=flat-square)
![TS Modules](https://img.shields.io/badge/TS_Modules-68-blue?style=flat-square)
![Sources](https://img.shields.io/badge/Arabic_Sources-14-orange?style=flat-square)
![AI Providers](https://img.shields.io/badge/AI_Providers-10-purple?style=flat-square)
![Tests](https://img.shields.io/badge/Smoke_Tests-13-success?style=flat-square)

<br/>

> 🚀 **Try it live:** [@kholasaelktob_Bot](https://t.me/kholasaelktob_Bot) — type a book name in Arabic and watch it arrive as a PDF.

[Quickstart](#-quickstart) · [Features](#-features) · [Engagement](#-engagement-system) · [Architecture](#%EF%B8%8F-architecture) · [Sources](#-sources-covered) · [AI Stack](#-ai-provider-failover) · [Contributing](CONTRIBUTING.md)

</div>

---

## 📖 Table of Contents

- [Why?](#-why)
- [Features](#-features)
- [Engagement system](#-engagement-system)
- [Live demo](#-live-demo--how-to-use)
- [Architecture](#%EF%B8%8F-architecture)
- [Tech stack](#-tech-stack)
- [Sources covered](#-sources-covered)
- [AI provider failover](#-ai-provider-failover)
- [Quickstart](#-quickstart)
- [Environment variables](#%EF%B8%8F-environment-variables)
- [Bot commands](#-bot-commands)
- [Premium tier](#-premium-tier)
- [Admin dashboard](#-admin-dashboard)
- [REST API](#-rest-api)
- [Security](#-security)
- [Project structure](#-project-structure)
- [Deployment](#%EF%B8%8F-deployment)
- [Monitoring & telemetry](#-monitoring--telemetry)
- [Backups & disaster recovery](#-backups--disaster-recovery)
- [Testing](#-testing)
- [Performance & cost engineering](#-performance--cost-engineering)
- [Contributing](#-contributing)
- [Roadmap](#%EF%B8%8F-roadmap)
- [FAQ](#-faq)
- [Acknowledgments](#-acknowledgments)
- [License](#-license)

---

## 🔭 Why?

Searching for an Arabic book PDF online usually takes 5–15 minutes — broken links, paywalled mirrors, fake "download" buttons, files that turn out to be table-of-contents PDFs, and AI-generated junk. **Kholasa Books does that work for you in under 10 seconds on average:**

```
"الأمير الصغير"  →  Kholasa  →  📄 Real PDF inside Telegram
```

What makes it different from a generic Google search bot:

- 🛡️ **Quality-gated** — every PDF passes through a multi-stage validator (HTTP probe → magic bytes → text density → page count → AI judge). Junk is rejected before it reaches you.
- 💸 **Cost-aware AI** — a filename trust score + per-source allowlist eliminates ~70% of AI calls. The bot stays cheap to run even at scale.
- 📊 **Source-health-aware** — each of the 14 libraries has its own success/failure stats and gets auto-disabled when it goes bad. No single broken source kills the bot.
- ⚙️ **Resilient** — 3 workers pulling from a Redis queue, DLQ for failures, graceful shutdown, full job recovery on restart.
- 🇸🇦 **Arabic-first** — handles dialects (خليجي, مصري, شامي), strips filler verbs (`لخصلي`, `تحميل`, `ابغى`), normalizes diacritics + hamza variants + ى/ي + ة/ه, preserves quoted titles intact.
- 🔥 **Built for retention** — streak system, 10-tier badges, tiered referral rewards, leaderboards. Users come back daily.

---

## ✨ Features

### For users

| Domain | Details |
|---|---|
| 🔍 **Smart search** | 14 Arabic libraries searched in parallel via [Firecrawl](https://firecrawl.dev), with fuzzy fallback for typos. Understands dialect triggers and intent words. |
| 📄 **Real PDFs only** | Multi-stage validator: HTTP check → `%PDF` magic bytes → text density → page count → Mistral AI judge. Junk and viewer-only links never reach the user. |
| 📘 **AI book summaries** | Per-book structured summary (overview, key ideas, chapters, takeaways) with 10-provider AI failover. Cached per-book, daily quotas. |
| 🎲 **Discovery** | `/random` across 15 genres, weekly curated picks, real-time **leaderboards** (all-time + ISO-week bucketed), `/history` last 7 books. |
| 🔥 **Engagement** | Daily reading streak (Cairo-TZ atomic), 10 unlockable badges, friend referrals with tiered Premium rewards (3→7d, 5→14d, 10→30d, 20→60d, 50→90d). |
| 👤 **Personal profile** | `/profile` shows your stats: total downloads, current streak, max streak, badges earned, Premium status, referrals tier. |
| 🔖 **Personal organisation** | Wishlist (`/wishlist`), last-book one-tap reload (`/last`), queue inspection (`/queue`), cancel pending (`/cancel`). |
| 💳 **Telegram-native payments** | Premium via Telegram Stars — no card data, no third-party gateway. Renewals **extend** TTL rather than replace it. Idempotent against payment redelivery. |
| 🛡️ **Defensive UX** | Clear error messages, "report broken file" button, rate-limit warnings, paid-book detection with explanation, complaint-aware leaderboard. |

### For operators

| Domain | Details |
|---|---|
| 📊 **Live dashboard** | Daily/weekly funnel, top books, per-source health, queue/DLQ stats, telemetry traces per request. |
| 👥 **User management** | Ban/unban, manual premium grants with custom durations, per-user daily-limit overrides, free-text notes. |
| 🔌 **Source toggles** | Enable/disable any of the 14 libraries from the dashboard. Auto-disable kicks in for failing or AI-rejected sources (3-tier policy). |
| 🚫 **Hard-blocked domains** | Mark a domain as never-fetch (zero scraping attempts), separate from priority demotion. |
| 📢 **Targeted broadcasts** | Send Markdown messages to all users, premium-only, or active-7-day cohort. Rate-limited at 30 msg/sec to respect Telegram limits. |
| 🔧 **Maintenance mode** | One-click maintenance toggle. Auto-announces service-back to known groups when cleared. |
| 🚨 **Auto-alerts** | Admin gets a Telegram DM when DLQ spikes, success rate drops, Firecrawl quota is near, or rate-limited. |
| 📈 **Daily digest** | Auto-generated 24h report (active users, success rate, top books, per-source numbers) sent to admins each morning. |

---

## 🔥 Engagement system

Built in to keep users coming back daily. Three independent loops, all powered by Redis with atomic operations.

### 🔥 Reading streaks (Duolingo-style)

```
Day 1  →  🔥 streak 1
Day 2  →  🔥 streak 2 · أعلى: 2
Day 3  →  🔥🔥 *ثلاثة أيام متتالية!* — milestone notification
Day 7  →  🔥🔥 *أسبوع كامل!* — milestone
Day 14 →  🔥🔥🔥 *أسبوعين!*
Day 30 →  🌟 *شهر كامل!*
Day 60 →  🌟🌟 *شهرين متتاليين!*
Day 100 →  💎 *مائة يوم!*
```

- **Atomic Lua script** — concurrent downloads can't double-count or corrupt the streak.
- **Cairo-timezone day boundaries** — no off-by-one bugs from UTC midnight.
- **Broken-streak rescue message** — "💔 خسرت سلسلة X يوم" appears when a 3+ day streak resets.
- **Idempotent** — multiple downloads on the same day don't bump the counter.

### 🏅 10 unlockable badges

| Category | Badge | Trigger |
|---|---|---|
| Downloads | 📚 قارئ مبتدئ | 5 books |
| Downloads | 📖 قارئ منتظم | 20 books |
| Downloads | 🏆 قارئ شغوف | 50 books |
| Downloads | 🎓 موسوعة | 100 books |
| Downloads | 💎 مكتبة كاملة | 250 books |
| Streak | 🔥 أسبوع متواصل | 7-day streak |
| Streak | 🔥🔥 شهر متواصل | 30-day streak |
| Streak | 💎 ثبات نادر | 100-day streak |
| Summary | 📘 ملخّصاتي | 10 AI summaries |
| Social | 👥 سفير | 3 referrals |

Awarded with `SADD` (atomic, idempotent) and immediately announced in a separate Telegram message.

### 🎁 Tiered referral rewards

```
?start=ref_<userId>  →  invitee gets +3 days Premium on first download (welcome gift)
                    →  referrer counter increments
```

| Referrals | Referrer reward |
|---|---|
| 3 | +7 days Premium |
| 5 | +14 days |
| 10 | +30 days |
| 20 | +60 days |
| 50 | +90 days |
| Every +25 after 50 | +90 days |

**All rewards extend an existing Premium TTL via `SETEX` — no permanent grants are possible.** Referrals are activated only on the invitee's first successful download (not on `/start`), so bot-clicks don't count.

### 📊 Leaderboards

- **🏆 Top all-time** — `stats:top_books` sorted set, canonical-key normalized to merge "هكذا تتعافي" / "هكذا تتعافى" / "هكذا تتعافي + author" into one entry.
- **📅 Top this week** — separate ISO-week bucket (`stats:top_books:week:YYYY-Www`, 21-day TTL) so the weekly view actually changes week-to-week.
- **Cache-hit aware** — every successful delivery (cache hit or fresh download) increments the leaderboard.
- **Complaint filter** — messages like "هذا ليس الكتاب المطلوب" are excluded from leaderboard.
- **Smart truncation** — long titles cut at word boundaries (no more "Full boo" mid-word).

---

## 🎬 Live demo & how to use

1. Open [@kholasaelktob_Bot](https://t.me/kholasaelktob_Bot) on Telegram.
2. Type any Arabic book name (or `/search رواية حوار مع صديقي الملحد`).
3. Wait ~5–10 seconds — the bot replies with a PDF.
4. Tap **📘 ملخص الكتاب** under the file for an AI-generated structured summary.
5. Use `/profile` to see your streak, badges, and Premium status.
6. Use `/invite` to invite friends and earn Premium days.

In groups: prefix the message with `بوت`, `bot`, `كتاب`, or mention `@<bot_username>`.

| Command | Effect |
|---|---|
| `/start` | Welcome + your usage today |
| `/search كتاب` | Direct search |
| `/random` | Random Arabic book by genre |
| `/last` | Re-deliver your most recent book |
| `/profile` | Your stats, streak, badges, Premium status |
| `/invite` | Your referral link + tier progress |
| `/wishlist` | Save / list books for later |
| `/queue` | Position in worker queue |
| `/cancel` | Cancel a pending request |
| `/stats` | Today's remaining quota |
| `/history` | Last 7 books you requested |
| `/help` | Full command list |

---

## 🏗️ Architecture

```
╔══════════════════════════════════════════════════════════════╗
║                    TELEGRAM SERVERS                          ║
╚══════════════════════╦═══════════════════════════════════════╝
                       ║  Long Polling (500ms)
╔══════════════════════▼═══════════════════════════════════════╗
║  GATEWAY      commands · callbacks · messageHandler          ║
╠══════════════════════╦═══════════════════════════════════════╣
║  GUARDS       ban? · maintenance? · rateLimit? · daily?      ║
║               (Redis pipeline — single round-trip)           ║
╠══════════════════════╦═══════════════════════════════════════╣
║                      │                                       ║
║         ┌────────────┴────────────┐                          ║
║         ▼                         ▼                          ║
║  Q_HIGH (premium)          Q_NORMAL (free)                   ║
║         │                         │                          ║
║         └─────┬─────────┬─────────┘                          ║
║               ▼         ▼         ▼                          ║
║          Worker 1   Worker 2   Worker 3                      ║
║                                                              ║
║          DLQ (3 retries) ──→ alert watcher                   ║
╠══════════════════════╦═══════════════════════════════════════╣
║   SEARCH ENGINE      │   VALIDATION + DELIVERY               ║
║   ────────────────   │   ─────────────────────               ║
║   Redis cache?       │   HEAD probe (8s)                     ║
║   Firecrawl ×14      │   filename trust score                ║
║   Fuzzy fallback     │   %PDF magic bytes                    ║
║   Cache 1h hit/5m miss│  text density + pages                ║
║                      │   Mistral AI (10-provider failover)   ║
║                      │   sendDocument                        ║
║                      │   cache fileId → Postgres             ║
╠══════════════════════╧═══════════════════════════════════════╣
║   ENGAGEMENT  Streak Lua · Badges SADD · Referral tiers      ║
╠══════════════════════════════════════════════════════════════╣
║   STATE       Redis (queues, cache, rate-limits, streaks)    ║
║               Postgres (users, premium, search-logs, audit)  ║
╚══════════════════════════════════════════════════════════════╝
```

### Request lifecycle

```text
"ابغى روايه الأمير الصغير"
        │
        ▼  bookNameParser.ts  (strips "ابغى" / "روايه" / "تحميل" / "لخصلي" …)
   "الأمير الصغير"
        │
        ▼  Guards (Redis pipeline — ban? maintenance? rate? daily?)
        │  PASS
        ▼  enqueue()  →  priority = high (premium/admin) or normal (free)
   USER: "⏳ طلبك في الطابور — موقع #N"
        │
        ▼  Worker picks up job
   searchWithFuzzyFallback()
   ├─ Redis cache HIT?  ──→ skip Firecrawl, use cached file_id
   ├─ Firecrawl scrape (14 sources, parallel)
   └─ Fuzzy match fallback if no exact hits
        │
        ▼  findValidPdfUrls()
   filter blacklist · filter hard-blocked · filter viewer-only · per-source trust
        │
        ▼  downloadAndSend()
   HTTP HEAD (8s) → %PDF bytes → text density → page count
   ├─ filename score ≥ threshold AND domain trusted ──→ skip AI (saves cost)
   └─ Mistral AI judge (with 9-provider failover)
        │  PASS
        ▼  sendDocument → cache fileId → Postgres write
        │
        ▼  Engagement signals (parallel, fail-open)
   ├─ updateStreakOnDownload (atomic Lua)
   ├─ checkDownloadBadges (SADD per threshold)
   ├─ activateReferralOnFirstDownload (welcome gift + tier check)
   └─ trackDownload → leaderboard zincrby (canonical key)
        │
        ▼  ✅ user receives PDF (+ optional 🔥 streak + 🏅 badge messages)
```

---

## 🛠️ Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 + TypeScript 5.4 | Strict mode, native `fetch`, top-level `await`, AsyncLocalStorage |
| Bot library | `node-telegram-bot-api` 0.67 | Mature, long-polling and webhook support, Stars/payments built-in |
| HTTP server | Express 4 + Helmet 8 | Battle-tested, simple, good middleware ecosystem |
| Queue & cache | Redis 7 + Lua scripts | Single-RTT atomic operations for rate-limits, streaks, dedup |
| Database | PostgreSQL 16 + Drizzle ORM | Type-safe queries, native migrations, no schema drift |
| Search | Firecrawl API | Multi-domain crawl in one credit, AI-friendly extraction |
| AI | 10-provider failover stack | See [AI provider failover](#-ai-provider-failover) |
| Browser automation | Playwright (Chromium) | Used only for noor-book Cloudflare bypass |
| Build | esbuild → CJS bundle | <600 KB output, ~50ms cold build |
| Container | Docker + Compose | One-command dev + prod parity |
| CI | GitHub Actions | typecheck + build + 13 smoke tests on every PR |

---

## 📚 Sources covered

The **14 Arabic libraries** currently configured (priority order):

| # | Source | Domain | Notes |
|---|---|---|---|
| 1 | 🏛️ Internet Archive | `archive.org` | Trusted; classical literature, large catalog |
| 2 | 🌙 مكتبة نور | `noor-book.com` | Cloudflare-protected; resolved via Playwright |
| 3 | 📗 هنداوي | `hindawi.org` | High-quality classical Arabic literature |
| 4 | 📖 المكتبة الوقفية | `waqfeya.net` | Religious & academic |
| 5 | 📚 المكتبة الشاملة | `al-maktaba.org` | Largest Arabic Islamic library |
| 6 | 📗 مكتبة الكتب | `books-library.net` | General catalog |
| 7 | 📘 كتوباتي | `kotobati.com` | Modern fiction |
| 8 | 📕 فولة بوك | `foulabook.com` | Mixed catalog |
| 9 | 📓 نوف بوك | `novbook.net` | Mixed catalog |
| 10 | 📙 الكتاب العربي | `arabic-book.net` | Mixed catalog |
| 11 | 📄 كتاب PDF | `ktabpdf.com` | Mixed catalog |
| 12 | 🗂️ كتب PDF | `kutub-pdf.net` | Mixed catalog |
| 13 | 📑 كتوبم | `kutubm.com` | Mixed catalog |
| 14 | 📕 مكتبتي PDF | `mktbtypdf.com` | Mixed catalog |

Each source has its own success/failure counters in Redis and is **auto-disabled** when its rolling rejection rate crosses tier-specific thresholds. Operators can toggle any source manually from the dashboard, or **hard-block** a domain so it's never queried.

> Adding a source is straightforward: append an entry to <code>server/bot/sources.ts</code> with name, hostname, priority, and (optionally) trusted-filename patterns. No deploy gymnastics.

---

## 🤖 AI provider failover

Validating a PDF and generating book summaries both depend on AI. To stay cheap and resilient, the bot uses a **10-provider stack** with configurable order and failover:

| Provider | Used for | Free tier |
|---|---|---|
| **Mistral AI** | PDF judge (primary) | Yes |
| **Google Gemini** | Summaries (primary) | Yes (15/min for 2.5-flash) |
| **Cerebras** | Summary failover | Yes |
| **Cloudflare Workers AI** | Summary failover | Yes (10k req/day) |
| **GitHub Models** | Summary failover | Yes (with GitHub account) |
| **Groq** | Summary failover | Yes |
| **OpenRouter** | Summary failover | Pay-as-you-go |
| **SambaNova** | Summary failover | Yes (free tier) |
| **You.com** | Summary failover | Pay-as-you-go |
| **OpenAI-compatible** | Generic adapter | Depends |

Each provider has a small adapter under <code>server/bot/aiProviders/*.ts</code> conforming to a single interface. The registry tries them in order; on rate-limit / 4xx / 5xx, it falls through to the next. **Nothing is required beyond the primary** — set just `MISTRAL_API_KEY` + `GEMINI_API_KEY` and the bot works fully. Adding more providers buys you redundancy.

---

## 🚀 Quickstart

### Local dev (Docker, recommended)

```bash
# 1. Clone and configure
git clone https://github.com/ahmedallam222/book-bot.git
cd book-bot
cp .env.example .env
# Open .env and set BOT_TOKEN, FIRECRAWL_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY

# 2. Spin up the full stack (bot + postgres + redis)
docker compose up -d

# 3. Watch the logs
docker compose logs -f bot
```

You should see:

```
[INFO] [bot] Bot started: @your_bot (123456789)
[INFO] [bot] 3 workers started
[INFO] [server] Server ready on 0.0.0.0:5000 — Dashboard: /dashboard
```

Open `http://localhost:5000/dashboard?token=<DASHBOARD_TOKEN>` to access the admin UI.

### Local dev (no Docker)

```bash
# Requires Node 20+, Postgres 16, Redis 7 running locally
npm ci
cp .env.example .env  # configure DATABASE_URL, REDIS_URL, BOT_TOKEN, …
npm run db:push       # apply schema
npm run dev           # tsx watch mode
```

### Test that it works

In Telegram, message your bot:

```
الأمير الصغير
```

Within ~10 seconds you should receive a PDF. If not, check:

- `docker compose logs bot` for errors
- The dashboard's "per-source health" card
- That `FIRECRAWL_API_KEY` has remaining credits

---

## ⚙️ Environment variables

The full set is documented in `.env.example`. Highlights:

```bash
# ─── Required ────────────────────────────────────────
BOT_TOKEN=                                     # from @BotFather
FIRECRAWL_API_KEY=                             # firecrawl.dev (search)
MISTRAL_API_KEY=                               # mistral.ai (PDF validator)
GEMINI_API_KEY=                                # ai.google.dev (summaries)
DATABASE_URL=postgresql://bookbot:pw@db:5432/bookbot
REDIS_URL=redis://redis:6379

# ─── Admin & dashboard ──────────────────────────────
ADMIN_IDS=123456789,987654321                  # comma-separated Telegram IDs
DASHBOARD_TOKEN=<long-random-string>           # bearer auth for /dashboard

# ─── Operational tuning ─────────────────────────────
DAILY_LIMIT_FREE=5                             # downloads/day, free tier
DAILY_LIMIT_PREMIUM=10
QUEUE_WORKERS=3
BOT_PORT_BIND=127.0.0.1                        # 0.0.0.0 to expose; PUT REVERSE PROXY!

# ─── PDF validator thresholds ───────────────────────
PDF_VALIDATE_REJECT_THRESHOLD=0.12             # filename score that auto-rejects
PDF_VALIDATE_TRUST_THRESHOLD=0.50              # filename score that bypasses AI
PDF_MIN_PAGES=15                               # below this → "looks like TOC"

# ─── AI failover (set what you have) ────────────────
CEREBRAS_API_KEY=
CLOUDFLARE_AI_TOKEN=
GROQ_API_KEY=
GITHUB_MODELS_TOKEN=
OPENROUTER_API_KEY=
SAMBANOVA_API_KEY=
YOUCOM_API_KEY=

# ─── Summary daily caps ─────────────────────────────
SUMMARY_DAILY_LIMIT_FREE=2
SUMMARY_DAILY_LIMIT_PREMIUM=10
SUMMARY_DAILY_LIMIT_GLOBAL=1200                # global daily cap

# ─── Hard-blocked domains (optional) ────────────────
HARD_BLOCKED_DOMAINS_EXTRA=                    # comma-separated, never fetch
NOORBOOK_BROWSER_IDLE_MS=120000                # idle browser auto-close
```

See `.env.example` for the full list (51 vars total) with defaults and explanations.

---

## 🤖 Bot commands

### User commands

| Command | Description |
|---|---|
| `/start` | Welcome + remaining quota |
| `/search <book>` | Direct search (skips intent detection) |
| `/random` | Random Arabic book picked from genre catalog |
| `/last` | Re-deliver the most recent book you requested |
| `/profile` | Your reading stats: streak, badges, Premium status, referrals |
| `/invite` | Your referral link + tier progress + earned-rewards summary |
| `/wishlist <book>` | Add a book to your personal wishlist |
| `/wishlist` | Show your wishlist |
| `/history` | Your last 7 requests |
| `/queue` | Your current position in the worker queue |
| `/cancel` | Cancel a pending request |
| `/stats` | Quota used today + reset time |
| `/premium` | Buy Premium with Telegram Stars |
| `/help` | Full command list |

### Admin commands (require `ADMIN_IDS`)

| Command | Description |
|---|---|
| `/admin` | Open the admin keyboard |
| `/premium_add <userId>` | Grant Premium (with optional days) |
| `/premium_remove <userId>` | Revoke Premium |

The admin keyboard exposes the full set: maintenance toggle, broadcast composer, source toggles, ban/unban, daily-limit overrides, premium grants, telemetry traces, and live source-health stats.

---

## 💎 Premium tier

Premium is purely **time-bounded** — there is no permanent grant. All rewards (manual admin grants, referral tier rewards, payment renewals) extend the TTL via `SETEX`.

| Capability | Free | Premium |
|---|---|---|
| Daily downloads | 5 | 10 |
| Daily AI summaries | 2 | 10 |
| Queue priority | normal | high |
| Renewal | n/a | Telegram Stars |

Activated via `/premium`, paid through Telegram Stars. The successful-payment handler is **idempotent** against Telegram's redelivery quirk (uses `SET … NX` on the unique `telegram_payment_charge_id`), so a single payment never grants double Premium.

---

## 📊 Admin dashboard

A single-file SPA served at `/dashboard?token=<DASHBOARD_TOKEN>`. Mobile-responsive, Arabic-localized.

What you can do from it:

- **Funnel** — daily/weekly requests, found, validated, delivered.
- **Top books** — all-time + weekly leaderboards (canonical-key normalized).
- **Per-source health** — success rate, last failure, auto-disable status.
- **Telemetry traces** — each step of every recent request, with timing.
- **Queue + DLQ** — current depth, in-flight jobs, failure samples.
- **User management** — search by ID, ban/unban, Premium grants, daily-limit overrides, free-text notes.
- **Source toggles** — enable/disable any of the 14 sources.
- **Maintenance mode** — one-click toggle, auto-announces resume to known groups.
- **Broadcast** — compose Markdown messages targeted at all / premium / active-7d cohorts.
- **Audit log** — every admin action recorded with actor, target, action.

> ⚠️ The dashboard is **HTTP only** out of the box. For production, terminate TLS at a reverse proxy (Caddy, Nginx, Traefik) and bind the bot to `127.0.0.1` via `BOT_PORT_BIND`. See [Security](#-security).

---

## 🔌 REST API

A minimal authenticated REST API for ops + integrations. All routes require `Authorization: Bearer <DASHBOARD_TOKEN>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/stats/daily?days=7` | Funnel for the last N days |
| `GET` | `/api/stats/sources` | Per-source success/failure |
| `GET` | `/api/top-books?limit=20` | All-time leaderboard |
| `GET` | `/api/top-books-weekly?limit=20` | Current ISO-week leaderboard |
| `GET` | `/api/queue/status` | Queue depth + worker count |
| `GET` | `/api/users/:id` | User record + Premium status |
| `POST` | `/api/users/:id/premium` | Grant Premium (body: `{ days }`) |
| `POST` | `/api/broadcast` | Send a broadcast (body: `{ target, text }`) |
| `POST` | `/api/maintenance` | Toggle maintenance (body: `{ enabled }`) |
| `GET` | `/healthz` | Liveness check (no auth) |

Per-IP rate-limits apply to public endpoints (`/healthz` only).

---

## 🔒 Security

**The dashboard ships HTTP-only with bearer auth — adequate for trusted networks but not the public internet.** Always put a TLS-terminating reverse proxy in front before exposing.

Other defenses:

- **Helmet** — sane HTTP security headers.
- **Bearer token** — all `/api/*` and `/dashboard` require `DASHBOARD_TOKEN`.
- **IP rate-limit** — sliding-window, atomic Lua, per-route configurable.
- **Telegram payload validation** — every update is shape-checked against expected fields.
- **Postgres parameterized queries via Drizzle** — no raw SQL, no injection vectors.
- **Atomic Redis ops everywhere** — Lua scripts for streaks, rate-limits, and idempotent payment handling.
- **No secret leaks in logs** — every error is shaped with `String(e).slice(0, 200)` and reviewed.
- **Run on a private subnet + `BOT_PORT_BIND=127.0.0.1`** — the proxy is the only public ingress.

If you find a vulnerability, please **email** rather than open a public issue. Contact: see GitHub profile.

---

## 📁 Project structure

```
book-bot/
├── .github/workflows/ci.yml          ← typecheck + build + smoke tests on PRs
├── docker-compose.yml                ← bot + postgres + redis with healthchecks
├── Dockerfile                        ← multi-stage build, non-root runtime
├── deploy.sh                         ← one-command rebuild on the prod box
├── .env.example                      ← all 51 env vars documented
│
├── server/
│   ├── index.ts                      ← entrypoint, workers, graceful shutdown
│   ├── routes.ts                     ← express routes (admin + public API)
│   ├── storage.ts                    ← Drizzle ORM data access
│   ├── dashboard.html                ← single-file admin SPA
│   │
│   └── bot/
│       ├── index.ts                  ← bot bootstrap + event listeners
│       ├── commands.ts               ← /start, /search, /profile, /invite …
│       ├── callbacks.ts              ← inline-keyboard handlers
│       ├── messageHandler.ts         ← free-text + group triggers
│       ├── bookRequest.ts            ← guards + enqueue + engagement hooks
│       ├── bookNameParser.ts         ← Arabic dialect / verb stripping
│       ├── engine.ts                 ← search orchestration
│       ├── fuzzy.ts                  ← typo-tolerant title matching
│       ├── sources.ts                ← 14 library configs
│       ├── pdfValidator.ts           ← multi-stage PDF judge
│       ├── verify.ts                 ← URL filtering + hard-block
│       ├── download.ts               ← HTTP fetch + Telegram sendDocument
│       ├── noorBookResolver.ts       ← Playwright Cloudflare bypass
│       ├── queue.ts                  ← Redis high/normal/DLQ
│       ├── workers.ts                ← worker loop + retries
│       ├── userSettings.ts           ← premium / limits / notes
│       ├── analytics.ts              ← funnel + leaderboards (canonical-key)
│       ├── streak.ts                 ← daily streak (atomic Lua, Cairo TZ)
│       ├── badges.ts                 ← 10-tier badge unlocking
│       ├── referral.ts               ← tiered referral rewards
│       ├── admin.ts                  ← /profile builder + admin handlers
│       ├── telemetry.ts              ← per-request trace
│       ├── alertWatcher.ts           ← admin Telegram alerts
│       ├── rateLimit.ts              ← Lua sliding window
│       ├── ipRateLimit.ts            ← public-API per-IP guard
│       ├── summary.ts                ← AI summary generator
│       ├── summaryHandler.ts         ← summary command flow + badge wiring
│       ├── reactions.ts              ← bot emoji reactions
│       ├── text.ts                   ← Arabic normalization + Markdown escape
│       ├── weekly.ts                 ← weekly digest (top books + funnel)
│       ├── dailyDigest.ts            ← daily admin DM
│       ├── config.ts                 ← all constants + hard-blocked list
│       │
│       └── aiProviders/              ← 10 swappable AI adapters
│           ├── registry.ts           ← failover order + selection
│           ├── prompt.ts             ← shared prompt builders
│           ├── types.ts              ← common interface
│           ├── mistralProvider.ts
│           ├── gemini.ts
│           ├── cerebras.ts
│           ├── cloudflare.ts
│           ├── githubModels.ts
│           ├── groq.ts
│           ├── openaiCompat.ts
│           ├── openrouter.ts
│           ├── sambanova.ts
│           └── youcom.ts
│
├── shared/schema.ts                  ← Drizzle types (single source of truth)
├── script/
│   ├── build.ts                      ← esbuild bundler
│   ├── run-tests.mjs                 ← test runner used by CI
│   ├── postgres-backup.sh            ← daily pg_dump with rotation
│   └── migrate-*.mjs                 ← one-off data migrations
│
├── docs/
│   ├── RUNBOOK.md                    ← production operations playbook
│   ├── PRODUCTION.md                 ← deploy notes
│   └── SERVER_SYNC_PLAN.md
│
├── test-*.mjs                        ← 13 smoke tests (CI runs them all)
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE                           ← MIT
└── README.md                         ← you are here
```

---

## 🖥️ Deployment

### Minimum server

| Resource | Min | Recommended |
|---|---|---|
| RAM | 1 GB | 2 GB |
| CPU | 1 vCPU | 2 vCPU |
| Disk | 10 GB | 20 GB |
| OS | any with Docker | Ubuntu 22.04 / 24.04 |

### One-command deploy

```bash
ssh you@your-server
git clone https://github.com/ahmedallam222/book-bot.git
cd book-bot
cp .env.example .env && nano .env       # set BOT_TOKEN, FIRECRAWL_API_KEY, …
bash deploy.sh                          # build + (re)start the stack
```

### Useful commands

```bash
# tail bot logs
docker compose logs -f bot

# restart without rebuild
docker compose restart bot

# update from main
bash deploy.sh

# enter the bot container
docker exec -it book-bot-bot-1 sh

# backup the database
sudo /home/ubuntu/book-bot/script/postgres-backup.sh
```

### Reverse proxy (recommended)

Caddy auto-issues Let's Encrypt certs and is a one-liner:

```caddy
admin.your-domain.com {
    reverse_proxy 127.0.0.1:5000
}
```

Then set `BOT_PORT_BIND=127.0.0.1` in `.env` and restart. The dashboard is now HTTPS-only and not reachable from the public internet directly.

### pm2 alternative (no Docker)

```bash
npm ci && npm run build
pm2 start dist/index.cjs --name kholasa --max-memory-restart 512M
pm2 save && pm2 startup
```

---

## 📈 Monitoring & telemetry

Every book request creates a structured trace:

```json
{
  "traceId": "abc123",
  "userId": "987654321",
  "bookName": "الأمير الصغير",
  "steps": [
    { "event": "enqueued",    "ms": 0    },
    { "event": "dequeued",    "ms": 80   },
    { "event": "cache_miss",  "ms": 92   },
    { "event": "firecrawl",   "ms": 2240 },
    { "event": "validated",   "ms": 4150 },
    { "event": "sent",        "ms": 4800 }
  ],
  "totalMs": 4800,
  "source": "archive.org",
  "fromCache": false,
  "result": "delivered"
}
```

Live funnel visible in the dashboard:

```
100% requests → 85% search-results → 72% validated → 65% delivered ✅
```

Auto-alerts (Telegram DM to admins):

| Trigger | Cooldown |
|---|---|
| DLQ ≥ 20 jobs | 1 h |
| 24 h success rate < 50% (with ≥20 requests) | 1 h |
| Firecrawl quota exceeded | 1 / day |
| Firecrawl rate-limited | 10 min |

Implementation: `server/bot/alertWatcher.ts`. Atomicity is provided by Redis `SET … NX` cooldown locks so two checks can't fire the same alert twice.

A **daily digest** is auto-DM'd to admins each morning with: 24h active users, success rate, top books, per-source numbers, queue/DLQ depth.

---

## 💾 Backups & disaster recovery

A daily Postgres backup script ships in <code>script/postgres-backup.sh</code>:

```bash
sudo crontab -e
0 4 * * * /home/ubuntu/book-bot/script/postgres-backup.sh >> /var/log/bookbot-backup.log 2>&1
```

The script:
- Runs `pg_dump` inside the running `db` container.
- Pipes through `gzip -9` to a timestamped file under `/var/backups/bookbot/`.
- Uses a `.tmp` + atomic rename so a half-finished dump never overwrites a good one.
- Prunes anything older than **14 days** automatically.

For full DR, replicate the dumps off-site:

```bash
aws s3 cp /var/backups/bookbot/ s3://your-bucket/bookbot/ --recursive
```

To restore:

```bash
gunzip -c /var/backups/bookbot/bookbot-2026-05-05.sql.gz \
  | docker exec -i book-bot-db-1 psql -U bookbot -d bookbot
```

Redis state is intentionally **not** part of the backup loop — every Redis key is either rebuilt from Postgres on restart or has a TTL that forgets within hours.

---

## 🧪 Testing

Tests live as standalone `test-*.mjs` files at the repo root. Each file is a deterministic probe: no network, no real Telegram. Many tests import the live `.ts` modules through `tsx` for accurate behaviour.

```bash
# run the full suite
npm test

# typecheck
npm run typecheck

# build
npm run build

# run a single test by filter
TEST_FILTER=streak npm test
```

Coverage of current tests (13 files):

| Test | What it pins down |
|---|---|
| `test-cache-key-normalization.mjs` | Arabic normalization → Redis key parity |
| `test-cache-poison-defense.mjs` | Refuse to cache opaque/numeric URLs from untrusted sources |
| `test-dedup-isPremium.mjs` | Per-request memoisation cuts Redis round-trips |
| `test-direct-send-safety.mjs` | Direct-mode never delivers a viewer-only / paid URL |
| `test-engagement.mjs` | Streak + badges + referral correctness (54 assertions) |
| `test-failure-retry.mjs` | Apology message uses Modern Standard Arabic |
| `test-garbage-meta-and-noor-tag.mjs` | Reject "1 Image" titles + early-skip noor non-book pages |
| `test-leaderboard.mjs` | Canonical key + ISO-week + complaint filter + bundle markers |
| `test-leaderboard-cache-hits.mjs` | Cache-hit gate regression check (9 assertions) |
| `test-markdown-balance.mjs` | Telegram Markdown markers paired in /invite messages |
| `test-paid-book-fallback.mjs` | Paid-book detection produces user-visible explanation |
| `test-parser-preserves-قراءة.mjs` | Don't strip "قراءة" / "اقرأ" when they are part of a title |
| `test-premium-expiration.mjs` | TTL-based expiry + lazy cleanup |
| `test-source-weighting.mjs` | Auto-disable thresholds (tier-1, tier-2, trust) |
| `test-summary-badge-wiring.mjs` | Summary badge import + call ordering (10 assertions) |
| `test-telemetry-self-trim.mjs` | Trace-store self-trims to bounded memory |
| `test-validate-numeric-id.mjs` | Telegram ID validation incl. `Number.isSafeInteger` |

CI workflow: <code>.github/workflows/ci.yml</code> — typecheck, build, then every smoke test, blocking PR merge on failure.

---

## ⚡ Performance & cost engineering

The bot is engineered to stay cheap. Key tactics:

- **Filename trust score + domain trust list** bypass ~70% of Mistral AI calls. AI is only consulted on ambiguous cases.
- **30-day per-book cache** of validated PDFs. A re-request for the same book skips Firecrawl, the validator, and the AI entirely — Telegram simply re-uses the cached `file_id`.
- **Redis pipeline for guards** — ban / maintenance / rate / daily checks all run in a single network round-trip per request.
- **Lua sliding-window rate-limit** — atomic, no race, no Lua-script reload.
- **Per-source success/failure counters cached in-memory** with 30s TTL — analytics queries don't hit Redis on every request.
- **Garbage-title detection** — early-rejects PDFs whose `/Title` metadata is "1 Image", "Untitled", "Microsoft Word - …", before sending the AI a misleading prompt.
- **Bounded telemetry** — trace store self-trims to 200 entries.
- **noor-book early-skip** — non-book noor URLs (`/tag`, `/category`, `/user`, `/search`) get rejected without spinning Chromium for 30s.
- **Hard-blocked domains** — known-bad domains never reach the HEAD-probe step.
- **3 workers** with bounded concurrency — predictable resource usage on a 2 GB VM.

Order-of-magnitude prod numbers (tracked daily):
- p50 delivery time: ~5 s (cache hit ~1 s)
- p95 delivery time: ~12 s
- AI calls per delivered book: ~0.3
- Firecrawl credits per delivered book: ~0.4 (cache absorbs the rest)

---

## 🤝 Contributing

Contributions are welcome. The full guide is in <code>CONTRIBUTING.md</code> — short version:

1. Fork → branch (`feat/...` or `fix/...`).
2. Make sure `npm run typecheck`, `npm run build`, and `npm test` all pass.
3. Add / update a `test-*.mjs` for any non-trivial behaviour change.
4. Open a PR against `main` with a clear description of the **problem**, the **fix**, and any **trade-offs**.
5. CI must be green; one approving review is required.

We follow **Conventional Commits** (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `chore:`).

Issues for newcomers are labelled `good first issue`. Before you start a large feature, please open an issue first to align on the design.

---

## 🗺️ Roadmap

**Done:**
- [x] Two-tier Redis queue + DLQ
- [x] Multi-stage PDF validator with Mistral AI fallback
- [x] Telegram Stars payments (with idempotent redelivery)
- [x] Web admin dashboard (mobile-responsive)
- [x] Per-request telemetry traces + funnel
- [x] Arabic dialect / intent-verb stripping
- [x] AI book summaries with 10-provider failover
- [x] Auto-disable misbehaving sources (3 tiers)
- [x] Wishlist, history, last-book reload
- [x] Auto-announce maintenance end to known groups
- [x] Garbage-title rejection + noor non-book early-skip
- [x] Daily Postgres backup script with rotation
- [x] Docker log rotation
- [x] CI: typecheck + build + smoke tests on every PR
- [x] **Engagement: streak + 10 badges + tiered referrals** (v32.0)
- [x] **Real weekly leaderboard with canonical-key normalization** (v32.1)
- [x] **Hard-blocked domains list** (v32.0)

**Planned:**
- [ ] Webhook mode (currently long-poll only)
- [ ] Wishlist hit-notification when a previously-unavailable book becomes available
- [ ] English-language book support
- [ ] Recurring premium subscriptions via Telegram (when API stabilises)
- [ ] CSV export of analytics from the dashboard
- [ ] S3 off-site backup wrapper
- [ ] OpenTelemetry exporter (Prometheus + Grafana ready)
- [ ] Vitest migration for the smoke tests
- [ ] Personalized recommendations ("readers who downloaded X also enjoyed Y")
- [ ] Reading goals (`/goal 5` → monthly target with progress bar)
- [ ] Voice search (Whisper transcription)
- [ ] Inline mode (`@kholasaelktob_Bot أرض زيكولا` works in any chat)

---

## ❓ FAQ

**Q: Do I need all the AI provider keys?**
No — `MISTRAL_API_KEY` and `GEMINI_API_KEY` are enough for full functionality. Adding more providers buys you redundancy when a free tier hits its rate limit.

**Q: What about copyright?**
The bot only **points to** PDFs that are already publicly indexable on third-party libraries. It does not host content. The 14 sources are all public Arabic libraries that publish books openly. Operators are responsible for legal compliance in their jurisdiction.

**Q: Can it handle non-Arabic books?**
The pipeline is language-agnostic; only the parser and source list are Arabic-tuned. Adding English support is on the roadmap.

**Q: Is the dashboard secure to expose to the internet?**
Out of the box: HTTP + bearer auth — adequate for trusted networks but not the public internet. **Always** put a TLS-terminating reverse proxy (Caddy is easiest) in front before exposing.

**Q: Why not Vitest?**
We started with standalone `.mjs` files because every test is fully deterministic and we wanted zero framework overhead. Vitest migration is on the roadmap once we cross ~20 test files.

**Q: How do I rotate the bot token?**
1. `@BotFather` → `/revoke` → pick the bot.
2. Get the new token from BotFather.
3. Update `BOT_TOKEN` in `.env` on the server.
4. `docker compose up -d --force-recreate bot`.

**Q: Are there any rate limits I should know about?**
Yes — see <code>server/bot/rateLimit.ts</code>. Per-user: 1 request / 6 s, 5 requests / minute (free), 10 / minute (premium). Per-IP for the public API: 10 req/min by default. All sliding-window via Redis Lua.

**Q: How is the streak feature timezone-aware?**
All date keys use **Cairo timezone (UTC+2)**, not UTC, to prevent off-by-one errors. The streak Lua script atomically computes `today` / `yesterday` strings in Cairo TZ before incrementing.

---

## 🙏 Acknowledgments

This project stands on the shoulders of:

- The **14 Arabic libraries** that publish public-domain and open-access content for free — without them this bot would be useless.
- [Firecrawl](https://firecrawl.dev) for making multi-domain search affordable.
- [Mistral AI](https://mistral.ai) for an honest free tier that doesn't rate-limit hostile.
- [Google Gemini](https://ai.google.dev) for high-quality Arabic summary generation.
- [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) maintainers — by far the most stable JS Telegram lib.
- [Drizzle ORM](https://orm.drizzle.team) for typed migrations that don't drift.
- [Devin](https://devin.ai) — the AI engineer that helped land 100+ PRs over the project's life.

---

## 📄 License

[MIT](LICENSE) © 2024-2026 Ahmed Allam ([@ahmedallam222](https://github.com/ahmedallam222)) and contributors.

You are free to fork, modify, self-host, and redistribute. Attribution appreciated but not required.

---

<div align="center">

### ⭐ Star this repo if you find it useful

**Built with ❤️ for Arabic readers**

[Try the bot](https://t.me/kholasaelktob_Bot) · [Read the changelog](CHANGELOG.md) · [Contribute](CONTRIBUTING.md) · [⬆ Back to top](#-kholasa-books-bot--خلاصة-الكتب)

</div>
