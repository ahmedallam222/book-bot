# سجل التغييرات — Changelog

كل التغييرات الجوهرية لهذا المشروع موثقة هنا.

الصيغة مبنية على [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)،
ويتبع المشروع [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [31.1.0] — 2026-05-03

### 🐛 إصلاحات حرجية — Find-to-Send Loss Mitigation

السياق: تدقيق إنتاج (2026-05-03) كشف أن **44%** من الطلبات اللي البوت "بيلاقي" فيها كتاب ما بتنتهي بإرسال PDF (82 sent vs 65 found-but-lost في 7 أيام). السبب الجذري: حلقة التحميل في `bookRequest.ts` كانت **بدون أي cap** — كل URL مُرشَّح يتم تجريبه حتى ينجح واحد. مصادر منخفضة النجاح (هنداوي 16%، فولا بوك 25%) كانت تكدّس الحلقة بـ 4-8 محاولات فاشلة لكل طلب، تستهلك ~90 ثانية × N قبل ما المستخدم يحصل على "links_only".

ثلاث طبقات إصلاح متكاملة:

- **Cap عالمي على المحاولات لكل طلب** (`MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST=6`):
  بعد 6 URLs مجرّبة، الحلقة تتوقف وتُسلّم للمسار الـ "links_only" / paid-book بدل ما تكمل لساعة. يحمي workers الـ queue من الجمود على طلب واحد.

- **Cap لكل دومين داخل الطلب** (`MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN=2`):
  لو 5 URLs من هنداوي و 2 من bookleaks: قبل التغيير، 5 هنداوي يُجرَّبون كاملين قبل الانتقال. الآن نقف بعد 2 من نفس الدومين ونكمّل بدومين تاني. يضمن إن مصادر متعددة تأخذ فرصة، حتى لو واحد منها مكدّس في القائمة.

- **Soft penalty للمصادر منخفضة النجاح في الـ scoring** (`LOW_SUCCESS_RATE_PENALTY_THRESHOLD=0.30`):
  `reliablePenalty` كان binary: -1 لـ `UNRELIABLE_DOMAINS` أو +1 لأيّ شيء آخر. هنداوي عند 16% كانت تحصل على +1 (لا عقوبة). الآن لو الـ source rate < 30% (وفيه data كافٍ) → -0.5 (soft). جرب ثلاثي:
  - Hindawi: 0.398 → **0.097** (تقع لآخر القائمة)
  - Foulabook: 0.475 (lower because soft penalty + better filename)
  - Bookleaks: 1.000 (يبقى أوّل اختيار)

### 🔧 إصلاحات داعمة + تنظيف

- `analytics.ts`: استخراج `sanitizeDomainKey()` كنقطة موحّدة للـ normalization. قبل: `trackDownload` كان يكتب الدومين خام (`bookleaks.com` و `www.bookleaks.com` يصيرون رفّين منفصلين)، بينما `trackSourceAttempt` و `trackSourceMistralReject` كانوا ينظّفون. النتيجة: `getSourceStats` يقسم نفس الموقع لرفّين، يضرب signal الـ auto-disable. الآن كل المسارات تستخدم نفس الـ helper، و `getSourceStats` يدمج المفاتيح القديمة الـ `www.*` على القراءة بدون migration.
- `bookRequest.ts`: استخدام `sanitizeDomainKey()` لكل قراءة دومين من URL (`dlDomain`، `sentDomain`، `srcRateMap` lookup) لضمان consistency بين الـ scoring والـ writes والـ caps.
- Telemetry جديد لقياس أثر الـ caps:
  - `tel:dl:per_domain_capped` — عدد URLs اللي تخطيناها لو domain cap اتحط
  - `tel:dl:global_cap_reached` — عدد الطلبات اللي وصلت للـ global cap
  - `tel:dl:found_no_send` — عدد الطلبات اللي البوت لاقى نتائج بس ماعرفش يبعث ملف (المتريك الأساسي للتدقيق — قبل/بعد الإصلاح)
- `L.warn("found_no_send", …)` log structured بـ `book`, `results`, `candidates`, `attempted`, `domainCapHits`, `globalCapReached` لتسهيل البحث في الـ logs عن root cause لكل حادثة فشل.

### 📐 إعدادات قابلة للضبط (env)

- `MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST=6` — 0 يعطّل الـ cap.
- `MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN=2` — 0 يعطّل الـ cap.
- `LOW_SUCCESS_RATE_PENALTY_THRESHOLD=0.30` — 0 يعطّل الـ soft penalty.

### 🧪 الاختبار

- `test-source-weighting.mjs`: 20/20 deterministic probes تغطّي:
  - `sanitizeDomainKey` لـ `www.`, uppercase, ports, empty, whitespace
  - default values لكل env knob
  - scoring math مع أرقام الإنتاج الحقيقية (Hindawi 16%, Foulabook 25%, Bookleaks 100%)
  - simulation للـ loop مع per-domain cap + global cap (3 سيناريوهات: full traffic، global hit، caps disabled)

---

## [31.0.0] — 2026-05-03

### 🐛 إصلاحات حرجية — PDF Mismatch + Paid-Book Detection

السياق: مستخدم طلب "تحت مسمى الرجولة" (نوال السعداوي — كتاب مدفوع، غير منشور رقمياً مجاناً) فأرسل البوت ملف "ملك وامرأة وإله" (نفس المؤلفة، نشر هنداوي) باسم ملف مزوّر `تحت_مسمى_الرجولة.pdf`. أربع طبقات حماية تمنع تكرار الحادثة:

- **L1 — title-gate حتى على الـ trusted domains** (`pdfValidator.ts`):
  قبل: `isTrustedDomain(url)` كان يقبل أيّ PDF من `downloads.hindawi.org` بـ `score=1` بدون أيّ فحص للعنوان. هذا تعليق قديم في الكود (`config.ts:152-169`) كان يعترف بالخطر: "the failure mode (search-ranker mismatch) is the same as libgen". الآن `validatePdfContent` تستقبل `searchResultTitle` (HTML `<title>` من Firecrawl) وتفحص `wordOverlapScore(bookName, searchResultTitle)`. لو أقل من `PDF_VALIDATE_REJECT_THRESHOLD` تُرجع event جديد `trusted_domain_title_mismatch` وتقفز للمرشح التالي.

- **L2 — اسم الملف يطابق المحتوى الفعلي** (`download.ts`):
  قبل: `cleanBookName = bookName.replace(...)` ثم `fname = "${cleanBookName}.pdf"` يستخدم نصّ المستخدم الخام دائماً. النتيجة في الحادثة: ملف اسمه `تحت_مسمى_الرجولة.pdf` يحتوي "ملك وامرأة وإله" (تضليل صريح). أضيف `buildPdfFilename(bookName, validation.metaTitle)` يفضّل العنوان الحقيقي من `/Title` metadata لو متاح ومختلف عن طلب المستخدم. كذلك `buildCaption(bookName, metaTitle)` يُضيف سطر "📖 _<العنوان الفعلي>_" تحت طلب المستخدم لما العنوانان مختلفان — المستخدم يرى الفرق فوراً قبل فتح الملف.

- **L3 — رسالة كتاب مدفوع واضحة** (`bookRequest.ts` + `ui.ts`):
  قبل: لو فشل كل المرشّحين، البوت يبعث `buildFailMessage` (روابط لمواقع البحث) — يبدو كأنه bug. الآن `performFullSearch` يعدّ نتائج Firecrawl المصنّفة `access: "protected_page"` (المُكتشفة بأنماط `PROTECTED_ACCESS_PATTERNS` مثل "اشترِ"، "buy now"، "premium"). لو `paidSignalCount > 0` و كل التحميلات فشلت → `buildPaidBookMessage(bookName)`: "📕 *كتاب مدفوع أو غير متوفر مجاناً* … قد يكون مدفوعاً، أو متاحاً للقراءة فقط على موقع الناشر، أو غير منشور رقمياً بعد".

- **L4 — استخدام الـ search title كـ fallback لـ metaTitle** (`pdfValidator.ts`):
  بعض الهوستات (هنداوي تحديداً) تضع `/Title` بعد أول 64KB من PDF فلا يستخرجه الـ validator. قبل: غياب `metaTitle` → fallback لـ Mistral مع `metaTitle=""` (يخمّن من الـ URL وحده). الآن لو `searchResultTitle` متاح وصالح، يصير `effectiveMetaTitle` لكامل المنطق التالي (الـ score الموضعي + cross-language detection + Mistral). يقلل false-rejects على هنداوي ويعطي Mistral سياقاً صادقاً.

### 🔧 تحسينات تقنية
- `BookResult.title` (موجود سلفاً من `engine.ts:271` — `doc.metadata.title`) يُمرَّر الآن عبر `urlSearchTitle: Map<string, string>` في `performFullSearch`، ثم لـ `downloadAndSend(..., searchResultTitle)`، ثم `validatePdfContent(..., searchResultTitle)`. تمرير عبر التواقيع فقط — لا تغيير في bookmarks الـ public API.
- معالجة fallback لـ `r.title` لما يكون مساوياً للـ URL (engine.ts يعطي fallback url لو `<title>` مفقود) — نتعامل معه كـ "" لتجنّب لخبطة الـ wordOverlapScore.
- اسم الملف الجديد يستخدم نفس `sanitizePdfBaseName` لكنه يفضّل `metaTitle` عند الاختلاف الحقيقي. caption يضيف سطر العنوان الفعلي بصياغة italic لما يفرق.

### 🧪 اختبارات
- `test-pdf-validator-titlegate.mjs`: 3 سيناريوهات (trusted + mismatch → reject، trusted + match → accept، trusted + no title → legacy bypass) — كلها تمر.
- `test-filename-builder.mjs`: 5 سيناريوهات (bug repro، تطابق، fallback، sanitization، عنوان قصير) — كلها تمر.
- بعد الـ build: `dist/index.cjs` نما من 406.8kb → 412.2kb (+5.4kb، +1.3%).

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

