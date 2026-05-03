# سجل التغييرات — Changelog

كل التغييرات الجوهرية لهذا المشروع موثقة هنا.

الصيغة مبنية على [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)،
ويتبع المشروع [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [30.0.1] — 2026-05-03

### 🐛 إصلاحات
- **`bookNameParser.ts` — أنماط الـ noise العربية لم تكن تعمل**: استخدمت `\b` وهي ASCII-only في JS regex فلا تطابق حدود الكلمات العربية. النتيجة: كل أنماط مثل `\bتحميل\b` و`\bمجاني\b` لم تُحذف فعلياً (والـ pattern الأول كان فيه أيضاً typo `tحميل` بحرف `t` لاتيني). البديل: مساعد `arabicNoise(word)` يبني `(^|\\s)word(\\s|$)` يطابق العربية بشكل صحيح.
- **اسم الكتاب يحتوي كلمات نيّة التلخيص**: مستخدم يكتب "لخصلي كتاب حوار مع صديقي الملحد" → البوت يحتفظ بـ "لخصلي" داخل اسم الكتاب فيظهر في الـ progress message وفي caption الملف وفي filename الـ PDF (`لخصلي_كتاب_حوار_مع_صديقي_الملحد.pdf`). أُضيفت كلمات نيّة التلخيص (`لخصلي / لخّصلي / لخص لي / لخّص لي / لخص / لخّص / تلخيص / ملخص / ملخّص / مُلخّص / اختصرلي / اختصر لي / اختصر`) إلى `NOISE_PATTERNS` و`LEADING_NOISE` في `bookNameParser.ts` وإلى `fillerWords` في `cleanSearchQuery` بـ `text.ts`. ميزة التلخيص تظل مرتبطة بزر `📘 ملخص الكتاب` بعد التحميل — لا تغيير في السلوك العام.
- **`LEADING_NOISE` تعمل في loop**: لاستيعاب prefix مزدوج مثل "لخصلي كتاب X" → يُزيل الاثنين على التوالي بدل تمريرة واحدة.

---

## [30.0.0] — 2026-04-05

### 🐛 إصلاحات حرجية
- **`server/index.ts`** لم تكن تستدعي `startBot()` — البوت لا يبدأ أبداً
- **`premium_buy` callback** يستدعي `answerCallbackQuery` مرتين — Toast لا يظهر للمستخدم
- **`my_queue` callback** كان يعرض إحصاءات الطابور الكلية بدل طلبات المستخدم تحديداً

### ✨ إضافات
- Job timeout (2 دقيقة) لمنع الـ workers من التجمد عند رابط معطل
- رسالة إخفاق للمستخدم عند وصول Job للـ DLQ بعد 3 محاولات
- `getUserPendingCount()` — عداد طلبات المستخدم بشكل مستقل
- `Promise.race()` في `processJobSafe` مع `TIMEOUT_JOB`
- Graceful shutdown handlers (SIGTERM/SIGINT/uncaughtException)

### 🔧 تحسينات
- `TIMEOUT_JOB` منقول لـ `config.ts` بدل hardcode
- Worker crash يُعيد تشغيل نفسه تلقائياً بعد 5 ثوانٍ
- `sentToRetry` flag للتمييز بين retry و DLQ عند الإخفاق

---

## [29.0.0] — 2026-03-20

### 🐛 إصلاحات
- `/start` لم يكن يتحقق من وضع الصيانة
- Race condition في `incrementDailyDownload` — استبدل بـ `INSERT ... ON CONFLICT DO UPDATE`
- `dailyLimit=0` كان يُحجب المستخدم فوراً بدل اعتباره unlimited
- `getSourceStats()` كانت تقبل date param لا تستخدمه
- ID validation كانت `{5,12}` — لا تدعم معرّفات Telegram الجديدة (13-15 رقم)

### ✨ إضافات
- `recoverStuckJobs()` — استرجاع Jobs العالقة بعد restart
- `getUserPendingCount()` لـ `my_queue` callback
- موقع الطابور الحقيقي يشمل الطابورَين (High + Normal)
- `Accept-Language: ar` في HEAD requests
- `QUEUE_ACTIVE_KEY` في config.ts

### 🔧 تحسينات
- Redis pipeline في `handleBookRequest` — استعلام واحد بدل 7 متسلسلة
- `BANNED_USERS` Set مُهيَّأة مرة واحدة من config بدل parsing لكل طلب
- `isNaN` guard على `parseInt(limitVal)` — يمنع NaN كـ unlimited

---

## [28.0.0] — 2026-03-01

### ✨ إضافات
- نظام Telemetry traces — تتبع كل طلب من A إلى Z
- Funnel analytics — معدلات تحويل في كل مرحلة
- PDF Validation stats endpoint
- لوحة التحكم: قسم Telemetry + Funnel

### 🐛 إصلاحات
- Wishlist callbacks كانت تستدعي `answerCallbackQuery` بعد general answer
- `wishlist_del` كان يحذف بالـ index بدون التحقق من الحدود
- `token` كان يُمرَّر لـ `buildWishlistKb` دون استخدام

---

## [27.0.0] — 2026-02-15

### ✨ إضافات
- نظام Premium بـ Telegram Stars
- `pre_checkout_query` handler
- `successful_payment` handler
- `/premium` command مع عرض التفاصيل

### 🔧 تحسينات
- PREMIUM_LIMIT غُيّر من 30 → 15 ليتطابق مع رسالة `/premium`
- DAILY_LIMIT غُيّر من 5 → 3

---

## [26.0.0] — 2026-02-01

### ✨ إضافات
- Wishlist module مستقل بدل `global.__kholasaWishlist`
- `/wishlist أضف` command
- `wishlist_add:` / `wishlist_del:` / `wishlist_clear` callbacks
- WISHLIST_MAX حد أقصى 20 كتاب

### 🐛 إصلاحات
- Circular imports في wishlist
- Dynamic imports زائدة في callbacks

---

## [25.0.0] — 2026-01-20

### ✨ إضافات
- Dashboard ويب كامل (HTML + API)
- `DASHBOARD_SECRET` منفصل عن Admin IDs
- `timingSafeEqual()` للمصادقة
- Broadcast من الـ dashboard
- Source toggle من الـ dashboard

### 🔧 تحسينات
- `wrap()` helper لمعالجة errors في routes
- `validateNumericId()` لكل `/api/admin/users/:id`

---

## [v22.0.0 - v24.0.0] — 2025-12-xx

### إصلاحات جماعية (Production Audit)
- 11 bug في 34 ملف TypeScript
- Arabic dialect coverage (Gulf: ابغى، ودي، بدي)
- TTL calculation guards
- Deduplication callback handling
- `uncaughtException` handler لـ pm2/systemd
- Type safety improvements

