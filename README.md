<div align="center">

# 📚 Kholasa Books Bot — خلاصة الكتب

### Arabic-first Telegram bot that searches 13 Arabic libraries, validates the PDF with multi-stage AI, and delivers the file directly inside Telegram.

#### بوت تيليغرام يبحث في 13 مكتبة عربية، يتحقق من الـ PDF بنظام ذكي متعدد المراحل، ويُرسل الكتاب مباشرة داخل تيليغرام.

<br/>

[![CI](https://github.com/ahmedallam222/book-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmedallam222/book-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docker.com)

![Lines of Code](https://img.shields.io/badge/Lines_of_Code-14k+-blueviolet?style=flat-square)
![TS Modules](https://img.shields.io/badge/TS_Modules-59-blue?style=flat-square)
![Sources](https://img.shields.io/badge/Arabic_Sources-13-orange?style=flat-square)
![AI Providers](https://img.shields.io/badge/AI_Providers-10-purple?style=flat-square)

<br/>

> **Try it:** [@kholasaelktob_Bot](https://t.me/kholasaelktob_Bot) on Telegram. Type a book name in Arabic and watch it arrive as a PDF.

[Quickstart](#-quickstart) · [Features](#-features) · [Architecture](#%EF%B8%8F-architecture) · [API](#-rest-api) · [Contributing](CONTRIBUTING.md)

</div>

---

## 📖 Table of Contents

- [Why?](#-why)
- [Features](#-features)
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

Searching for an Arabic book PDF online usually takes 5–15 minutes — broken links, paywalled mirrors, fake "download" buttons, files that turn out to be table-of-contents PDFs, and AI-generated junk. Kholasa Books does that work for you in **under 10 seconds on average**:

```
"الأمير الصغير"  →  Kholasa  →  📄 Real PDF inside Telegram
```

What makes it different from a generic Google search bot:

- **Quality-gated**: every PDF passes through a multi-stage validator (HTTP check → magic bytes → text density → page count → AI judge). Junk files get rejected before they reach you.
- **Cost-aware AI**: a filename score + trust-list bypass eliminates ~70% of AI calls. The bot stays cheap to run even at scale.
- **Source-health-aware**: each of the 13 libraries has its own success/failure stats and gets auto-disabled when it goes bad. No single broken source kills the bot.
- **Resilient**: 3 workers pulling from a Redis queue, DLQ for failures, graceful shutdown, full job recovery on restart.
- **Arabic-first**: handles dialects (خليجي, مصري, شامي), removes filler verbs ("لخّصلي", "تحميل", "ابغى"), normalizes diacritics, preserves quoted titles intact.

---

## ✨ Features

### For users

| Domain | Details |
|---|---|
| 🔍 **Smart search** | 13 Arabic libraries searched in parallel via [Firecrawl](https://firecrawl.dev), with fuzzy fallback for typos. Understands dialect triggers and intent words. |
| 📄 **Real PDFs only** | Multi-stage validator: HTTP check → `%PDF` magic bytes → text density → page count → Mistral AI judge. Junk and viewer-only links never reach the user. |
| 📘 **AI book summaries** | Per-book structured summary (overview, key ideas, chapters, takeaways) with multi-provider AI failover. Cached per-book, daily quotas. |
| 🎲 **Discovery** | `/random` across 15 genres, `/weekly` curated pick, `/top` most-requested, `/history` last 7 books. |
| 🔖 **Personal organisation** | Wishlist (`/wishlist`), last-book one-tap reload (`/last`), queue inspection (`/queue`), cancel pending (`/cancel`). |
| 💳 **Telegram-native payments** | Premium via Telegram Stars — no card data, no third-party gateway. Renewals **extend** time rather than replace it. |
| 🛡️ **Defensive UX** | Clear error messages, "report broken file" button, rate-limit warnings, paid-book detection with explanation. |

### For operators

| Domain | Details |
|---|---|
| 📊 **Live dashboard** | Daily/weekly funnel, top books, per-source health, queue/DLQ stats, telemetry traces per request. |
| 👥 **User management** | Ban/unban, manual premium grants with custom durations, per-user daily-limit overrides, free-text notes. |
| 🔌 **Source toggles** | Enable/disable any of the 13 libraries from the dashboard. Auto-disable kicks in for failing or AI-rejected sources. |
| 📢 **Targeted broadcasts** | Send Markdown messages to all users, premium-only, or active-7-day cohort. Rate-limited at 30 msg/sec to respect Telegram limits. |
| 🔧 **Maintenance mode** | One-click maintenance toggle. Auto-announces service-back to known groups when cleared. |
| 🚨 **Auto-alerts** | Admin gets a Telegram DM when DLQ spikes, success rate drops, Firecrawl quota is near, or rate-limited. |

---

## 🎬 Live demo & how to use

1. Open [@kholasaelktob_Bot](https://t.me/kholasaelktob_Bot) on Telegram.
2. Type any Arabic book name (or `/search رواية حوار مع صديقي الملحد`).
3. Wait ~5–10 seconds — the bot replies with a PDF.

In groups: prefix the message with `بوت`, `bot`, `كتاب`, or mention `@<bot_username>`.

| Command | Effect |
|---|---|
| `/start` | Welcome + your usage today |
| `/search كتاب` | Direct search |
| `/random` | Random Arabic book by genre |
| `/last` | Re-deliver your most recent book |
| `/wishlist` | Save / list books for later |
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
║   Firecrawl ×13      │   filename trust score                ║
║   Fuzzy fallback     │   %PDF magic bytes                    ║
║   Cache 1h hit/5m miss│  text density + pages                ║
║                      │   Mistral AI (10-provider failover)   ║
║                      │   sendDocument                        ║
║                      │   cache fileId → Postgres             ║
╠══════════════════════╧═══════════════════════════════════════╣
║   STATE       Redis (queues, cache, rate-limits)             ║
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
        ▼  Guards (Redis pipeline)
   ban? maintenance? rateLimit? dailyLimit?
        │  PASS
        ▼  enqueue()  →  priority = high (premium/admin) or normal (free)
   USER: "⏳ طلبك في الطابور — موقع #N"
        │
        ▼  Worker picks up job
   searchWithFuzzyFallback()
   ├─ Redis cache HIT?  ──→ skip Firecrawl, use cached URLs
   ├─ Firecrawl scrape (13 sources, parallel)
   └─ Fuzzy match fallback if no exact hits
        │
        ▼  findValidPdfUrls()
   filter blacklist · filter viewer-only · per-source trust
        │
        ▼  downloadAndSend()
   HTTP HEAD (8s) → %PDF bytes → text density → page count
   ├─ filename score ≥ threshold AND domain trusted ──→ skip AI (saves cost)
   └─ Mistral AI judge (with 9-provider failover)
        │  PASS
        ▼
   sendDocument → cache fileId → trackDownload() → ✅ user receives PDF
```

---

## 🛠️ Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 + TypeScript 5.4 | Strict mode, native `fetch`, top-level `await`, AsyncLocalStorage |
| Bot library | `node-telegram-bot-api` 0.67 | Mature, long-polling and webhook support, Stars/payments built-in |
| HTTP server | Express 4 + Helmet 8 | Battle-tested, simple, good middleware ecosystem |
| Queue & cache | Redis 7 + Lua scripts | Single-RTT atomic operations for rate-limits and dedup |
| Database | PostgreSQL 16 + Drizzle ORM | Type-safe queries, native migrations, no schema drift |
| Search | Firecrawl API | Multi-domain crawl in one credit, AI-friendly extraction |
| AI | 10-provider failover stack | See [AI provider failover](#-ai-provider-failover) |
| Browser automation | Playwright (Chromium) | Used only for noor-book Cloudflare bypass |
| Build | esbuild → CJS bundle | <500KB output, ~50ms cold build |
| Container | Docker + Compose | One-command dev + prod parity |
| CI | GitHub Actions | typecheck + build + 11 smoke tests on every PR |

---

## 📚 Sources covered

The 13 Arabic libraries currently configured (priority order):

| # | Source | Notes |
|---|---|---|
| 1 | 🏛 Internet Archive (`archive.org`) | Trusted; mostly classical literature |
| 2 | 🌙 مكتبة نور (`noor-book.com`) | Cloudflare-protected; resolved via Playwright |
| 3 | 📗 هنداوي (`hindawi.org`) | High-quality classical Arabic literature |
| 4 | 📖 المكتبة الوقفية (`waqfeya.net`) | Religious & academic |
| 5 | 📚 المكتبة الشاملة (`shamela.ws`) | Largest Arabic Islamic library |
| 6 | 📗 مكتبة الكتب (`maktabakotob.com`) | General catalog |
| 7 | 📘 كتوباتي (`ketobati.com`) | Modern fiction |
| 8 | 📕 فولة بوك (`foulabook.com`) | Mixed catalog |
| 9 | 📓 نوف بوك (`noufbook.com`) | Mixed catalog |
| 10 | 📙 الكتاب العربي (`elkitabelarabi.com`) | Mixed catalog |
| 11 | 📒 كتاب PDF (`ketabpdf.com`) | Mixed catalog |
| 12 | 📔 كتب PDF (`kotobpdf.com`) | Mixed catalog |
| 13 | 📓 كتوبم (`kotobm.com`) | Mixed catalog |

Each source has its own success/failure counters in Redis and is auto-disabled when its rolling rejection rate crosses tier-specific thresholds. Operators can also toggle any source manually from the dashboard.

> Adding a source is straightforward: append an entry to <code>server/bot/sources.ts</code> with name, hostname, priority, and (optionally) trusted-filename patterns.

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

## ⚡ Quickstart

### Option 1 — Docker (recommended)

```bash
git clone https://github.com/ahmedallam222/book-bot.git
cd book-bot

cp .env.example .env
# edit .env — at minimum set BOT_TOKEN, FIRECRAWL_API_KEY, POSTGRES_PASSWORD

docker compose up -d --build
docker compose logs -f bot
```

Expected log:
```
[INFO] [bot] Starting Kholasa Books bot...
[Redis] connected
[INFO] [bot] Bot started: @your_bot (123456789)
[INFO] [queue] recoverStuckJobs done {"cleared":0,"orphanUserJobIds":0,...}
[INFO] [bot] 3 workers started
[INFO] [alerts] Alert watcher started — admins: 1
```

Hit `/start` in Telegram, send a book name, watch it arrive.

### Option 2 — Native (development)

```bash
# Prereqs: Node.js 20+, Redis 7, Postgres 16 running locally
git clone https://github.com/ahmedallam222/book-bot.git
cd book-bot

npm ci
cp .env.example .env       # edit with local DB/Redis URLs
npm run db:push            # create tables
npm run dev                # tsx watch mode
```

### Get your tokens

| Token | Where to get it | Required? |
|---|---|---|
| `BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` | ✅ |
| `FIRECRAWL_API_KEY` | https://firecrawl.dev/dashboard | ✅ |
| `POSTGRES_PASSWORD` | Generate: `openssl rand -hex 24` | ✅ |
| `DASHBOARD_SECRET` | Generate: `openssl rand -hex 32` | ✅ for prod |
| `MISTRAL_API_KEY` | https://mistral.ai/api | recommended |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey | recommended |
| `ADMIN_IDS` | Your Telegram ID (use [@userinfobot](https://t.me/userinfobot)) | recommended |

---

## ⚙️ Environment variables

The bot reads **51 environment variables** total. The most important ones are listed below; the full list with defaults is in <code>.env.example</code>.

### Required

```env
BOT_TOKEN=                                   # @BotFather token
POSTGRES_PASSWORD=change_me_strong           # openssl rand -hex 24
DATABASE_URL=postgresql://bookbot:${POSTGRES_PASSWORD}@db:5432/bookbot
REDIS_URL=redis://redis:6379
FIRECRAWL_API_KEY=                           # firecrawl.dev
```

### Strongly recommended

```env
MISTRAL_API_KEY=                             # PDF validator AI judge
GEMINI_API_KEY=                              # Summary generator (primary)
ADMIN_IDS=123456789,987654321                # comma-separated Telegram IDs
DASHBOARD_SECRET=                            # openssl rand -hex 32
DASHBOARD_ORIGIN=http://localhost:5000       # CORS origin for dashboard fetches
DASHBOARD_URL=                               # public URL shown in /admin reply
NODE_ENV=production
```

### Server / networking

```env
PORT=5000
BOT_PORT_BIND=127.0.0.1                      # 0.0.0.0 to expose; PUT REVERSE PROXY!
BIND_HOST=0.0.0.0                            # inside container
TRUST_PROXY=0                                # 1 behind nginx/caddy, 2 behind cloudflare
LOG_LEVEL=INFO                               # DEBUG | INFO | WARN | ERROR
LOG_FILE=                                    # path or empty for stdout
```

### AI provider failover (optional, all have free tiers)

```env
CEREBRAS_API_KEY=
CLOUDFLARE_AI_ACCOUNT_ID=
CLOUDFLARE_AI_API_TOKEN=
GITHUB_MODELS_TOKEN=
GROQ_API_KEY=
OPENROUTER_API_KEY=
SAMBANOVA_API_KEY=
TIMEOUT_AI_PROVIDER=20000                    # ms
```

### PDF validator thresholds

```env
PDF_VALIDATE_ACCEPT_THRESHOLD=0.40           # filename score that bypasses AI
PDF_VALIDATE_REJECT_THRESHOLD=0.12           # filename score that auto-rejects
MISTRAL_BYPASS_FILENAME_THRESHOLD=0.55       # if score ≥ this, skip AI on trusted domains
MISTRAL_NO_STREAK_LIMIT=4                    # consecutive AI rejections before short-circuit
MISTRAL_FAIL_OPEN=false                      # if Mistral itself fails, accept (true) or reject (false)
```

### Source auto-disable

```env
SOURCE_AUTO_DISABLE_MIN_ATTEMPTS=8           # tier-1: don't disable until 8 attempts
SOURCE_AUTO_DISABLE_MAX_RATE=0.50            # tier-1: disable if >50% fail
SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS=5      # tier-2 (harder): from 5 attempts
SOURCE_AUTO_DISABLE_HARD_MAX_RATE=0.80       # tier-2: disable if >80% fail
SOURCE_AUTO_DISABLE_TRUST_MIN_ATTEMPTS=10    # trust-list sources: from 10
SOURCE_AUTO_DISABLE_TRUST_MAX_RATE=0.85      # trust: disable only if >85% fail
LOW_SUCCESS_RATE_PENALTY_THRESHOLD=0.30      # rank below others when <30% success
MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN=4
MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST=10
```

### Summary feature

```env
SUMMARY_DAILY_LIMIT_FREE=3                   # per-user free quota
SUMMARY_DAILY_LIMIT_GLOBAL=1200              # global daily cap
SUMMARY_CACHE_TTL_SECONDS=2592000            # 30 days per-book cache
```

### noor-book Cloudflare resolver

```env
PLAYWRIGHT_CHROMIUM_PATH=                    # leave empty unless custom build
NOORBOOK_TIMEOUT_MS=30000                    # fail-fast on CF challenge
NOORBOOK_DOWNLOAD_TIMEOUT_MS=30000
NOORBOOK_BROWSER_IDLE_MS=120000              # idle browser auto-close
```

### Misc

```env
WORKER_COUNT=3
TEMP_DIR=/tmp/kholasa_books
BANNED_IDS=                                  # initial bans (comma-separated)
PUBLIC_API_ORIGIN=                           # CORS for /api/search etc.
SKIP_DOMAINS_EXTRA=                          # extra blacklist (csv)
UNRELIABLE_DOMAINS_EXTRA=
VIEWER_ONLY_DOMAINS_EXTRA=
MAINTENANCE_ANNOUNCE_CHAT_IDS=               # group IDs to announce service-back
MAINTENANCE_END_MESSAGE=                     # custom message override
CHROMIUM_PATH=                               # alternative to PLAYWRIGHT_CHROMIUM_PATH
```

> Full reference: see <code>.env.example</code> and <code>server/bot/config.ts</code>.

---

## 🤖 Bot commands

### User commands

| Command | Effect |
|---|---|
| `/start` | Welcome + your daily-usage stats |
| `/search [book]` | Direct search (also: just type the name) |
| `/random [genre]` | Random book; 15 supported genres |
| `/weekly` | Editor's pick of the week |
| `/stats` | Your usage today vs your daily limit |
| `/history` | Your last 7 books with re-download buttons |
| `/top` | Most-requested books bot-wide |
| `/last` | Re-deliver the most recent book you got |
| `/wishlist [book]` | Save / list / remove from wishlist |
| `/queue` | Inspect your pending requests |
| `/cancel` | Cancel all your pending requests |
| `/premium` | Subscription details + upgrade |
| `/help` | Full command reference |

### Admin commands (`ADMIN_IDS` only)

| Command | Effect |
|---|---|
| `/admin` | Open the admin panel inside Telegram |
| `/ban <id>` / `/unban <id>` | Block / unblock a user |
| `/premium_add <id>` / `/premium_remove <id>` | Manual premium grants |
| `/set_limit <id> <n>` / `/reset_limit <id>` | Custom daily limit |
| `/note <id> <text\|clear>` | Free-text note attached to a user |
| `/purge_cache <book>` | Force-refresh a cached book |

### Group activation

```
بوت اسم الكتاب         bot اسم الكتاب
كتاب اسم الكتاب         @<bot_username> اسم الكتاب
```

The bot only responds to triggered messages in groups — it never spams.

---

## 💳 Premium tier

| | 🆓 Free | ⭐ Premium |
|---|---|---|
| Downloads/day | 3 | 15 |
| Summaries/day | 3 | unlimited (subject to global cap) |
| Queue priority | normal | high |
| Price | free | 100 Telegram Stars / month |

Payment flow: `/premium` → `sendInvoice` (XTR currency) → `pre_checkout_query` (must reply within 10s) → `successful_payment` event → `renewPremium()`.

Renewals **extend** existing subscription — renewing 10 days before expiry adds 30 days on top, never replaces.

---

## 📊 Admin dashboard

Available at `http://your-host:5000/dashboard` (auth: `Authorization: Bearer $DASHBOARD_SECRET`).

```
📈 Daily / weekly funnel — search → results → validate → deliver
🏆 Top requested books
🔌 Per-source health (success rate, attempts, last-error timestamp)
   Toggle any of the 13 sources on/off
📋 Queue inspector — high / normal / DLQ with re-queue & purge
🧠 Live process metrics (memory, workers, uptime)
👥 User management — premium / banned / per-user note / custom limits
📢 Targeted broadcast — Markdown body, target = all | premium | active7
🔧 Maintenance toggle — auto-announces service-back to known groups
🔍 Telemetry traces — full per-request step timing
```

Built as a single static SPA + a fetch-driven JSON API. Mobile-responsive.

> ⚠️ The dashboard is **HTTP only** out of the box. For production, terminate TLS at a reverse proxy (Caddy, Nginx, Traefik) and bind the bot to `127.0.0.1` via `BOT_PORT_BIND`. See [Security](#-security).

---

## 🌐 REST API

The bot also exposes a small public + admin HTTP API.

### Public (no auth)

```http
GET /api/health                              → { ok, uptime, ts }
GET /api/search?q=الأمير الصغير              → search a book
GET /api/random?genre=novels                 → random book
GET /api/top-books?limit=10                  → top requested
GET /api/genres                              → list supported genres
```

Sample response:

```json
{
  "ok": true,
  "data": {
    "title": "ألف شمس مشرقة",
    "pdfUrl": "https://archive.org/...",
    "source": "Internet Archive",
    "cached": true
  }
}
```

### Admin (`Authorization: Bearer $DASHBOARD_SECRET`)

```http
GET    /api/admin/overview
GET    /api/admin/stats/daily | /weekly | /top-books | /sources
GET    /api/admin/queue
DELETE /api/admin/queue/dlq
POST   /api/admin/users/:id/premium    { "enable": true,  "days": 30 }
PUT    /api/admin/users/:id/limit      { "limit": 10 }
POST   /api/admin/users/:id/ban        { "reason": "spam" }
PUT    /api/admin/maintenance          { "active": true }
POST   /api/admin/broadcast            { "message": "...", "target": "premium" }
POST   /api/admin/sources/:domain/toggle { "action": "enable" }
GET    /api/admin/telemetry/traces
GET    /api/admin/telemetry/funnel
```

---

## 🔒 Security

| Mechanism | What it protects against |
|---|---|
| **Timing-safe auth** (`timingSafeEqual`) | Brute-force discovery of `DASHBOARD_SECRET` |
| **Lua atomic rate-limit** | Sliding-window race conditions on burst traffic |
| **Redis pipeline guards** | All checks (ban / maintenance / rate / daily) in one round-trip — no TOCTOU |
| **Per-IP rate-limit** | Backstop for unauthenticated public API |
| **Input sanitization** | Length cap, character whitelist, `escMd()` for Markdown payloads |
| **`validateNumericId`** | `/^\d{5,15}$/` + `Number.isSafeInteger` — rejects `@username` and bigint edge values |
| **Helmet + strict CORS** | Default secure HTTP headers, configurable allow-list |
| **PDF validator** | %PDF magic bytes + text density + page count + AI judge |
| **50 MB hard limit** | Telegram's upload ceiling — blocks oversized files early |
| **Auto-blacklist** | 3 user reports → URL is permanently blocked |
| **Graceful shutdown** | SIGTERM/SIGINT → workers drain → DB/Redis close cleanly. No request lost. |
| **fail2ban (ops)** | Banned IPs after repeated SSH failures |
| **Audit log** | Every `setPremium`, `ban`, `purge` writes to Postgres `audit_log` |

For production:
- Always front the dashboard with a TLS-terminating reverse proxy (Caddy is easiest — auto Let's Encrypt).
- Run on a private subnet + `BOT_PORT_BIND=127.0.0.1`.
- Rotate `BOT_TOKEN` periodically (`@BotFather` → `/revoke`).
- Use `pg_dump` backups (script provided — see [Backups](#-backups--disaster-recovery)).

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
│       ├── commands.ts               ← /start, /search, /admin, …
│       ├── callbacks.ts              ← inline-keyboard handlers
│       ├── messageHandler.ts         ← free-text + group triggers
│       ├── bookRequest.ts            ← guards + enqueue
│       ├── bookNameParser.ts         ← Arabic dialect / verb stripping
│       ├── engine.ts                 ← search orchestration
│       ├── fuzzy.ts                  ← typo-tolerant title matching
│       ├── sources.ts                ← 13 library configs
│       ├── pdfValidator.ts           ← multi-stage PDF judge
│       ├── download.ts               ← HTTP fetch + Telegram sendDocument
│       ├── noorBookResolver.ts       ← Playwright Cloudflare bypass
│       ├── queue.ts                  ← Redis high/normal/DLQ
│       ├── workers.ts                ← worker loop + retries
│       ├── userSettings.ts           ← premium / limits / notes
│       ├── analytics.ts              ← funnel & top-books
│       ├── telemetry.ts              ← per-request trace
│       ├── alertWatcher.ts           ← admin Telegram alerts
│       ├── rateLimit.ts              ← Lua sliding window
│       ├── ipRateLimit.ts            ← public-API per-IP guard
│       ├── summary.ts                ← AI summary generator
│       ├── summaryHandler.ts         ← summary command flow
│       ├── reactions.ts              ← bot emoji reactions
│       ├── config.ts                 ← all constants
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
│   ├── postgres-backup.sh            ← daily pg_dump with rotation
│   └── migrate-*.mjs                 ← one-off data migrations
│
├── docs/
│   ├── RUNBOOK.md                    ← production operations playbook
│   ├── PRODUCTION.md                 ← deploy notes
│   └── SERVER_SYNC_PLAN.md
│
├── test-*.mjs                        ← 11 smoke tests (CI runs them all)
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

For full DR, replicate the dumps off-site. Suggested follow-up:

```bash
aws s3 cp /var/backups/bookbot/ s3://your-bucket/bookbot/ --recursive
```

To restore:

```bash
gunzip -c /var/backups/bookbot/bookbot-2026-05-05.sql.gz \
  | docker exec -i book-bot-db-1 psql -U bookbot -d bookbot
```

---

## 🧪 Testing

Tests live as standalone `test-*.mjs` files at the repo root and are executed individually by CI. Each file is a deterministic probe: no network, no real Telegram. Many tests import the live `.ts` modules through `tsx` for accurate behaviour.

```bash
# run them all locally
for t in test-*.mjs; do echo "═══ $t ═══"; npx tsx "$t"; done

# typecheck
npx tsc --noEmit

# build
npm run build
```

Coverage of current tests:

| Test | What it pins down |
|---|---|
| `test-cache-key-normalization.mjs` | Arabic normalization → Redis key parity |
| `test-cache-poison-defense.mjs` | Refuse to cache opaque/numeric URLs from untrusted sources |
| `test-dedup-isPremium.mjs` | Per-request memoisation cuts Redis round-trips |
| `test-direct-send-safety.mjs` | Direct-mode never delivers a viewer-only / paid URL |
| `test-garbage-meta-and-noor-tag.mjs` | Reject "1 Image" titles + early-skip noor non-book pages |
| `test-paid-book-fallback.mjs` | Paid-book detection produces user-visible explanation |
| `test-parser-preserves-قراءة.mjs` | Don't strip "قراءة" / "اقرأ" when they are part of a title |
| `test-premium-expiration.mjs` | TTL-based expiry + lazy cleanup |
| `test-source-weighting.mjs` | Auto-disable thresholds (tier-1, tier-2, trust) |
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
- **Garbage-title detection** — early-rejects PDFs whose `/Title` metadata is "1 Image", "Untitled", "Microsoft Word - …", etc., before sending the AI a misleading prompt.
- **Bounded telemetry** — trace store self-trims to 200 entries.
- **noor-book early-skip** — non-book noor URLs (`/tag`, `/category`, `/user`, `/search`) get rejected without spinning Chromium for 30s.
- **3 workers** with bounded concurrency — predictable resource usage on a 2GB VM.

Order-of-magnitude prod numbers (tracked daily):
- p50 delivery time: ~5s (cache hit ~1s)
- p95 delivery time: ~12s
- AI calls per delivered book: ~0.3
- Firecrawl credits per delivered book: ~0.4 (cache absorbs the rest)

---

## 🤝 Contributing

Contributions are welcome. The full guide is in <code>CONTRIBUTING.md</code> — a short version:

1. Fork → branch (`feat/...` or `fix/...`).
2. Make sure `npx tsc --noEmit` and `npm run build` pass.
3. Add / update a `test-*.mjs` for any non-trivial behaviour change.
4. Open a PR against `main` with a clear description of the **problem**, the **fix**, and any **trade-offs**.
5. CI must be green; one approving review is required.

We follow Conventional Commits (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `chore:`).

Issues for newcomers are labelled `good first issue`. Before you start a large feature, please open an issue first to align on the design.

---

## 🗺️ Roadmap

Done:
- [x] Two-tier Redis queue + DLQ
- [x] Multi-stage PDF validator with Mistral AI fallback
- [x] Telegram Stars payments
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

Planned:
- [ ] Webhook mode (currently long-poll only)
- [ ] Wishlist hit-notification when a previously-unavailable book becomes available
- [ ] English-language book support
- [ ] Recurring premium subscriptions via Telegram (when API stabilises)
- [ ] CSV export of analytics from the dashboard
- [ ] S3 off-site backup wrapper
- [ ] OpenTelemetry exporter (Prometheus + Grafana ready)
- [ ] Vitest migration for the smoke tests

---

## ❓ FAQ

**Q: Do I need all the AI provider keys?**
No — `MISTRAL_API_KEY` and `GEMINI_API_KEY` are enough for full functionality. Adding more providers buys you redundancy when a free tier hits its rate limit.

**Q: What about copyright?**
The bot only **points to** PDFs that are already publicly indexable on third-party libraries. It does not host content. The 13 sources are all public Arabic libraries that publish books openly. Operators are responsible for legal compliance in their jurisdiction.

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

---

## 🙏 Acknowledgments

This project stands on the shoulders of:

- The 13 Arabic libraries that publish public-domain and open-access content for free — without them this bot would be useless.
- [Firecrawl](https://firecrawl.dev) for making multi-domain search affordable.
- [Mistral AI](https://mistral.ai) for an honest free tier that doesn't rate-limit hostile.
- [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) maintainers — by far the most stable JS Telegram lib.
- [Drizzle ORM](https://orm.drizzle.team) for typed migrations that don't drift.
- The [Devin](https://devin.ai) AI engineer that helped land 60+ PRs over the project's life.

---

## 📄 License

[MIT](LICENSE) © 2024-2026 Ahmed Allam ([@ahmedallam222](https://github.com/ahmedallam222)) and contributors.

You are free to fork, modify, self-host, and redistribute. Attribution appreciated but not required.

---

<div align="center">

**Built with ❤️ for Arabic readers**

[⬆ Back to top](#-kholasa-books-bot--خلاصة-الكتب)

</div>
