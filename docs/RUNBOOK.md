# RUNBOOK — خلاصة الكتب (Production Operations)

كل النقاط أدناه مكتوبة من تجربة فعلية على production. الهدف:
**أقل عدد خطوات للوصول للحل في حادثة شائعة**.

> **سيرفر الإنتاج:** `ubuntu@<production-host>` — مسار المشروع `/home/ubuntu/book-bot/`.
> Stack: docker compose (`bot`, `db`, `redis`).

---

## فهرس سريع

| العَرَض | الصفحة |
|---|---|
| البوت لا يستجيب على Telegram | [§1](#1-البوت-لا-يستجيب) |
| نسبة النجاح اليومية انخفضت فجأة | [§2](#2-نسبة-النجاح-انخفضت) |
| مستخدم بيشتكي إن البوت بعتله الكتاب الغلط | [§3](#3-كتاب-غلط-تم-إرساله) |
| المصدر X لازم يتعطّل / يتفعّل | [§4](#4-تعطيلتفعيل-مصدر) |
| Premium مفعّل / متعطّل بالغلط على مستخدم | [§5](#5-مشاكل-premium) |
| `daily_limits` table بتكبر بسرعة | [§6](#6-daily_limits-بتكبر) |
| Dashboard مش بيلوجن | [§7](#7-dashboard-مش-بيلوجن) |
| كل البوت بطّأ — latency عالية | [§8](#8-latency-عالية) |
| إعادة نشر بعد PR merge | [§9](#9-redeploy-بعد-merge) |
| نسخ احتياطي / استعادة | [§10](#10-نسخ-احتياطي-استعادة) |

---

## 1. البوت لا يستجيب

```bash
ssh ubuntu@<production-host>
cd /home/ubuntu/book-bot
docker compose ps
```

- لو الـ container في `Restarting` / `Exited`:
  ```bash
  docker compose logs --tail=200 bot
  ```
  دوّر على:
  - `[FATAL] Missing required env vars` → ناقص `BOT_TOKEN` أو `DATABASE_URL` أو `REDIS_URL` في `.env`
  - `POSTGRES_PASSWORD must be set` → ضيف `POSTGRES_PASSWORD=...` في `.env`
  - `EADDRINUSE` → port 5000 مشغول. شيكِ `lsof -i:5000` على الـ host.
- لو كل الـ containers `healthy` لكن مفيش رد:
  - تأكد من `BOT_TOKEN` صح: `docker compose exec bot wget -qO- "https://api.telegram.org/bot$BOT_TOKEN/getMe"`
  - شيكِ rate-limit من Telegram: `docker compose logs bot | grep -i "429\|rate"` 
  - شيكِ webhook متعمل بالغلط: `wget -qO- "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"` — لو فيه URL إحذفه:
    ```bash
    wget -qO- "https://api.telegram.org/bot$BOT_TOKEN/deleteWebhook"
    ```
  - أعد التشغيل: `docker compose restart bot`

---

## 2. نسبة النجاح انخفضت

نسبة النجاح اليومية = `found_pdfs / total_requests` لليوم الجاري.

```bash
# نسبة اليوم
docker compose exec -T redis redis-cli HGETALL stats:daily:$(date +%Y-%m-%d)

# stats كل مصدر — اللي بتعمل failures كتيرة
for k in $(docker compose exec -T redis redis-cli --raw KEYS "stats:source:*"); do
  echo "=== $k ==="
  docker compose exec -T redis redis-cli HGETALL "$k"
done
```

**إيه اللي تدوّر عليه:**

- **`mistral_rejected` عالي** → الـ ranker بيختار wrong-book PDFs من المصدر ده. هو فعلاً بيرجع PDFs لكن الكتب الغلط. مثال شائع: `downloads.hindawi.org` (opaque numeric URLs).
  - **الحل:** عطّله يدوياً — انظر [§4](#4-تعطيلتفعيل-مصدر).
- **`fail` عالي + `ok` صفر** → المصدر بيرجع HTML/3xx بدل PDF (تغيرت بنية الموقع).
  - **الحل:** عطّله ولاحظ `tier-2 auto-disable` لو فعّال — هيخلَّيه off لو 5+ محاولات بصفر نجاح.
- **`ok` و `fail` متقاربين، نسبة نجاح ~50%** → عادي للمصادر الواسعة. سيب.

**جذر المشكلة الفعلي على الإنتاج (مايو 2026):**
- `downloads.hindawi.org`: 27% نسبة ثقة — معطّل يدوياً.
- `arabic-book.net`: يرجع HTML — معطّل يدوياً.

---

## 3. كتاب غلط تم إرساله

**في Telegram:** اطلب من المستخدم الـ Telegram message ID (يـforward لك الرسالة) ولاحظ:
- اسم الـ PDF + caption — هل العنوان الـ Mistral رضي عنه فعلاً مختلف؟
- اضغط على زر `🚫 ملف غلط` لو الزر ظاهر — يفعّل blacklist تلقائي لـ 14 يوم.

**في dashboard:**
1. روح `https://your-host/dashboard` → 📊 Telemetry → Recent Traces.
2. ابحث عن trace بتاعها (آخر دقيقة قبل الإرسال). افتح الـ trace.
3. شوف:
   - `phases.pdf_validation` → `event:` و `score:` و `mistralUsed:`. لو `score >= 0.55` (ACCEPT_THRESHOLD) → الـ heuristic accepted بدون Mistral. شيكِ هل الـ confirm-band شغال (config: `PDF_VALIDATE_CONFIRM_THRESHOLD`).
   - `phases.search` → URL اللي اختاره الـ ranker. هل الـ filename فيه إشارة للكتاب أم opaque (`1234.pdf`)؟
4. لو URL من مصدر معروف بـ false-positives → عطّل المصدر [§4](#4-تعطيلتفعيل-مصدر).

**زر "🚫 ملف غلط" في الـ Telegram** يضيف الـ URL لـ `bl:url:{sha256}` بـ TTL 14 يوم — هيتجنّبه تلقائياً للجميع.

---

## 4. تعطيل/تفعيل مصدر

### من Telegram (موصى به)

```
/admin → 📡 المصادر
```

كل مصدر له زر `🚫 تعطيل` أو `✅ تفعيل`. النقرة وحدها كافية. التغيير live.

### من السيرفر (لو الـ Telegram غير متاح)

```bash
DOMAIN="downloads.hindawi.org"        # مثال
# (تطبيع مثل sanitizeDomainKey: lowercase + إزالة www. + إزالة non-alnum إلا . و -)

# تعطيل
docker compose exec -T redis redis-cli SET "src:off:$DOMAIN" 1

# تفعيل
docker compose exec -T redis redis-cli DEL "src:off:$DOMAIN"

# عرض المعطّلين
docker compose exec -T redis redis-cli --raw KEYS "src:off:*"
```

⚠️ **مهم:** بعد ما تعطّل، يفضل تمسح search cache عشان النتائج المخزّنة (اللي فيها روابط من المصدر المعطّل) ما ترجعش:

```bash
docker compose exec -T redis sh -c '
  for k in $(redis-cli --raw KEYS "search:result:*"); do
    redis-cli DEL "$k"
  done
'
```

(PR-A — #50 — أضافت filter عند القراءة من الكاش، فالـ cache flush ده مش لازم بعد ذلك. لكن بيقطع الذيل بشكل نهائي).

---

## 5. مشاكل Premium

### عرض حالة مستخدم
```bash
UID="123456789"
docker compose exec -T redis redis-cli SISMEMBER premium:set "$UID"           # 1 = في الـ set
docker compose exec -T redis redis-cli TTL "premium:exp:$UID"                  # ثوان متبقية، -2 = مفيش
docker compose exec -T redis redis-cli GET "premium:manual:$UID"               # ms epoch لو منحة admin
docker compose exec -T redis redis-cli LRANGE "premium:audit:$UID" 0 9         # آخر 10 حركات
```

### منح/إلغاء يدوي

**Telegram:** `/premium_add 123456789` أو `/premium_remove 123456789` (لازم تكون في `ADMIN_IDS`).

**Dashboard:** افتح ملف المستخدم → زر "منح Premium" / "إلغاء Premium".

### Audit log
كل grant/revoke يتسجّل في `premium:audit:{uid}` مع `by` (ADMIN_ID) و `source` (telegram-cmd/callback/dashboard/stars-payment) و `reason` اختياري.

```bash
# آخر 20 حركة لمستخدم
docker compose exec -T redis redis-cli LRANGE "premium:audit:$UID" 0 19 | jq -R 'fromjson?'
```

### المستخدم ليه بيقول إنه paid لكن مش premium؟
```bash
# شوف لو في ID مختلف بيشتري Telegram من ID مختلف بيحاول يستخدم
docker compose logs bot | grep -i "successful_payment" | tail -20
```
لو الفرق في الـ IDs قول له يستعمل نفس الـ Telegram account.

---

## 6. daily_limits بتكبر

PR-B (#51) أضاف cleanup cron تلقائي يحذف rows أقدم من 7 أيام كل 24 ساعة.

### تنظيف يدوي فوري
```bash
docker compose exec -T db psql -U bookbot -d bookbot -c \
  "DELETE FROM daily_limits WHERE date < CURRENT_DATE - INTERVAL '7 days';"
```

### تأكد إن الـ cron شغّال
```bash
docker compose logs --since=24h bot | grep "Deleted .* old daily_limits"
```

---

## 7. Dashboard مش بيلوجن

- صفحة الـ login بترجع 503 → `DASHBOARD_SECRET` غير مضبوط في `.env`. ضيفها وأعد التشغيل.
- الـ login بيرجع 401 رغم إن الـ secret صح →
  - شيكِ إن الـ secret بنفس الترميز (لا spaces زائدة، lowercase/uppercase صح).
  - شيكِ Rate limit (PR-C #52): max 60 طلب/دقيقة لكل IP.
  - شيكِ `helmet` headers لو الـ browser بيمنع لـ HSTS:
    ```
    curl -I http://127.0.0.1:5000/dashboard | head -20
    ```

### تغيير الـ secret
```bash
NEW=$(openssl rand -hex 32)
sed -i "s/^DASHBOARD_SECRET=.*/DASHBOARD_SECRET=$NEW/" .env
docker compose up -d   # لا rebuild — env_file بيتقرى عند الـ start
echo "New secret: $NEW"
```

---

## 8. Latency عالية

PR-E أضاف latency histograms. اقرأها:

```bash
SECRET=$(grep '^DASHBOARD_SECRET=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $SECRET" \
  http://127.0.0.1:5000/api/admin/telemetry/latency-hist | jq '.data | .[] | {phase, count, avgMs, p95Ms}'
```

اقرأ الـ output بترتيب:
- `__total__` → end-to-end. لو p95 > 30s ده انحراف.
- `search_done` → زمن الـ Firecrawl search. لو p95 > 5s → Firecrawl بطيء.
- `verify_done` → زمن التحقق من PDF (download + Mistral). لو p95 > 10s → الـ PDFs بتاعتك ضخمة أو Mistral بطيء.
- `download_done` → زمن الـ upload لـ Telegram. لو p95 > 20s → connectivity سيئة لـ Telegram.

### اختناقات شائعة
- `search_done` p95 ارتفع → Firecrawl rate-limited / down. شيكِ:
  ```bash
  docker compose logs bot | grep -iE "firecrawl|rate.limit" | tail -20
  ```
- `verify_done` p95 ارتفع → Mistral API بطيئة. تأكد:
  ```bash
  docker compose logs bot | grep -i "mistral" | tail -30
  ```
- `download_done` p95 ارتفع → الـ upload لـ Telegram بطيء، أو الـ network في الـ container ضعيف.

---

## 9. Redeploy بعد merge

```bash
ssh ubuntu@<production-host> "cd /home/ubuntu/book-bot && git pull origin main && docker compose up -d --build"
```

- الـ build ياخد 1-3 دقائق.
- downtime ~30 ثانية فقط (للـ container recreate).
- بعد ما يخلص:
  ```bash
  docker compose ps
  docker compose logs --tail=80 bot
  ```
  - `book-bot-bot-1` لازم يكون `Up (healthy)` — لو `(starting)` استنّى 60 ثانية ثم اعيد الفحص.
  - مفيش `[FATAL]` في الـ logs.

### Rollback سريع
```bash
git log --oneline -10                    # شوف أحدث merge
git revert HEAD --no-edit                # commit reverse للـ merge
git push origin main
docker compose up -d --build             # نشر التراجع
```

---

## 10. نسخ احتياطي / استعادة

### Backup يدوي
```bash
# DB dump
docker compose exec -T db pg_dump -U bookbot bookbot \
  | gzip > "/home/ubuntu/backups/bookbot-$(date +%Y%m%d-%H%M).sql.gz"

# Redis snapshot (RDB يحدث تلقائياً، نعمل نسخة)
docker compose exec -T redis redis-cli BGSAVE
sleep 5
docker cp $(docker compose ps -q redis):/data/dump.rdb \
  "/home/ubuntu/backups/redis-$(date +%Y%m%d-%H%M).rdb"
```

### استعادة DB
```bash
gunzip < bookbot-20260504-1400.sql.gz | docker compose exec -T db psql -U bookbot -d bookbot
```

### استعادة Redis
```bash
docker compose stop redis
docker cp redis-20260504-1400.rdb $(docker compose ps -q redis):/data/dump.rdb
docker compose start redis
```

---

## ملاحظات

- **سجل دائماً السبب في audit log** عند منح Premium يدوياً (الـ dashboard بياخد reason field).
- **بعد أي تعطيل/تفعيل مصدر** اقرأ الـ stats بعد ساعة على الأقل عشان تشوف فعالية القرار.
- **أي حادثة P0** → افتح PR لإضافة الـ playbook هنا قبل ما تنسى التفاصيل.
