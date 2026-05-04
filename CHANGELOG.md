# سجل التغييرات — Changelog

كل التغييرات الجوهرية لهذا المشروع موثقة هنا.

الصيغة مبنية على [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)،
ويتبع المشروع [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [31.3.10] — 2026-05-04

### ⚡ أداء — in-memory cache لـ `getSourceStats` في hot path الترتيب

السياق: PR #59 خزّن نتيجة `getAutoDisabledSourceDomains()` في cache 30s، لكن `bookRequest.ts:performFullSearch` لسه بينده `getSourceStats()` مباشرةً على كل full-search متعدد المصادر للحصول على `trustRate` من أجل ترتيب URLs. ده كان بيعمل SCAN + N×HGETALL على Redis في كل بحث (~5–15ms latency).

التصميم: أضفنا `getSourceStatsCached()` بنفس الـ 30s TTL pattern. الـ `getAutoDisabledSourceDomains()` كمان بقت تستدعي النسخة الـ cached داخلياً، فلو الـ cache دافي، الاتنين يخلصو بدون أي Redis ops على hot path. النسخة الأصلية `getSourceStats()` بقت بس للـ admin dashboard / Telegram /sources panel — حيث الـ freshness أهم من الـ latency. الـ `invalidateDisabledSourcesCache()` بتمسح الاتنين معاً عشان admin toggle على source يلتقط فوراً.

تأثير الترتيب: الـ `trustRate` كمية تراكمية (ok / (ok+fail+mistralRejected) عبر تاريخ المصدر)، فـ 30s staleness عليها لا يؤثر على ترتيب URLs ضمن البحث الواحد. على Redis بآلاف المفاتيح يقلّل ~5–15ms من latency كل full-search.

---

## [31.3.9] — 2026-05-04

### 🐛 إصلاح UX — toast notifications لـ `premium_buy` و `fp:` ما كانتش بتظهر

السياق: في `callbacks.ts` كان فيه general `bot.answerCallbackQuery(query.id)` صامت بيتنفّذ على كل الـ callbacks اللي ما اتعملش لها handle مبكّر (line 215 سابقاً). بعد كده كان فيه handlers بتحاول ترد بـ toast نصّي، وأي محاولة ثانية لـ `answerCallbackQuery` على نفس الـ query ترفضها Telegram → الكود مغلَّف بـ `.catch(() => {})` فالخطأ كان بيتبلع بصمت والمستخدم ما يشوفش الرسالة.

التأثير الفعلي على المستخدمين:
1. **`premium_buy` لمستخدم Premium بالفعل**: يضغط "⭐ ترقية" → الـ general silent answer يفوز → الـ toast `"⭐ أنت بالفعل مشترك في Premium!"` بيفشل بصمت → المستخدم يشوف لودر يختفي وما يحصلش رد. تكرار الضغط ممكن يأكل dedup quota.
2. **`fp:` على رسالة فشل قديمة بـ session منتهية**: يضغط زر التنقل → الـ general answer يفوز → الـ toast `"⏰ انتهت الجلسة."` بيفشل بصمت → نقرة بدون رد.

الإصلاح: نقل `premium_buy` و `fp:` handlers قبل الـ general silent answer (نفس الـ pattern اللي اتطبق على wishlist callbacks سابقاً، مع تعليق صريح في الكود يشرح اللي حصل). الـ premium_buy "already subscribed" toast كمان أصبح `show_alert: true` عشان يظهر بشكل واضح كـ popup بدل toast سريع. الـ general answer بقى أسفل الـ explicit handlers، فيتنفّذ فقط للـ callbacks اللي مش محتاجة toast نصي خاص.

### 📝 ملاحظة على CHANGELOG history

PRs #58 و #59 (Redis SCAN في hot path، in-memory cache لـ disabled-source set) اتدمجوا في main وكودهم موجود في `analytics.ts` و `redis.ts`، لكن إدخالاتهم في CHANGELOG اتمسحت أثناء حل تعارضات `merge main → PR #56`. الإدخالات دي ممكن نرجّعها في CHANGELOG لاحقاً لو حضرتك قررت ذلك — مفيش effect على السلوك الفعلي للبوت.

---

## [31.3.8] — 2026-05-04

### 🛠 صيانة — graceful shutdown يُغلق noor-book Playwright browser

السياق: `noorBookResolver.ts` يُشغّل headless Chromium singleton (~150MB RAM) و يفتحه lazily عند أول طلب لـ noor-book.com. الـ `shutdownNoorBookBrowser()` كان مُعرَّف ومُصدَّر، لكن **ما حدش بيناديه**. على SIGTERM، الـ Chromium child process يبقى لحظة قبل ما الـ process exit يقتله من الـ OS، مما قد يُسبّب:
- warnings في الـ container logs عن orphan processes.
- في حالات نادرة، خطأ "browser closed unexpectedly" لو الـ process exit وقع أثناء معالجة تحميل noor-book نشط.

الإصلاح: استدعاء `shutdownNoorBookBrowser()` في `gracefulShutdown()` بعد ما الـ workers تنتهي. الإغلاق idempotent ولا يُسبّب مشاكل لو الـ browser ما اتفتحش أصلاً (مثلاً deployment ما واجهش طلب noor-book).

---

## [31.3.7] — 2026-05-04

### 🚨 إصلاح حرج — race condition بين SIGTERM handlers يُجهض graceful shutdown

السياق: السيرفر كان يُسجّل `process.on("SIGTERM"|"SIGINT")` في موضعَين منفصلَين:
1. `server/index.ts` — handler الـ graceful (يُغلق HTTP، ينتظر `_activeJobs` تنتهي حتى 30 ثانية، ثم Redis quit، ثم `process.exit(0)`).
2. `server/bot/index.ts` — handler ثانٍ (يوقف Telegram polling، Redis quit، **ثم `process.exit(0)` فورًا**).

Node.js يُشغّل **كل** الـ handlers المُسجّلة على نفس الإشارة بالتوازي، فأول واحد يصل لـ `process.exit` يُنهي العملية كلها. الـ handler في `bot/index.ts` كان أسرع بكثير (بدون انتظار workers) → كان يقتل الـ workers في وسط معالجة الـ jobs.

**التأثير على Production:**
- مستخدم في وسط تحميل كتاب (10s+ على Hindawi/foulabook) → يضرب `docker compose restart bot` → الـ job يُقتل قبل `await failJob` وقبل تحديث `Q_ACTIVE` → الـ job يُعتبر "stuck" ويُمسح في `recoverStuckJobs()` على الـ start التالي → المستخدم لا يحصل على رسالة فشل، فقط silent loss.
- إحصاءات Telegram: رسائل "⏳جاري التحميل..." تبقى في الـ chat بدون update لأن `editMsg` ما يُنفَّذ.

**الإصلاح:**
1. **حذف `process.on("SIGTERM"|"SIGINT")` من `bot/index.ts`** — التعامل مع الإشارات يقع حصرًا على `server/index.ts`. الـ shutdown logic في `server/index.ts` تستدعي `gracefulShutdown()` من `bot/index.ts` (الـ named export)، فلا حاجة لـ duplicate registration.
2. **إضافة safety-net force-exit لـ SIGINT** في `server/index.ts` — كان موجود لـ SIGTERM فقط (`setTimeout(() => process.exit(1), 60_000)`). الآن مغلَّف في helper `installForceExit(signal)` ومُطبَّق على الإشارتَين.

النتيجة: SIGTERM/SIGINT الآن تنتظر فعليًا 30 ثانية للـ workers قبل الخروج. لو طلب التحميل قعد أكثر من ذلك، يُسجَّل warning واضح وتُسترَد الـ jobs العالقة على الـ start التالي عبر `recoverStuckJobs`.

---

## [31.3.6] — 2026-05-04

### 🐛 إصلاح — `^www.` regex في `engine.ts` كان يحذف حرفًا زائدًا

السياق: `engine.ts` كان يستخدم `replace(/^www./, "")` (نقطة غير مهرَّبة) في موقعَين (`isPdfUrl` line 130 و `unifiedSearch` line 263) لتجريد بادئة `www.` من الـ hostname قبل المقارنة. النقطة غير المهرَّبة تطابِق أي حرف، فالـ regex كان يستهلك "www" + حرف رابع أيًا كان. على الـ hostnames الشائعة (مثل `www.example.com`) النتيجة صحيحة بالصدفة لأن الحرف الرابع نقطة فعلاً، لكن في الحالات الحدّية مثل `wwwa-foo.com` كان الـ result `-foo.com` (سلوك غير متوقَّع، يكسر مطابقة الـ trusted-domain).

الإصلاح: تهريب النقطة في الموقعَين (`/^www\./, ""`) — يطابق الموقع الثالث في نفس الملف (line 72) الذي كان مهرَّبًا أصلاً.

### 🛠 صيانة — `deploy.sh` يستخدم `docker compose` v2

السياق: `deploy.sh` كان يستخدم `docker-compose` (v1 plugin) بينما `docs/RUNBOOK.md` و `docs/PRODUCTION.md` و `.agents/skills/testing-book-bot/SKILL.md` كلها تستخدم `docker compose` (v2 subcommand). على Docker Engine الحديث، `docker-compose` (v1) قد لا يكون مثبتًا — التشغيل كان يفشل بـ `command not found`.

التحسينات:
1. **`docker-compose` → `docker compose`** في كل الأوامر.
2. **`set -euo pipefail`** بدل `set -e` فقط — يمنع تجاهل الأخطاء في الـ pipelines والـ unset variables.
3. **`SUDO=…` متغير اختياري** بدل sudo ثابت — على السيرفر `ubuntu` user داخل `docker` group، فلا حاجة لـ sudo افتراضيًا.
4. **`git pull --ff-only`** بدل `git pull` — يمنع merge commits غير متوقَّعة على main.
5. **`up -d --build --force-recreate bot`** بدل `down` ثم `up --build` — يحافظ على شغل الـ db و redis (zero downtime على الـ stateful services). هذا يطابق نمط النشر الموثَّق في `RUNBOOK.md`.
6. **`sleep 30`** بدل `sleep 5` — يطابق healthcheck `start_period=30s` في `docker-compose.yml`.
7. **`docker compose logs --tail=20 bot`** بدل البحث عن container name يدويًا — أبسط وأكثر مقاومة للتغييرات في naming.

### 📝 توثيق — `README.md` يستخدم `docker compose`

تحديث المراجع في `README.md` لتطابق بقية الـ docs (`docker-compose up` → `docker compose up`، إلخ).

---

## [31.3.5] — 2026-05-03

### 🚨 إصلاح حرج — direct-mode send كان يتخطّى pdfValidator بالكامل

السياق: لما البوت يقدر يستخدم Telegram-fetches-URL (direct mode، أسرع من local download)، الـ server **مش بيحمّل** الـ PDF محلياً. النتيجة: `validatePdfContent` ما بيتشغّلش على الإطلاق. أي URL "موثوق" لأي slug كان يصل للمستخدم بدون تحقق من المحتوى.

سيناريو production مؤكد (search_logs id=498، user 8180806508):
- المستخدم طلب: "الموجز في فن التفاوض" (كتاب مدفوع، مش متوفر مجاناً)
- البوت بعت: `dn790006.ca.archive.org/0/items/dalilkuwa-s2021-a/dalilkuwa-s2021-a.pdf` = "الدليل إلى القوة والدهاء" (لمى ابراهيم فياض، كتاب مختلف خالص)
- trace: `phase=download_done filenameScore=0` (تم حسابها بعد الإرسال — كانت لمنع caching فقط، مش لإلغاء الإرسال)
- لا candidate_accepted/rejected events → دليل أن pdfValidator ما اشتغلش

الإصلاح في طبقتين:

1. **`server/bot/download.ts`**: helper جديد `directSendUnsafe(book, url)` بيرجع true لو `urlFilenameRelevance < 0.15`. لو unsafe → نتخطّى direct mode ونـ fall through لـ local download (اللي بيشغّل full pdfValidator + Mistral).

2. **`server/bot/pdfValidator.ts`**: في الـ trusted-domain branch، لما المُرسَل مفهوش search title لكن الـ filename "informative-looking" (مش digit-only)، كان بيقبل blindly. النا أضفنا filename relevance check — لو 0 token overlap مع bookName → fall through للـ full validation.

تأثير: اتنين دفاعات تلقائية ضد أي archive.org/trusted-domain slug غير ذي صلة.

اختبارات: `test-direct-send-safety.mjs` (11 سيناريو، PASS): T1 production case، T2 arabic-slug match، T3 digit-only neutral، T4 Latin slug، T5 directory-only word، T5.b filename match، T6 edge cases، T7 numeric scoring.

---

## [31.3.4] — 2026-05-03

### 🐛 إصلاح — parseBookName كان يحذف "قراءة" من وسط عنوان الكتاب

السياق: `parseBookName` (server/bot/bookNameParser.ts) كان يستخدم نمط `(^|\s)قراءة(\s|$)` (anywhere) لإزالة كلمات النيّة (تحميل، اقرأ، قراءة، حمل). النتيجة: عنوان شرعي مثل "فن قراءة العقول" يُحوَّل إلى "فن العقول" قبل البحث → 0 نتائج.

التحقق من production: trace `5469997406-1777845267637-phn4h` يُظهر:
- المستخدم كتب "فن قراءة العقول"
- البوت بحث عن "فن العقول" (10 نتائج لكتب أخرى)
- النتيجة: `outcome=links_only` (الـ cache-poison defense رفضت Hindawi numeric URL — اشتغل صح)

الإصلاح:
1. **نقل كلمات النيّة من `ARABIC_NOISE_WORDS` (anywhere) إلى `LEADING_NOISE` (start-only)**: تحميل، تنزيل، حمّل، نزّل، اقرأ، قراءة.
2. **استبعاد "حمل" و"نزل" بلا شدة**: ambiguous مع نوع الكتاب ("حمل العنزة"). نكتفي بالأشكال الواضحة.
3. **الـ loop في `parseBookName` يُعالج تلقائياً prefix متعدد**: "تحميل كتاب فن قراءة العقول" → "كتاب فن قراءة العقول" → "فن قراءة العقول".

تأثير على عناوين كتب حقيقية فيها هذه الكلمات (كانت تتعطّل قبل الإصلاح):
- "فن قراءة العقول" — Henrik Fexeus
- "فن قراءة الأفكار"
- "متعة القراءة"
- "اقرأ باسم ربك"

اختبارات: `test-parser-preserves-قراءة.mjs` (23 سيناريو، PASS): T1-T11 حالات حقيقية، T12-T14 intent متعدد، T15-T18 noise classics، T19-T23 حالات حدية.

---

## [31.3.3] — 2026-05-03

### 🐛 إصلاح — telemetry:traces self-trim

السياق: `telemetry:traces` (Redis list) كانت بتجمّع IDs بدون أي TTL، بينما `telemetry:trace:{id}` (المفتاح الفردي) عنده TTL = 1h. النتيجة: بعد ساعة، الـ list فيها 50+ ID ميت، و `getRecentTraces` ترجع `[]` لأن `mget` كل الـ IDs ترجع null. على production الحالية: list len=51، live keys=1.

الإصلاح في `server/bot/telemetry.ts`:

1. **`expire(TRACES_LIST, 2 * TRACE_TTL_SEC)`** يضاف للـ pipeline في كل `finish()` → الـ list نفسها تختفي بعد ساعتين سكون.
2. **Self-trim في `getRecentTraces`**: بعد `mget` نحدد الـ stale IDs (raw === null أو parse فشل) ونستدعي `pruneStaleTraceIds` (fire-and-forget):
   - لو كل الـ window stale → `DEL telemetry:traces` (أرخص من LREM متعدد).
   - وإلا → pipeline من `LREM 0` لكل stale ID.

اختبارات: `test-telemetry-self-trim.mjs` (18 سيناريو، PASS): T1 list TTL، T2 all-stale prune via DEL، T3 partial-stale prune via LREM، T4 empty list no-op، T5 all-alive no-prune.

---

## [31.3.2] — 2026-05-03

### ⚡ أداء — حذف استدعاءات Redis مكررة في hot-path

- `userSettings.ts`:
  - **جديد**: `computeDailyLimit(prem, override)` — منطق pure synchronous بدون Redis.
  - `getUserDailyLimit(userId, premHint?)` — لو الـ caller حسب `isPremium` فعلاً وعنده النتيجة، يمرّرها بدل ما الدالة تنده `isPremium` مرة تانية داخلياً.
- `wishlist.ts`:
  - `getWishlistMax(userId, premHint?)` يقبل قيمة محسوبة مسبقاً.
  - `sendWishlist`: تجيب `prem` مرة واحدة وتمرّرها (بدل استدعاء `isPremium` صريح + جوّه `getWishlistMax`).
- `bookRequest.ts.processBookRequest`: كان بيعمل **3** استدعاءات `isPremium` لنفس الـ user (handleBookRequest pipeline + Promise.all + getUserDailyLimit الداخلي). دلوقتي **1** استدعاء واحد + قراءة `ulimit:{uid}` + حساب `dailyLimit` synchronously.
- `commands.ts` (`/start`, `/stats`, `/premium`) و `callbacks.ts` (`main_menu`, `my_stats`): مرّروا `prem` لـ `getUserDailyLimit`.

**التأثير**: لكل request إلى hot-path → **توفير 3 Redis ops** (1 sismember + 2 exists) كل ما الـ user يـ start/stats/main_menu/my_stats/premium/wishlist. على 14 طلب/يوم على production = ~42 Redis op/يوم؛ يكبر مع نمو القاعدة.

اختبارات: `test-dedup-isPremium.mjs` (20 سيناريو، PASS).

---

## [31.3.1] — 2026-05-03

### 🔒 أمان — patch transitive vulnerabilities + Dockerfile fix

- **package.json overrides**: تثبيت `form-data ^2.5.4` و `qs ^6.14.1` و `tough-cookie ^4.1.3` و `uuid ^14.0.0` لإغلاق ثغرات منقولة (transitive) كانت تأتي من `node-telegram-bot-api → @cypress/request-promise → request-promise-core → request@deprecated`.
- **node-telegram-bot-api**: `0.66.0 → 0.67.0` (minor، non-breaking).
- **نتيجة `npm audit`**: من 15 ثغرة (2 critical + 1 high + 12 moderate) إلى 10 (0 critical + 1 high + 9 moderate). الـ 2 critical (`form-data`) إتقفلوا.
- **متبقّي وموثَّق**: ثغرة drizzle-orm SQL identifier injection (HIGH — fix يحتاج upgrade من 0.30 إلى 0.45 بـ breaking changes؛ البوت لا يمرر identifiers مُتحكَّم بها من المستخدم → الفجوة لا تنطبق عملياً)، ثغرات esbuild dev-server (moderate — esbuild يُستخدم وقت البناء فقط مش وقت التشغيل)، ثغرة `request` SSRF transitive (moderate — لا تنطبق على Telegram-only outbound calls).
- **Dockerfile**: إضافة `COPY --from=builder /app/script ./script` لكي تكون scripts العمليات (مثل `migrate-premium-to-manual.mjs`) متاحة عبر `docker compose exec bot node script/<file>.mjs`.

---

## [31.3.0] — 2026-05-03

### 🐛 إصلاحات حرجة — Premium TTL expiration (billing)

السياق: تدقيق الكود كشف خطأ خطير في منطق Premium بـ`server/bot/userSettings.ts`:

- `isPremium()` كان يفحص `SISMEMBER premium:users` فقط.
- لمّا اشتراك مدفوع TTL ينتهي (30 يوم)، Redis يمسح مفتاح `premium:exp:{uid}` تلقائياً، **لكن المستخدم يفضل في الـ Set للأبد**.
- النتيجة: العميل يدفع مرّة واحدة → Premium دائم. خسارة إيرادات مباشرة.

كذلك التجديد عن طريق `setex` كان **يستبدل** الـ TTL بدل ما يـ يمدّده، مخالفاً سلوك README الموثّق ("التجديد يمدّد الصلاحية القائمة").

#### الإصلاحات:

1. **Lazy cleanup في `isPremium()`** (`userSettings.ts`):
   - منطق جديد: `isPremium = inSet AND (premium:exp موجود OR premium:manual موجود)`
   - مفتاح ثالث `premium:manual:{uid}` للتمييز بين منحة Admin (بلا انتهاء) واشتراك مدفوع (TTL).
   - لو user في الـ Set بدون أي من المفتاحين → اشتراك انتهى → SREM فوري (lazy cleanup) + `false`.
   - الـ pipeline 1 round-trip بدل 3.

2. **Renewal extends instead of replaces** (`userSettings.ts:setPremium`):
   - يقرأ الـ TTL القائم → يجمع معاه `days*86400` → يكتب الـ TTL الجديد.
   - عميل عنده 10 أيام باقية يجدد بـ 30 → 40 يوم. كان قبل الإصلاح: 30 يوم (يخسر 10).

3. **Hot path pipeline updated** (`bookRequest.ts`):
   - الـ pipeline في `handleBookRequest` يضيف `EXISTS premium:exp/manual` بدل `sismember` فقط.
   - يحسب `isPrem` بنفس المنطق الصحيح + lazy cleanup. لا round-trips إضافية لكنه أصحّ.

4. **Migration script** (`script/migrate-premium-to-manual.mjs`):
   - يُترَك كل عضو سابق في `premium:users` بدون `premium:exp` كـ admin grant (يُضاف `premium:manual:{uid}`).
   - يحمي users القدامى من الـ downgrade المفاجئ. يُشغَّل مرّة واحدة بعد الـ deploy.

#### اختبار:
- 23/23 deterministic probes pass (`test-premium-expiration.mjs`):
  - T1: paid expires after TTL + lazy cleanup
  - T2: renewal extends remaining time (10+30=40 days)
  - T3: admin grant lasts forever, no expiry
  - T4: revoke clears all 3 keys
  - T5: lazy cleanup of pre-fix stale entries
  - T6: paid renewal supersedes manual grant

---

## [31.2.0] — 2026-05-03

### 🐛 إصلاحات حرجة — Cache Poisoning Defense

السياق: تدقيق إنتاج (نفس اليوم بعد PR #32) كشف **10 entries مسممة** في `cached_books` كلها `downloads.hindawi.org/books/<numeric>.pdf` لكتب لا علاقة لها بمحتوى Hindawi:

| id | الاستعلام | الـ URL المخزّن (غلط) |
|----|-----------|----------------------|
| 117 | تحت مسمى الرجولة | hindawi.org/books/14168605.pdf |
| 122 | أزمة رجولة | hindawi.org/books/58379627.pdf |
| 116 | لخصلي كتاب حوار مع صديقي الملحد | hindawi.org/books/31475247.pdf |
| 115 | مذكرات لينين | hindawi.org/books/28158282.pdf |
| 113/114 | زقاق المدق | hindawi.org/books/62575295.pdf |
| ... | ... 5 إضافية ... | |

السبب الجذري: title-gate في PR #31 (`pdfValidator.ts:625-660`) يفحص فقط لمّا `searchTitle` (HTML title من Firecrawl) **مش فاضي**. لمّا Firecrawl يرجّع title فاضي / URL خام لـ Hindawi `/books/<id>.pdf`، الـ trusted-domain bypass كان يقبل بدون أي فحص → الملف الغلط يتسلّم للمستخدم **و** يتخزّن في الكاش. كل طلب لاحق لنفس اسم الكتاب كان يُسلَّم نفس الملف الغلط من الكاش (بدون re-validation).

#### الإصلاحات:

1. **Validator bypass tightened** (`pdfValidator.ts`):
   - أضفت `hasUninformativeFilename(url)` يكتشف الـ filenames الرقمية البحتة (digit-only).
   - لو URL trusted + opaque + `searchTitle` فاضي → ما نـ bypass، نعدّي الـ full validation (metadata + Mistral).
   - Mistral عندها قاعدة موجودة "rejects all digit-only filenames"، فالـ Hindawi mismatches الآن تُرفض حتى بدون searchTitle.

2. **Cache write guard** (`bookRequest.ts:701`):
   - حتى لو الـ validator قَبِل بسبب bug مستقبلي، الـ cache write يرفض persisting أي source_url له digit-only filename.
   - دفاع في عمق: حتى لو wrong-file اتسلم مرّة واحدة، ما يلوّث الكاش لباقي المستخدمين.

3. **Production cleanup**:
   - حذفنا الـ 10 entries المسممة من `cached_books` (DELETE 10).
   - مسحنا الـ search-result cache المرتبط (`sc:*` keys للأسماء المتأثرة).

#### Telemetry جديد:
- `tel:cache:opaque_url_skipped` — عدد المرّات اللي رفض فيها الـ guard كاش entry.

#### اختبار:
- 36/36 deterministic probes pass (`test-cache-poison-defense.mjs`):
  - D1: helper على 13 URL pattern (digit-only / slug / edge cases)
  - D2: cache-write guard logic على 6 سيناريوهات (legacy vs fixed)
  - D3: validator bypass decision tree على 5 سيناريوهات

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

