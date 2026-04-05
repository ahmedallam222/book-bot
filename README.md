<div align="center">

```
██╗  ██╗██╗  ██╗ ██████╗ ██╗      █████╗ ███████╗ █████╗
╚██╗██╔╝██║  ██║██╔═══██╗██║     ██╔══██╗██╔════╝██╔══██╗
 ╚███╔╝ ███████║██║   ██║██║     ███████║███████╗███████║
 ██╔██╗ ██╔══██║██║   ██║██║     ██╔══██║╚════██║██╔══██║
██╔╝ ██╗██║  ██║╚██████╔╝███████╗██║  ██║███████║██║  ██║
╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
```

### 📚 بوت تيليغرام — يبحث في 13 مكتبة عربية ويُرسل الكتاب مباشرةً كـ PDF

<br/>

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://docker.com)

<br/>

![Lines of Code](https://img.shields.io/badge/Lines_of_Code-9%2C600+-blueviolet?style=flat-square)
![Modules](https://img.shields.io/badge/Modules-36-blue?style=flat-square)
![Sources](https://img.shields.io/badge/Arabic_Sources-13-orange?style=flat-square)
![Version](https://img.shields.io/badge/Version-v30.0.0-success?style=flat-square)
![License](https://img.shields.io/badge/License-Proprietary-red?style=flat-square)

<br/>

> اكتب اسم أي كتاب عربي → البوت يبحث في 13 مكتبة → يتحقق من الـ PDF → يُرسله فوراً داخل تيليغرام

<br/>

[🚀 تشغيل سريع](#-تشغيل-سريع) · [📖 التوثيق الكامل](#-جدول-المحتويات) · [🐛 إبلاغ عن مشكلة](../../issues) · [💡 طلب ميزة](../../issues)

</div>

---

## 📋 جدول المحتويات

| | القسم |
|--|-------|
| 🔭 | [نظرة عامة](#-نظرة-عامة) |
| ✨ | [المميزات الكاملة](#-المميزات-الكاملة) |
| 🏗️ | [المعمارية التقنية](#-المعمارية-التقنية) |
| 🔄 | [تدفق معالجة الطلب](#-تدفق-معالجة-الطلب) |
| 📦 | [المتطلبات](#-المتطلبات) |
| ⚡ | [تشغيل سريع](#-تشغيل-سريع) |
| ⚙️ | [متغيرات البيئة](#-متغيرات-البيئة) |
| 🤖 | [أوامر البوت](#-أوامر-البوت) |
| 💳 | [نظام الدفع](#-نظام-الدفع-premium) |
| 📊 | [لوحة التحكم](#-لوحة-التحكم) |
| 🌐 | [REST API](#-rest-api) |
| 🔒 | [الأمان](#-الأمان) |
| 📁 | [هيكل المشروع](#-هيكل-المشروع) |
| 🖥️ | [النشر على السيرفر](#-النشر-على-السيرفر) |
| 📈 | [المراقبة والـ Telemetry](#-المراقبة-والـ-telemetry) |
| 🗺️ | [خارطة الطريق](#-خارطة-الطريق) |

---

## 🔭 نظرة عامة

**خلاصة الكتب** هو بوت تيليغرام مكتوب بالكامل بـ **TypeScript** فوق **Node.js 20**، يحل مشكلة واحدة بشكل احترافي:

> *"أريد كتاباً عربياً الآن — بدون بحث، بدون تسجيل، بدون انتظار."*

البوت يبحث في **13 مكتبة عربية** بالتوازي، يتحقق من صحة الـ PDF بنظام متعدد الطبقات يشمل **Mistral AI**، ثم يُرسل الكتاب مباشرةً كـ document داخل تيليغرام.

### الأرقام

| المقياس | القيمة |
|---------|--------|
| أسطر الكود | **9,600+** |
| موديولات TypeScript | **36 ملف** |
| مصادر البحث | **13 مكتبة عربية** |
| حد الـ PDF | **50 MB** |
| Workers المتوازية | **3 (قابلة للضبط)** |
| Rate limit | **10 طلب / دقيقة** |
| Job timeout | **2 دقيقة** |
| Cache TTL | **1 ساعة (hit) / 5 دقائق (miss)** |

---

## ✨ المميزات الكاملة

### للمستخدم

| المجال | التفاصيل |
|--------|----------|
| 🔍 **بحث ذكي** | 13 مكتبة بالتوازي، Fuzzy matching، يفهم اللهجات (خليجي / مصري / شامي) |
| ⚡ **أداء عالٍ** | Redis cache للكتب الشائعة، طابور ثنائي، 3 workers متوازية |
| 🎲 **اكتشاف** | `/random` بـ 15 نوع أدبي، `/weekly` منتقى أسبوعياً، `/top` الأكثر طلباً |
| 🔖 **تنظيم شخصي** | `/wishlist` للحفظ، `/history` آخر 7 كتب، `/last` إعادة تحميل فوري |
| 💳 **اشتراك** | Telegram Stars — بدون بيانات بنكية — تجديد يمدّد لا يستبدل |
| 🛡️ **حماية** | Rate limiting ذكي، رسائل واضحة، زر "إبلاغ عن ملف تالف" |

### للمشرف

| المجال | التفاصيل |
|--------|----------|
| 📊 **Dashboard** | إحصاءات حية، Funnel analytics، Telemetry traces لكل طلب |
| 👥 **إدارة** | حظر/رفع حظر، Premium يدوي، حدود مخصصة، ملاحظات على الحسابات |
| 🔌 **مصادر** | تفعيل/إيقاف أي مكتبة من الـ dashboard، blacklist تلقائية |
| 📢 **تواصل** | Broadcast لجميع المستخدمين، وضع الصيانة بزر واحد |

---

## 🏗️ المعمارية التقنية

```
╔══════════════════════════════════════════════════════════════╗
║                    TELEGRAM SERVERS                          ║
╚══════════════════════╦═══════════════════════════════════════╝
                       ║  Long Polling (500ms)
╔══════════════════════▼═══════════════════════════════════════╗
║              GATEWAY LAYER                                   ║
║  commands.ts │ callbacks.ts │ messageHandler                 ║
╚══════════════════════╦═══════════════════════════════════════╝
                       ║
╔══════════════════════▼═══════════════════════════════════════╗
║         GUARD LAYER — bookRequest.ts                         ║
║   Redis Pipeline: ban? maintenance? rateLimit? dailyLimit?   ║
╚══════════════════════╦═══════════════════════════════════════╝
                       ║
╔══════════════════════▼═══════════════════════════════════════╗
║              QUEUE (Redis Lists)                             ║
║  queue:high ──┐                                              ║
║               ├──→ Worker 1 ─┐                               ║
║  queue:normal─┘   Worker 2  ├──→ processBookRequest()       ║
║                   Worker 3 ─┘   (2 min timeout)             ║
║  queue:dlq  (retry x3 → Dead Letter Queue)                   ║
╚══════════════════════╦═══════════════════════════════════════╝
                       ║
          ┌────────────┴────────────┐
          ▼                         ▼
╔═════════════════╗       ╔═════════════════════════════════╗
║  SEARCH ENGINE  ║       ║     VALIDATION + DELIVERY       ║
║  Redis cache?   ║       ║  verify → pdfValidator          ║
║  Firecrawl API  ║       ║  Mistral AI fallback            ║
║  13 sources     ║       ║  download → sendDocument        ║
║  Fuzzy fallback ║       ║  cache fileId → PostgreSQL      ║
╚═════════════════╝       ╚═════════════════════════════════╝
```

### Stack التقني

| الطبقة | التقنية |
|--------|---------|
| Runtime | Node.js 20 + TypeScript 5.4 |
| Bot | node-telegram-bot-api 0.66 |
| HTTP | Express 4 |
| Queue & Cache | Redis 7 + Lua Scripts |
| Database | PostgreSQL 16 + Drizzle ORM |
| Search | Firecrawl API |
| AI | Mistral AI (PDF validation) |
| Build | esbuild → CJS bundle |
| Deploy | Docker + Compose |

---

## 🔄 تدفق معالجة الطلب

```
"ابغى روايه اماريتا"
        │
        ▼ bookNameParser.ts
   "أماريتا"  ← يحذف triggers اللهجية
        │
        ▼ Guards (Redis Pipeline — استعلام واحد)
   ban? maintenance? rateLimit? dailyLimit?
        │ PASS
        ▼ enqueue()
   priority = normal / high (premium/admin)
   USER: "⏳ طلبك في الطابور (موقع X)"
        │
        ▼ Worker picks up job
   searchWithFuzzyFallback()
   → Redis cache HIT?  ──→ return instantly ✅
   → Firecrawl (13 sources parallel)
   → Fuzzy match fallback
   → Cache results (1hr TTL)
        │
        ▼ findValidPdfUrls()
   filter blacklist → filter viewer-only
   HEAD check (8s timeout each)
        │
        ▼ downloadAndSend()
   %PDF header → text density → page count
   → Mistral AI fallback (if uncertain)
   → sendDocument to Telegram
        │
        ▼
   ✅ الكتاب وصل + cache fileId + trackDownload()
```

---

## 📦 المتطلبات

| الأداة | الإصدار |
|--------|---------|
| Node.js | 20+ |
| PostgreSQL | 16+ |
| Redis | 7+ |
| Docker | أي إصدار حديث |

| المفتاح | إلزامي؟ | الرابط |
|---------|---------|--------|
| `BOT_TOKEN` | ✅ | [@BotFather](https://t.me/BotFather) |
| `FIRECRAWL_API_KEY` | ✅ | [firecrawl.dev](https://firecrawl.dev) |
| `MISTRAL_API_KEY` | ⭕ اختياري | [mistral.ai](https://mistral.ai) |

---

## ⚡ تشغيل سريع

### Docker

```bash
git clone https://github.com/your-username/kholasa-books-bot.git
cd kholasa-books-bot

cp .env.example .env
nano .env   # BOT_TOKEN + FIRECRAWL_API_KEY على الأقل

docker-compose up -d --build
docker logs book-bot-bot-1 -f
```

**اللوج المتوقع:**
```
[INFO] [bot] Starting Kholasa Books bot...
[Redis] connected
[INFO] [bot] Bot started: @your_bot (123456789)
[INFO] [bot] 3 workers started
```

### Node.js (تطوير)

```bash
npm install
npm run db:push    # إنشاء الجداول
npm run dev        # tsx watch mode
```

---

## ⚙️ متغيرات البيئة

```env
# ── إلزامي ─────────────────────────────────────────
BOT_TOKEN=
DATABASE_URL=postgresql://bookbot:pass@localhost:5432/bookbot
REDIS_URL=redis://localhost:6379
FIRECRAWL_API_KEY=

# ── موصى به ────────────────────────────────────────
MISTRAL_API_KEY=
ADMIN_IDS=123456789,987654321
DASHBOARD_SECRET=strong-random-secret
DASHBOARD_ORIGIN=https://your-domain.com

# ── ضبط متقدم ──────────────────────────────────────
WORKER_COUNT=3
TEMP_DIR=/tmp/kholasa_books
NODE_ENV=production
UNRELIABLE_DOMAINS_EXTRA=site1.com,site2.com
VIEWER_ONLY_DOMAINS_EXTRA=viewer.com
```

---

## 🤖 أوامر البوت

### المستخدم

| الأمر | الوظيفة |
|-------|---------|
| `/start` | الترحيب + إحصائياتك |
| `/search [كتاب]` | بحث مباشر |
| `/random [نوع]` | كتاب عشوائي |
| `/weekly` | الكتاب الأسبوعي |
| `/stats` | شريط الاستهلاك اليومي |
| `/history` | آخر 7 كتب حمّلتها |
| `/top` | أكثر الكتب طلباً |
| `/last` | إعادة تحميل آخر كتاب |
| `/wishlist` | عرض / إضافة أمنيات |
| `/queue` | حالة طلباتك |
| `/cancel` | إلغاء الطلبات المعلقة |
| `/premium` | تفاصيل الاشتراك |
| `/help` | دليل الاستخدام |

### المشرف

| الأمر | الوظيفة |
|-------|---------|
| `/admin` | لوحة التحكم |
| `/ban [id]` / `/unban [id]` | حظر / رفع |
| `/premium_add [id]` / `/premium_remove [id]` | إدارة Premium |
| `/set_limit [id] [n]` / `/reset_limit [id]` | حدود التحميل |
| `/note [id] [نص\|clear]` | ملاحظة على مستخدم |

### في المجموعات

```
بوت اسم الكتاب      │  bot اسم الكتاب
كتاب اسم الكتاب     │  @اسم_البوت اسم الكتاب
```

---

## 💳 نظام الدفع (Premium)

| | 🆓 مجاني | ⭐ Premium |
|--|---------|----------|
| تحميلات/يوم | 3 | 15 |
| أولوية الطابور | عادية | عالية |
| السعر | مجاني | 100 Stars / شهر |

**تدفق الدفع:**
```
/premium → sendInvoice (XTR) → pre_checkout_query (< 10s) → successful_payment → renewPremium() ✅
```

التجديد **يمدّد** الصلاحية القائمة بدل استبدالها — تجديد قبل الانتهاء بـ 10 أيام = +30 يوم على الرصيد.

---

## 📊 لوحة التحكم

`http://your-server:5000/dashboard` — تتطلب: `Authorization: Bearer SECRET`

```
📈 إحصاءات يومية / أسبوعية (بحث → نجاح → إرسال)
🏆 أكثر الكتب طلباً
🔌 حالة كل مصدر + تفعيل/إيقاف
📋 الطابور: High / Normal / DLQ
🧠 الذاكرة + Workers + Uptime
👥 إدارة: Premium / محظورين / حدود
📢 Broadcast بـ Markdown
🔧 وضع الصيانة ON/OFF
🔍 Telemetry traces لكل طلب
```

---

## 🌐 REST API

### Public (بدون auth)

```http
GET /api/search?q=اسم الكتاب
GET /api/random?genre=novels
GET /api/top-books?limit=10
GET /api/genres
GET /api/health
```

**مثال استجابة:**
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

### Admin (يتطلب `Authorization: Bearer SECRET`)

```http
GET    /api/admin/overview
GET    /api/admin/stats/daily|weekly|top-books|sources
GET    /api/admin/queue
DELETE /api/admin/queue/dlq
POST   /api/admin/users/:id/premium    { "enable": true }
PUT    /api/admin/users/:id/limit      { "limit": 10 }
POST   /api/admin/users/:id/ban
PUT    /api/admin/maintenance          { "active": true }
POST   /api/admin/broadcast            { "message": "..." }
POST   /api/admin/sources/:domain/toggle { "action": "enable" }
GET    /api/admin/telemetry/traces
GET    /api/admin/telemetry/funnel
```

---

## 🔒 الأمان

| الآلية | التفاصيل |
|--------|----------|
| **Timing-safe auth** | `timingSafeEqual()` — يمنع timing attacks |
| **Lua atomic rate limit** | Sliding window بدون race conditions |
| **Redis Pipeline guards** | كل الفحوصات في pipeline واحدة |
| **Input sanitization** | كل مدخلات المستخدم تُنظَّف |
| **ID validation** | `/\d{5,15}/` فقط |
| **Blacklist تلقائية** | 3 إبلاغات = حجب نهائي للرابط |
| **Viewer-only filter** | Scribd/Issuu تُحذف فوراً |
| **PDF validator** | متعدد الطبقات + Mistral AI |
| **50MB hard limit** | حد صارم على حجم الـ PDF |
| **Graceful shutdown** | SIGTERM/SIGINT — لا فقدان للطلبات |

---

## 📁 هيكل المشروع

```
kholasa-books-bot/
├── server/
│   ├── index.ts              ← نقطة البداية + Workers + Shutdown
│   ├── routes.ts             ← Admin API + Public API
│   ├── storage.ts            ← PostgreSQL / Drizzle ORM
│   ├── dashboard.html        ← لوحة التحكم (SPA)
│   └── bot/
│       ├── commands.ts       commands handler
│       ├── callbacks.ts      inline keyboards handler
│       ├── bookRequest.ts    entry point لكل طلب
│       ├── engine.ts         محرك البحث
│       ├── fuzzy.ts          مطابقة تقريبية
│       ├── sources.ts        13 مكتبة عربية
│       ├── pdfValidator.ts   تحقق PDF + Mistral AI
│       ├── download.ts       تحميل وإرسال
│       ├── queue.ts          طابور Redis
│       ├── userSettings.ts   Premium + حدود
│       ├── analytics.ts      إحصاءات
│       ├── telemetry.ts      traces لكل طلب
│       ├── rateLimit.ts      Lua sliding window
│       ├── config.ts         كل الثوابت
│       └── ...               (36 ملف إجمالاً)
├── shared/schema.ts          Drizzle schema
├── script/build.ts           esbuild bundler
├── docker-compose.yml
├── Dockerfile
├── deploy.sh
├── .env.example
├── CHANGELOG.md
├── CONTRIBUTING.md
└── LICENSE
```

---

## 🖥️ النشر على السيرفر

### متطلبات السيرفر

| المورد | الحد الأدنى | الموصى به |
|--------|------------|-----------|
| RAM | 1 GB | 2 GB |
| CPU | 1 vCPU | 2 vCPU |
| OS | Ubuntu 22.04 | Ubuntu 22.04 |

### أوامر مفيدة

```bash
# مراقبة
docker logs book-bot-bot-1 -f

# إعادة تشغيل بدون rebuild
docker-compose restart bot

# تحديث كامل
bash deploy.sh

# دخول container
docker exec -it book-bot-bot-1 sh
```

### بـ pm2

```bash
npm run build
pm2 start dist/index.cjs --name kholasa --max-memory-restart 512M
pm2 save && pm2 startup
```

---

## 📈 المراقبة والـ Telemetry

كل طلب يُنشئ trace كامل:

```json
{
  "traceId": "abc123",
  "bookName": "الأمير الصغير",
  "steps": [
    { "event": "enqueued",   "ms": 0    },
    { "event": "cache_hit",  "ms": 145  },
    { "event": "sent",       "ms": 4800 }
  ],
  "totalMs": 4800,
  "source": "archive.org",
  "fromCache": true
}
```

**Funnel:**
```
100% بحث → 85% نتائج → 72% تحقق → 68% تحميل → 65% وصل ✅
```

---

## 🗺️ خارطة الطريق

- [x] طابور Redis ثنائي + DLQ
- [x] PDF Validator + Mistral AI
- [x] Telegram Stars للدفع
- [x] Dashboard ويب
- [x] Telemetry traces
- [x] دعم اللهجات العربية
- [ ] إشعار تلقائي عند توفر كتاب من الـ Wishlist
- [ ] دعم الكتب الإنجليزية
- [ ] تجديد Premium تلقائي عبر Telegram Subscriptions
- [ ] تصدير إحصاءات CSV من الـ Dashboard

---

<div align="center">

صُنع بـ ❤️ لمحبي الكتب العربية

**[⬆ العودة للأعلى](#)**

</div>
