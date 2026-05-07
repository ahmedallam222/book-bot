# سجل التغييرات — Changelog

كل التغييرات الجوهرية لهذا المشروع موثقة هنا.

الصيغة مبنية على [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)،
ويتبع المشروع [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [32.1.1] — `/invite` Markdown parse error hotfix — 2026-05-07

### 🐞 Bug fix (CRITICAL — feature was broken in production)

#### `/invite` and "🎁 ادعُ صديقاً" callback returned "خطأ مؤقت"
- **Symptom**: Every invocation of `/invite` or the inline button raised
  `ETELEGRAM: 400 Bad Request: can't parse entities`.
- **Root cause** in `referral.ts:buildInviteMessage`:
  1. Stray `_` after `انضمامه.` opened an italic that was never closed.
  2. `_${state.nextTier.remaining} … *+${state.nextTier.days} يوم Premium*_`
     used **nested** italic+bold, which Telegram's old Markdown parser
     does not support. Combined with #1, every render produced an
     unclosed entity.
- **Fix**: Removed the stray `_`, flattened the italic-with-bold-inside to
  plain bold (`*N* إحالات للوصول إلى *+D يوم Premium*`).
- **Tests added**: `test-markdown-balance.mjs` — counts `*` and `_`
  occurrences (excluding code spans / escapes) for three referral states
  (new user, mid-tier, maxed) and asserts they are paired. Also a
  static-source regression check rejecting any future adjacent `*_` /
  `_*` pattern in `referral.ts`.

### Files changed
- `server/bot/referral.ts` — fix unmatched `_` in `buildInviteMessage`.
- `test-markdown-balance.mjs` (new) — 9 assertions guarding against
  unbalanced Telegram Markdown markers.
- `package.json` / `package-lock.json` — bump 32.1.0 → 32.1.1.

---

## [32.1.0] — Leaderboard fix (top books canonicalization + real weekly bucketing) — 2026-05-07

### 🐞 Bug fixes (CRITICAL)

#### 1. "أفضل كتب الأسبوع" أصبحت فعلاً أسبوعية
- قبل: `weekly.ts` كان يقرأ من نفس الـ Redis key (`stats:top_books`) اللي بيقرأ منه "🏆 الأكثر تحميلاً" — فالقائمتين كانت متطابقة 100%، الـ button name كذِب على المستخدم.
- بعد: weekly bucket حقيقي `stats:top_books:week:{YYYY-Www}` بـ TTL 21 يوم. الـ ISO-week محسوب بتوقيت القاهرة فيتطابق مع باقي الـ daily keys.
- أُضيف `getWeeklyTopBooks()` في `analytics.ts` يقرأ من الـ bucket الحالي.

#### 2. تكرار نفس الكتاب بصيغ مختلفة
- قبل: `analytics.ts:trackDownload` كان يكتب الـ user query الخام كـ leaderboard member. النتيجة: `هكذا تتعافي` (ي) و `هكذا تتعافى` (ى) entries منفصلة، رغم إنهم نفس الكتاب. **مثبت من production Redis**: السطرين كان عندهم 2 + 2 بدل 4.
- بعد: نخزّن `canonicalBookKey()` (canonicalize + strip trailing punctuation + cap 100ch) كـ member، ونحفظ أحدث صياغة كنسية في hash `stats:top_books_display`. عند القراءة، نعمل HMGET للـ display names لكل الـ canonical keys.

#### 3. الكتب من الكاش بتدمج تحت العنوان الكنسي
- قبل: لما يوزر A يطلب "هكذا تتعافي" ويوزر B يطلب "هكذا تتعافى عندما تكون مستعدا تأليف بريانا وايست"، كل واحد بيتم تسجيله بصياغته. حتى مع canonicalization، اختلاف اسم المؤلف يبقي الـ keys مختلفة.
- بعد: `bookRequest.ts` (الـ 2 cache-hit sites) بيمرّر `cached.bookName` (العنوان الكنسي اللي البوت سلّمه فعلاً) كـ `canonicalTitle` لـ `trackDownload`. كل المستخدمين اللي بيوصلوا لنفس الـ cached entry بأي صياغة → leaderboard entry واحد.

### 🎨 Polish

#### 4. اقتصاص ذكي عند حدود الكلمات
- قبل: `b.book.slice(0, 55)` كان يقطع وسط الكلمة. مثال من production: `Jan Kott , Shakespeare Our Contemporary (1964) Full book` → `Full boo` (مفقودة `k`).
- بعد: `truncateAtWord(text, 80)` في `text.ts` — يقطع عند آخر مسافة ≥ 80% maxLen، ويزيد `…` للإشارة. حد العرض زاد من 55 إلى 80.

#### 5. فلتر شكاوى في الـ leaderboard
- قبل: `هذا ليس الكتاب المطلوب` (count 3 في production) كان يدخل القائمة كاسم كتاب لأن البوت سلّم ملف، فالـ trackDownload شغّل.
- بعد: `isComplaintQuery()` يكشف الجمل اللي فيها كلمات شكوى ("ليس الكتاب المطلوب"، "wrong book"، "كتاب غلط"...) ويتجاهلها من الـ leaderboard فقط (الـ daily counts و user stats عادية).

#### 6. علامات ترقيم لاصقة في النهاية
- قبل: `سيكولوجية الذكاء'.` تتسجل بالـ `'.` في الآخر.
- بعد: `canonicalBookKey` يحذف `^[\s.,;:!?'"`«»—–\-ـ]+|[\s.,;:!?'"`«»—–\-ـ]+$` من الـ key.

### 🛠️ Migration script

- `scripts/migrate-top-books.mjs` — يقرأ كل الـ entries القديمة من `stats:top_books`، يـ canonicalize كل واحد، يجمع الـ scores اللي عندها canonical key مكرر، ويستبدل الـ key الأصلي atomic.
- `--dry` mode للـ preview بدون كتابة.
- يكتب أحدث/أعلى-score display name في `stats:top_books_display`.
- التشغيل: `docker exec book-bot-bot-1 node scripts/migrate-top-books.mjs`

### 📁 الملفات المتغيرة

#### Modified:
- `server/bot/text.ts` — أضيف 4 helpers: `canonicalBookKey()`, `isoWeekKey()`, `truncateAtWord()`, `isComplaintQuery()`
- `server/bot/analytics.ts` — `trackDownload` يقبل `canonicalTitle` ويكتب canonical key + weekly bucket + display hash + complaint filter. أضيف `getWeeklyTopBooks()`. `getTopBooks` يستخدم HMGET للـ display.
- `server/bot/weekly.ts` — يقرأ من weekly bucket، يستخدم `truncateAtWord(80)`. تنظيف كامل للـ comments السابقة.
- `server/bot/admin.ts` — `buildTopBooksMessage` و `admin_top` و `admin_stats` يستخدموا `truncateAtWord` بدل `slice` الخام.
- `server/bot/bookRequest.ts` — الـ 2 cache-hit sites بيمرّروا `cached.bookName` كـ canonicalTitle.

#### New:
- `scripts/migrate-top-books.mjs` — migration script
- `test-leaderboard.mjs` — 49 deterministic tests (canonicalization، ISO week، truncation، complaint detection، bundle markers)

### ✅ Verification

- typecheck: pass
- build: 563.1kb bundle
- tests: 42/42 passing (was 41 + 1 new = 42)
- production data tested: extracted live `stats:top_books` from EC2، ran canonicalization manually — verified `هكذا تتعافي` و `هكذا تتعافى` يدمجوا في key واحد.

---

## [32.0.0] — Engagement Loop (Streak + Badges + Referral) — 2026-05-07

طلب Donna: ROI analysis للـ retention/virality. النتيجة: البوت 2 active
users/day مع 13 طلب فقط — funnel ضعيف، المشكلة retention. هذا الـ PR
يبني حلقة كاملة: **streak** للـ retention + **badges** للـ علاقة العاطفية
+ **referral** للـ virality. كله Redis-only، صفر migration، صفر downtime.

### ✨ ميزات جديدة

#### 1. Streak System — سلسلة قراءة يومية
- Atomic Lua update على Redis (`streak:cur:{uid}` + `streak:last:{uid}` +
  `streak:max:{uid}`) — يمنع race conditions عند الـ rapid downloads.
- Cairo TZ aware (نفس المنطق المستخدم في daily limits).
- Milestones عند `[3, 7, 14, 30, 60, 100]` يوم → رسالة تهنئة فورية.
- لو سلسلة ≥3 يوم انكسرت → رسالة "💔 خسرت سلسلة X يوم — ابدأ من جديد".
- Display: سطر `🔥 سلسلة N يوم` في رسالة النجاح لما `N >= 2`.
- Fail-open: لو Redis مات، الـ streak تُعتبر صفر ولا يُعطّل التحميل.

#### 2. Badges — 10 شارات للإنجاز
- Atomic SADD ضمان firing الإشعار مرة واحدة لكل user/badge.
- 5 download tiers: `dl5/dl20/dl50/dl100/dl250` (📚 → 👑).
- 3 streak tiers: `streak3/streak7/streak30` (🔥 → 🌟).
- Summary badge (`summary10`): استخدام AI summary 10 مرات.
- Social badge (`social3`): دعوة 3 أصدقاء (نشط).
- Endpoint جديد: `/profile` لعرض الشارات + الـ streak + Premium.

#### 3. Referral System — دعوة + مكافأة Premium
- Deep-link: `https://t.me/<bot>?start=ref_<userId>` يُسجَّل عند `/start`،
  لكن **الـ activation الحقيقي** يحصل بس عند أول تحميل ناجح للمدعو
  (يمنع bot abuse).
- Tiered rewards (TTL extension via existing `setPremium()` — لا يوجد
  Premium دائم أبداً):
  - 3 إحالات → +٧ أيام
  - 5 إحالات → +١٤ يوم
  - 10 إحالات → +٣٠ يوم
  - 20 إحالات → +٦٠ يوم
  - 50 إحالات → +٩٠ يوم
  - كل +٢٥ إحالة بعدها → +٩٠ يوم إضافية
- Welcome gift للمدعو: +٣ أيام Premium عند أول تحميل (incentivizes
  Premium trial).
- Age check: المدعو يجب أن يكون <ساعة من تاريخ إنشائه عشان يُحتسب
  (يمنع حسابات قديمة من الانتقال للإحالة).
- Endpoint جديد: `/invite` لعرض الرابط + التقدّم نحو المكافأة التالية.

### 🛡️ تحسينات فلترة المصادر

- إضافة قائمة `HARD_BLOCKED_DOMAINS` (مختلفة عن `UNRELIABLE_DOMAINS`):
  - `UNRELIABLE_DOMAINS`: عقوبة ترتيب فقط (-١) — قد يصل للمستخدم لو لا
    بدائل.
  - `HARD_BLOCKED_DOMAINS`: استبعاد كامل قبل أي عملية شبكية في `verify.ts`.
- `scholar.archive.org` مرفوع لـ hard block — كان يظهر كـ wayback URL
  لـ EKB Egyptian journals بنسبة نجاح 9% (1/10).
- Override عبر `HARD_BLOCKED_DOMAINS_EXTRA` env var.

### 🔧 ملفات جديدة

- `server/bot/streak.ts` — Lua + helpers (`updateStreakOnDownload`,
  `getStreakState`, `formatStreakLine`, `buildMilestoneMessage`,
  `buildBrokenStreakMessage`).
- `server/bot/badges.ts` — `BADGES` تعريفات + `checkAndAwardBadges`,
  `trackSummaryAndAward`, `checkSocialBadge`, `getUserBadges`,
  `buildNewBadgeMessage`.
- `server/bot/referral.ts` — `trackReferralOnStart`,
  `activateReferralOnFirstDownload`, `getReferralState`,
  `buildReferralLink`, `buildInviteMessage`, `sendReferralNotifications`.

### 📝 ملفات معدّلة

- `server/bot/ui.ts` — `buildSuccessMsg` يقبل `streakLine?` اختياري.
- `server/bot/bookRequest.ts` — `sendSuccessMessage` يُحدّث streak +
  يُطلق `dispatchEngagementSignals` بعد كل تحميل ناجح (3 مواقع).
- `server/bot/commands.ts` — `/start` regex يستوعب `ref_<id>` payload،
  أوامر `/profile` و `/invite` جديدة، تحديث `/help`.
- `server/bot/keyboards.ts` — أزرار "👤 ملفي" + "🎁 ادعُ صديقاً" في
  `kbMain`.
- `server/bot/callbacks.ts` — handlers لـ `my_profile` + `invite_view`،
  signature يقبل `getBotUsername` اختياري.
- `server/bot/admin.ts` — `buildProfileMessage` لتجميع البيانات.
- `server/bot/index.ts` — تمرير `getBotUsername` للـ callback handler.
- `server/bot/config.ts` — `HARD_BLOCKED_DOMAINS` + env override.
- `server/bot/verify.ts` — فلتر hard-blocked قبل أي HEAD request.

### 🧪 تأكيدات الإنتاج

- `npm run typecheck` — يمر بدون أي خطأ.
- `npm run build` — bundle 560 KB (تقريباً نفس الحجم السابق).
- جميع الـ engagement signals fire-and-forget — أي فشل في Redis لا
  يُعطّل رسالة النجاح للمستخدم.

---

## [Unreleased] — UX Vibes Pass

### ✨ تجربة المستخدم — رسائل وتأثيرات متنوّعة

طلب Ahmed: "تأثيرات خرافيّة عند طلب الكتب ورسائل متغيّرة بحيث المستخدم
ميحسّش إنه بيزهق". تطبيق ست محاور:

1. **Progress variants** — كل خطوة من 7 خطوات البحث عندها 5–6 صياغات
   (icon + label) بدل صياغة ثابتة. كل تحديث تقدّم يختار عشوائياً.
2. **Success / cache-hit / paid-book / no-results variants** — كل واحدة
   لها pool من 3–9 رؤوس مختلفة، اختيار عشوائي عند البناء.
3. **Long-wait reassurance watchdog** — بعد 15 ثانية بدون تقدّم: رسالة
   تطمين خفيفة. بعد 30 ثانية: رسالة أعمق. **كلها بالعربية الفصحى الرسميّة**
   (ليست مصريّة ولا خليجيّة) بناءً على طلب المستخدم الصريح.
4. **Reaction pools** — بدل تكرار 🎉 لكل نجاح، البوت يختار من pool
   متنوّع لكل حالة (نجاح، كاش، خطأ، لا نتائج، استلام).
5. **Typing indicator** عند بدء كل طلب لأظهار الاستجابة فوراً.
6. **Personality lines (10%)** — أحياناً البوت يُلحق ملاحظة مهذّبة
   (بالفصحى أيضاً) برسالة النجاح: "ذوقك في الكتب يدلّ على عقل راقٍ".

ملفات جديدة:
- `server/bot/uiVariants.ts` — كل الـ pools + helpers (`pickRandom`, `chance`).
- `server/bot/progressWatchdog.ts` — منطق الـ 15s/30s timers.

ملفات معدّلة:
- `server/bot/ui.ts` — `buildProgress` / `buildSuccessMsg` / `buildPaidBookMessage`
  / `buildNoResults` يقرأوا من الـ pools الجديدة.
- `server/bot/reactions.ts` — `reactRandom(pool)` helper.
- `server/bot/bookRequest.ts` — أرمنا الـ watchdog عند كل تحديث، نضح الـ
  pools للـ react calls، أضفنا typing action عند البدء.
- `server/bot/commands.ts` — استلام الرسائل بـ reactions متنوّعة بدل 👀.

اختبارات جديدة:
- `test-ux-variants.mjs` — 33 probe (pool sizes, picker logic, formal-Arabic
  audit, reaction whitelist).
- `test-progress-watchdog.mjs` — 7 probes (arming / clearing / idempotence).

التغيير backward-compatible تماماً — لا تغيير في DB / API / cache.

---

## [31.10.0] — 2026-05-05

### ♻️ Restored: filename-trusted Mistral bypass (PR #14 regression)

**Bug** — `isFilenameTrustedDomain()` و`MISTRAL_BYPASS_FILENAME_THRESHOLD` كانا
معرَّفَين في `pdfValidator.ts` و`config.ts` لكن **لا يُستدعَيا من أي مكان**.
المنطق الأصلي من PR #14 (5ada9e3, "feat(pdfValidator): bypass Mistral on
filename-trusted domains when filename score is high") اللي كان بيتخطى Mistral
على مكتبات curated مثل archive.org / bookleaks.com / book-shadow.com لما اسم
الملف يطابق طلب المستخدم بدقة عالية، **سقط أثناء حل تعارض merge** عند دمج
PR موازٍ ("Mistral early-stop"). الدالة الـ helper والـ config بقوا dead code
من حينها.

#### الأثر قبل الإصلاح
كل candidate من archive.org بـ slug name مطابق (e.g.
`archive.org/download/atomic-habits-ar/atomic-habits-ar.pdf` لطلب
"atomic habits") كان يدفع رحلة Mistral كاملة (~3-5 ثانية + تكلفة API)
رغم إن الـ URL وحده يثبت إن الكتاب صحيح. الـ side-effect كمان: بعض
حالات false-negative من Mistral على slugs واضحة كانت ترفض كتب صحيحة.

#### الإصلاح
1. **استعادة الـ call site** في `pdfValidator.ts` قبل الـ Mistral call:
   لما `isFilenameTrustedDomain(pdfUrl)` و `urlFilenameRelevance(...) >=
   MISTRAL_BYPASS_FILENAME_THRESHOLD`، يقبل مباشرة بدون Mistral.
2. **رفع threshold الافتراضي 0.5 → 0.6** كحماية من false-positives على
   استعلامات عربية قصيرة بكلمة مشتركة شائعة:
   - "العقيدة الواسطية" (لابن تيمية) كان يطابق بـ score 0.5 ضد
     `archive.org/.../العقيدة-السفارينية.pdf` (للسفاريني — كتاب مختلف
     تماماً) → كان bypass يطلق ويسلم الكتاب الخطأ. مع 0.6 لازم يكون
     2/3 على الأقل من كلمات الاستعلام موجودة في اسم الملف.
   - الحالات الكلاسيكية لما PR #14 صُمم لها ("atomic-habits", arabic-book-name
     ، "كافكا-على-الشاطئ") تنتج score ≥ 0.67 أو 1.0 → لسه bypass يطلق.

#### counter جديد
- `tel:pdf:filename_trusted_bypass` — يَعُدّ الحالات اللي bypass فيها وفّر
  Mistral call. للمراقبة وتعديل الـ threshold لو لزم.

#### اختبار
- 14 deterministic probes (`test-filename-trusted-bypass.mjs`) تشمل:
  bundle markers، الـ trigger cases الإيجابية، الـ wrong-book guards،
  وعزل النطاق (untrusted domains لا تتخطى أبداً).

---

## [31.9.1] — 2026-05-05

### 🔒 Security — pre_checkout_query validation

**Bug #24 (HIGH)** — كان `pre_checkout_query` يـ approve أي invoice بدون فحص:

```ts
// قبل
await answerPreCheckoutQuery(query.id, true);
```

النتيجة: invoice قديم بسعر مختلف (لو غيّرنا الـ price tier)، أو invoice مُلفَّق
بـ `total_amount` غير الـ canonical 100 stars، أو payload مش `premium:`،
كان يتقبَّل ويعدِّي على `successful_payment` اللي بيدِّي 30 يوم Premium لمجرد إن
الـ payload يبدأ بـ `premium:`. الـ dedup بـ `payment:processed:{chargeId}`
يحمي من duplicate redelivery لكن مش من invoice مزيف.

#### الإصلاح
نتحقق قبل الـ approve من 3 شروط:
1. `payload.startsWith("premium:")`
2. `currency === "XTR"`
3. `total_amount === PREMIUM_STARS_PRICE` (100)

لو فشل أي شرط: نرفض بـ `answerPreCheckoutQuery(false, error_message=...)` —
Telegram يعرض رسالة خطأ واضحة للمستخدم وتنقطع العملية قبل ما توصل لـ
`successful_payment`. كل rejection يـ log + يـ `INCR tel:payment:precheckout_rejected`.

### 📊 Observability — pre_checkout structured logging

**Bug #28 (LOW)** — الـ log القديم كان `{userId}` فقط. لو حد جرَّب replay attack
أو أرسل invoice بسعر شاذ، الـ logs ما تكشفش. دلوقتي:
- approval log: `{ userId, amount, currency, payload }`
- rejection log: `{ userId, amount, currency, payload, reason }`

### 🧪 Tests
- `test-payment-precheckout-validation.mjs` — 18 probes:
  - source-level guards (payload prefix / currency / amount)
  - rejection path: error_message للمستخدم + log + counter
  - approval log includes amount/currency/payload
  - bundle markers (escaped Arabic + counter + check)
  - regression: hardcoded `true` removed

---

## [31.9.0] — 2026-05-05

### 🐛 Fix — Cairo timezone everywhere

كل الـ daily counters/quotas (downloads, summaries, AI calls, Firecrawl credits) و رسالة "متبقي X ساعة" كانت بـ UTC — في حين إن كل اليوزرز في Africa/Cairo (UTC+2 شتاءً، UTC+3 صيفاً مع DST). النتيجة:

- اليوزر الساعة 23:50 القاهرة كان يشوف "متبقي ~5 ساعات" والحقيقة 10 دقايق
- الـ quota row في الـ DB كانت تتحط على تاريخ UTC، فاليوزر اللي شغّال بين 22:00–02:00 القاهرة قد يقع على صفّين (يومين) مختلفين، يمكن نظرياً يستهلك 2× quota
- analytics keys (`stats:daily:{date}`) و AI usage (`ai:usage:{provider}:{date}`) و Firecrawl (`counter:firecrawl:credits:{date}`) كل ده بـ UTC date → الـ daily-rollover يقع 02:00–03:00 القاهرة بدل منتصف الليل

#### الإصلاح

- **`text.ts`** — جديد:
  - `cairoDateString(now?)` يرجع `YYYY-MM-DD` بـ Africa/Cairo (drop-in replacement لـ `new Date().toISOString().split("T")[0]`)
  - `msUntilCairoMidnight(now?)` يحسب الـ ms المتبقية لمنتصف الليل القاهري الـ DST-aware (يستخدم `Intl.DateTimeFormat` بـ `timeZone: "Africa/Cairo"`)
  - `buildResetTime()` معدَّل ليستخدم `msUntilCairoMidnight` بدل `setUTCHours(24,0,0,0)`
- **`storage.ts`** — `getDailyDownloadCount`، `incrementDailyDownload`، `cleanupOldDailyLimits` كلهم بـ `cairoDateString()`
- **`summary.ts`** — `todayKey()` بـ `cairoDateString().replace(/-/g, "")` (YYYYMMDD format)
- **`analytics.ts`** — `todayKey()` و `getWeeklyStats` (آخر 7 أيام بـ Cairo TZ)
- **`aiProviders/registry.ts`** — `todayKey()` للـ AI usage counters
- **`firecrawlParse.ts`** — `trackCredits` للـ Firecrawl credit counter
- **`routes.ts`** — `/api/admin/system/costs` يقرا بـ Cairo date
- **`admin.ts`** — `kholasa_top_books_{date}.csv` filename للاتساق

#### Tests
- `test-cairo-timezone.mjs` — 10 probes (DST summer, winter، midnight rollover، reset countdown sanity، regression check إن UTC-based reset كان فعلاً مختلف عن Cairo)
- 22/22 deterministic tests كلهم PASS
- typecheck + build clean (478.5kb)

#### Migration / Backwards-compat
- مفيش downtime needed: على deploy، الـ keys الجديدة (Cairo date) قد تكون مختلفة عن الـ keys القديمة (UTC date) لمدة 1–3 ساعات (الفرق بين منتصف الليل UTC ومنتصف الليل القاهرة). فعلياً هذا يعني إن اليوزرز اللي حصلوا على download في الـ window ده يمكن يحصلوا على download إضافي في الفترة. ده one-shot effect مرة واحدة عند الـ deploy، وبعدها تطبيع.
- `summary:usage:` keys بنفس الفورمات (YYYYMMDD)، التغيير في القيمة فقط، فالـ key يتجدد بعد 25h TTL تلقائياً.
- `stats:daily:` لو محسوبة بـ UTC قبل الـ deploy، تفضل موجودة لـ 90 يوم. الـ getWeeklyStats بعد الـ deploy يبدأ يقرا Cairo dates، فالـ analytics dashboard ممكن يظهر "زيرو" ليوم الانتقال أو لليوم اللي قبله. مقبول.

---

## [31.8.0] — 2026-05-03

### ✨ Auto-summary trigger — "لخصلي" → ملخص تلقائي بعد الإرسال

الـ `bookNameParser.ts` كان دائماً يجرّد كلمات نية التلخيص (`لخصلي`, `ملخص`, `تلخيص`, `اختصرلي`) من اسم الكتاب — لازم — لكن هذا التجريد كان يضيع إشارة النيّة. كان المستخدم لمّا يكتب "لخصلي أرض زيكولا" يستلم الكتاب، ثم لازم يضغط زر "📘 ملخص الكتاب" ليطلب الملخص الصريح.

#### الـ Logic

1. **detectSummaryIntent(rawBookName)** — جديد في `bookNameParser.ts`. يكشف وجود كلمات النيّة في الرسالة الخام **قبل** ما `parseBookName()` يجرّدها.
2. **commands.ts** — يستدعي `detectSummaryIntent()` على الـ raw book name قبل parsing، ويمرّر `wantsSummary: boolean` لـ `handleBookRequest()`.
3. **QueueJob.wantsSummary** — حقل جديد. يُحفَظ مع الـ job في Redis ويعدّي إلى الـ worker.
4. **maybeAutoSummary()** في bookRequest worker — لو `job.wantsSummary === true` و الإرسال نجح، يستدعي `runSummaryFlow()` بعد `sendSuccessMessage()`.
5. **runSummaryFlow()** — مُستخرَج جديد من `handleSummaryCallback()` (refactor). نفس التدفّق (cache fast-path → quota → placeholder → orchestrator → deliver) لكن لا يحتاج `callbackQueryId`.
6. **Lock idempotency** — auto-trigger يحجز `summary:auto:<userId>:<book>` لمدة 90 ثانية. لو المستخدم ضغط زر "📘 ملخص الكتاب" يدوياً قبل ما الـ auto يخلص، الـ button click يعدّي إلى الـ session lock — الاثنان لا يتداخلان (lock keys مختلفة) لكن الـ cache fast-path في `runSummaryFlow` تمنع double-call على نفس الـ AI.

#### Telemetry جديدة

- `tel:summary:auto_triggered` — counter لكل auto-trigger ناجح (الـ lock تم حجزه)

#### الـ Wiring الكامل

```
user msg "لخصلي أرض زيكولا"
        ↓
commands.ts: detectSummaryIntent(raw) === true
        ↓ wantsSummary=true
handleBookRequest(...) → enqueue(...) → QueueJob{ wantsSummary: true }
        ↓
processBookRequest → serveFromCache OR performFullSearch
        ↓ on success
maybeAutoSummary(bot, chatId, userId, bookName, sourceUrl, true)
        ↓ acquire lock summary:auto:<userId>:<book>  (NX EX 90)
runSummaryFlow → cached? → quota? → placeholder → getBookSummary → deliverSummary
```

#### الـ Probes (29/29)

- G1: bundle markers (`detectSummaryIntent`, `runSummaryFlow`, `maybeAutoSummary`, `wantsSummary`, `summary:auto:`, `tel:summary:auto_triggered`)
- G2: detectSummaryIntent — 14 cases (8 true / 6 false)
- G3: QueueJob round-trip via JSON
- G4: Lock key shape
- G5: Log message markers

#### Backward compat

- المستخدمون اللي يكتبوا اسم الكتاب فقط ("أرض زيكولا") مفيش تغيير — `wantsSummary` يبقى `undefined` و الـ branch ما يدخلش
- الزر "📘 ملخص الكتاب" يبقى في الـ keyboard كالعادة (نفس التدفّق عبر `handleSummaryCallback`)
- الـ `runSummaryFlow` refactor preserves الـ behavior الحالي للـ button click 100%

---

## [31.7.0] — 2026-05-05

### ⚡ توفير Mistral — Strong-filename-match short-circuit

عندما يكون الـ PDF بدون `/Title` metadata قابل للقراءة (شائع في PDFs العربية لأن CIDFont/Type0)، الـ validator كان دائماً يدلّق لـ Mistral للحُكم على المُحتوى. لكن لو كان اسم الملف نفسه يحتوي على كلمات اسم الكتاب بقوّة (مثلاً "كتاب-أرض-زيكولا.pdf" لطلب "أرض زيكولا")، Mistral مش هيضيف معلومة — هو حياكي ما اسم الملف يقوله.

#### الـ Logic

في الـ "no metaTitle" branch بعد الـ meaningless-filename rejection:

1. احسب `urlFilenameRelevance(bookName, filenameHint)` (0–1)
2. لو ≥ **0.70** و الاسم فيه ≥ 6 حرف ألفبائي حقيقي:
   - اقبل مباشرة (`event: candidate_accepted_filename_strong`)
   - زِد counter `tel:pdf:filename_strong_match`
   - **لا** نستدعي Mistral

#### التأثير المتوقّع

من بيانات بروداكشن الـ 5 أيام:
- `tel:pdf:mistral_used = 106`
- `tel:pdf:extract_failed = 67` (PDFs بدون metaTitle قابل للقراءة)

من الـ 67 المستدعاة لـ Mistral بسبب metaTitle empty، التقدير: 30-50% منها أسماء ملفات قويّة المطابقة → توفير **20-35 Mistral call** لكل 5 أيام (~ 3-7/يوم).

كل short-circuit يوفر:
- مكالمة Mistral (~$0.001 + ~3-5s latency)
- تقليل احتمال false-negative من Mistral (مثل ما حصل في PR #31 — Mistral رفضت ملف صحيح بسبب pattern في الـ prompt)

#### الحماية

- العتبة 0.70 (يعني: ≥ 70% من كلمات اسم الكتاب موجودة في اسم الملف)
- شرط ثاني: ≥ 6 حرف ألفبائي حقيقي — يمنع الـ false-positive من أسماء قصيرة
- لا يلمس مسار الـ metaTitle الموجود (المسار الـ "score-based" لسّه شغّال كما هو)
- لا يلمس مسار الـ trusted domains (PR #31/#33 — الـ title-gate لسّه شغّال)
- في حال مفيش filename مطابق → يدلّق لـ Mistral كالمعتاد (سلوك قديم)

#### التغييرات

| ملف | التغيير |
|-----|---------|
| `server/bot/pdfValidator.ts` | event جديد + branch قبل الـ Mistral call |
| `package.json` | bump 31.6.0 → 31.7.0 |
| `test-filename-shortcircuit.mjs` | probes deterministic |

---

## [31.5.0] — 2026-05-05

### 💎 ميزة جديدة — Firecrawl `/parse` كمسار سريع لـ Premium summary

دمجنا Firecrawl `/v2/parse` و `/v1/scrape` كطبقة استخراج نصّ سريعة قبل
الـ AI tier، مفعّلة فقط للمستخدمين Premium. النتيجة: ملخّص أسرع
وأعلى جودة، مع توفير الـ Gemini quota المجاني للمستخدمين العاديين.

#### السلوك القديم (للمستخدمين Premium)

```
طلب الملخّص
  → Wikipedia context
  → Gemini PDF inline (multimodal، 25-45s، يأكل من الـ daily quota)
  → fallback: text-tier (you.com priority 0 + باقي المزوّدين)
```

#### السلوك الجديد

```
طلب الملخّص
  → Wikipedia context
  → [Premium] Firecrawl /parse (5-15s، يستخرج نصّ من الـ PDF)
                     ↓
                 markdown context
                     ↓
  → text-tier (you.com priority 0 + grounded by real PDF text)
```

النتيجة: 25-45s → 8-15s متوسطًا للمستخدمين Premium، وما يستهلكش من
الـ Gemini free tier (1500/day) المخصّص لباقي المستخدمين.

#### التغييرات

| ملف | التغيير |
|------|---------|
| `server/bot/firecrawlParse.ts` | **جديد** — `parsePdfBuffer()` (multipart upload) و `scrapeRemotePdf()` (URL-based) و `buildSummaryContext()` (دمج Wikipedia + Firecrawl) |
| `server/bot/summary.ts` | step 3.5 جديد قبل الـ PDF tier — يفعّل الـ fast-path لو `opts.premium===true` |
| `package.json` | bump 31.4.0 → 31.5.0 |

#### الحماية والـ fallback

- **Quota share**: نفس مفاتيح `FC_QUOTA_EXCEEDED_KEY` و `FC_RATE_LIMITED_KEY`
  المستخدمة في `engine.ts`. لو Firecrawl وقع في 402/429 أثناء البحث،
  الـ /parse path يـ skip تلقائياً.
- **Graceful fallback**: لو Firecrawl فشل لأي سبب (timeout, auth,
  empty response, paused)، الكود يكمل للـ existing PDF tier (Gemini).
  مفيش regression لمستخدم Premium لو Firecrawl نزل.
- **Free users unaffected**: `if (opts.premium && ...)` — المسار الجديد
  مغلق تماماً لغير الـ Premium. الـ free quota محمي.

#### Telemetry

- `tel:summary:firecrawl_used` — عداد للنجاح
- `tel:summary:firecrawl_skipped:<reason>` — عدّاد لكل fallback path:
  - `no_api_key` / `fc_paused` / `too_large` / `http_error` / `rate_limited`
  - `quota_exceeded` / `auth_error` / `empty_response` / `timeout` / `exception`
- `counter:firecrawl:credits:{date}` — يكتب الآن لكل /parse و /scrape
  call (5 و 1 credits على التوالي)، مما يجعل dashboard التكلفة دقيق.

#### الإعدادات

- `FIRECRAWL_PARSE_MAX_BYTES = 18 MB` — يطابق `PROVIDER_MAX_PDF_BYTES`
- `TIMEOUT_FC_PARSE = 60_000` ms (للـ /parse)
- `TIMEOUT_FC_SCRAPE_PDF = 45_000` ms (للـ /scrape PDF)
- `FIRECRAWL_CONTEXT_MAX_CHARS = 24_000` — حدّ على الـ context المرسَل
  لمزوّد النصّ، يتفادى تجاوز input limits

---

## [31.4.0] — 2026-05-05

### ✨ ميزة جديدة — مصدر `mktbtypdf.com` (مكتبتي PDF)

أضفنا موقع **مكتبتي PDF** (`mktbtypdf.com`) كمصدر #14 في `ARABIC_SOURCES`.
الموقع يحتوي على آلاف الكتب والروايات العربية والمترجمة، وهو الأكثر تحديثاً
في الفترة الأخيرة من بين مصادرنا.

#### كيف يعمل الـ resolver

`mktbtypdf.com/book/<slug>/` صفحة هبوط HTML — زرّ التحميل بيوصّل لـ
`mktbtypdf.com/download?id=<n>&external=1`، اللي بيعمل:

1. `301 Moved Permanently` لـ `/download/?id=<n>&external=1` (slash إضافي)
2. `302 Found` لـ `drive.usercontent.google.com/download?id=<gid>&export=download`
3. الاستجابة النهائية: PDF حقيقي من Google Drive (Content-Type
   `application/octet-stream`، أول bytes `%PDF-1.x`).

`expandMktbtypdfUrl()` في `download.ts` يفتح صفحة الكتاب مرة واحدة، يستخرج
الـ id من الـ HTML بـ regex، ويرجع رابط `/download/?id=<n>&external=1`
(بـ trailing slash لتجنّب الـ 301 hop). الـ `fetch(redirect: "follow")` بيمشي
مع باقي الـ chain تلقائياً للوصول للـ PDF النهائي.

#### تكامل مع الـ pipeline الموجودة

- `sources.ts:125-133` — مدخلة جديدة في `ARABIC_SOURCES` بأولوية 14.
- `download.ts:45` — مضاف لـ `SKIP_DIRECT_DOMAINS` لأن صفحات الـ landing
  لا تخدم PDF مباشرة (Telegram direct-send سيفشل).
- `download.ts:362-407` — `expandMktbtypdfUrl()` بنفس نمط
  `expandFoulabookUrl()` (timeout 10s، AbortController، logging).
- `download.ts:457-467` — wiring في `downloadAndSend` بعد الـ foulabook
  resolver، قبل blacklist check و pdfValidator.

#### ملاحظة على `sahm-book.com`

تم النظر فيه أيضاً (لكن لم يُضَف) لأن التحميل يمر عبر قناة Telegram داخلية،
فلا يصلح للاستخراج المباشر بدون خادم Telegram-API client. لو لاحقاً قُرر
استخدامه كـ "fallback links source"، يمكن إضافته بدون resolver (سيرجع
صفحات HTML فقط — لن يخدم كـ PDF source).

---

## [31.3.19] — 2026-05-05

### 🐛 إصلاح حرج — كتب مجانية كانت تُصنَّف "مدفوعة" خطأً (`classifyAccess` over-matching)

في `server/bot/engine.ts:172-176` الـ `PROTECTED_ACCESS_PATTERNS` كانت بتطابق كلمات مفردة عامة جداً — `premium`, `subscribe`, `subscription`, `price`, `paid`, `checkout`, `حقوق النشر`, `شراء/اشتر بدون context` — كلها بتظهر طبيعياً في UI لمواقع كتب مجانية تماماً:

- "Subscribe to our newsletter" في صناديق التسجيل
- "Premium membership" أو "Premium account" في banners حتى للمواقع المجانية
- "حقوق النشر محفوظة" في footer كل صفحة
- "اشتراك" يبدأ بـ "اشتر" → يطابق pattern الشراء
- "السعر العادل" في كتاب اقتصادي

لما أي كلمة منهم تظهر في صفحة (حتى لو الكتاب مجاني تماماً)، الـ regex بيلوّن النتيجة `protected_page`. وفي `bookRequest.ts:897` لو download فشل لأي سبب (PDF تالف، URL محجوب، Firecrawl لقى لكن download ما اشتغلش)، الرسالة `buildPaidBookMessage` بتتبعت دايماً، فالمستخدم يستلم "كتاب مدفوع" لكتاب مجاني تماماً.

**مثال واقعي:** المستخدم بحث عن "علمتني سورة البقرة". الكتاب موجود مجاناً على `kutubm.com/down/?id=13917` (ضمن المصادر المعتمدة). Firecrawl لقى الصفحة، لكن لأن الصفحة فيها "اشتراك" أو "Premium" في sidebar، النتيجة اتعلّمت `protected_page` → الـ download فشل → الرسالة "هذا الكتاب مدفوع" → المستخدم بياخد انطباع غلط إن البوت ما بيشتغلش.

**الإصلاح:**

1. **تشديد `PROTECTED_ACCESS_PATTERNS`** — 4 patterns متخصصة بدل 3 عامة:
   - **Action verbs مع context صريح** (Arabic): `شراء الكتاب`, `اشتر الآن`, `أضف إلى السلة`, `نفدت الكمية`, `غير متوفر مجاناً`, إلخ — مش `شراء` لوحدها (تظهر في كتب اقتصادية مثلاً).
   - **Action verbs مع context صريح** (English): `buy now`, `add to cart`, `out of stock`, `proceed to checkout`, `complete your purchase`, `paid only/content/version` — مش `paid` لوحدها (تظهر في "highly paid", "paid leave").
   - **Price tags فعلية** — currency symbol أو ISO code + رقم، مع currency abbreviations عربية (`ر.س`, `ج.م`, `د.ك`, `ريال`, `دينار`, إلخ). أقوى إشارة على إن الصفحة بتبيع.
   - **Read-only signals صريحة** — `قراءة فقط`, `للاطلاع فقط`, `لا يسمح بالتحميل`, `غير قابل للتنزيل`, `read-only access`, `preview only N pages`. مش `قراءة أونلاين` لوحدها (مكتبات مجانية كتير بتعرض هذه الميزة).

2. **رفع threshold الـ classifyAccess** — لازم تتطابق على الأقل **2 patterns مختلفة** عشان النتيجة تتعلّم `protected_page`. صفحة فيها "buy now" بس في زر شراء كتاب مختلف في sidebar مش كافية.

3. **رسالة الفشل التكيُّفية** في `bookRequest.ts` — لما الـ download يفشل:
   - `paidSignalCount >= max(2, ceil(results.length × 0.4))` → رسالة "كتاب مدفوع" (high-confidence)
   - أقل من كده → `buildNoResults(bookName)` (رسالة "لم أجد PDF" الأمينة + اقتراحات)
   - الـ counter `tel:dl:fail_paid_signal` و `tel:dl:fail_no_signal` بيـ track النسبة في production.

**اختبار:** 12 سيناريو في `test-classify-access-false-positive.mjs`:
- 8 صفحات كتب **مجانية** فيها كلمات UI خادعة (premium upsell, اشتراك في النشرة, copyright footer, "السعر العادل" في كتاب اقتصادي) — كلهم passed (0 أو 1 hit ≤ threshold).
- 4 صفحات كتب **مدفوعة** فعلية (price + buy now, out of stock + price, read-only + غير متوفر, Amazon-like page) — كلهم passed (≥ 2 hits).

**التأثير:** قبل الإصلاح، كل كتاب مجاني فشل تحميله (لأي سبب) كان بيتم تصنيفه "مدفوع". بعد الإصلاح:
- false positives بتقل بشكل كبير جداً
- المستخدم لما الـ download يفشل بيستلم رسالة دقيقة (مدفوع فعلاً vs. لم يجد)
- الميتركس الجديدة تساعد admins في رصد الـ paid-detection accuracy

---

## [31.3.18] — 2026-05-05

### 🐛 إصلاح مالي حرج — `successful_payment` ممكن يمنح Premium مرتين لدفعة واحدة

في `server/bot/commands.ts` الـ `bot.on("message", ...)` كان بيـ handle حدث `msg.successful_payment` (دفع Telegram Stars الناجح) من غير أي idempotency:

```ts
if (msg.successful_payment) {
  ...
  if (payload.startsWith("premium:") && userId) {
    await setPremium(userId, true, 30, {...});  // ← يُمدّد TTL بـ 30 يوم
    await bot.sendMessage(chatId, "🎉 تم تفعيل Premium بنجاح!", ...);
  }
  return;
}
```

**ليه ده bug فعلي:**

1. `setPremium(uid, true, 30, ...)` بـ days>0 بيقرأ الـ TTL الحالي ويـ extend بـ 30 يوم. مش replace — `userSettings.ts:128-147`:
   ```ts
   const remainingSec = currentTtl > 0 ? currentTtl : 0;
   const newTtlSec    = remainingSec + days * 24 * 3600;  // ← additive
   ```

2. البوت بيشتغل بـ `polling: true` (`server/bot/index.ts:89`). NTBA polling offset محفوظ **في الذاكرة فقط** — مفيش persistence على disk أو Redis.

3. السيناريوهات اللي بتسبب redelivery لنفس الـ `successful_payment` update:
   - **Bot crash** بين معالجة الـ payment و الـ `getUpdates` التالي. على restart، NTBA بيـ poll من offset جديد (وفي بعض الأحيان من 0)، فالـ Telegram بيرجّع نفس الـ payment update تاني (Telegram بيحتفظ بالـ updates لمدة 24h).
   - **Multi-instance race**: لو الـ deploy ما عملش shutdown صحيح للـ instance القديم وفيه instance جديد بيشتغل، الاتنين هيشوفوا نفس الـ payment.
   - **Telegram retries**: لو الـ bot's HTTP response timed out (نادر بس وارد)، Telegram ممكن يـ retry الـ delivery.

4. النتيجة: مستخدم دفع مرة واحدة (مثلاً 100 Stars) → بياخد **60 يوم** بدل 30 يوم. خسارة إيرادات حقيقية + عدم اتساق المنطق المحاسبي.

**الإصلاح:**

استخدام `redis.set(key, value, "EX", ttl, "NX")` على المفتاح `payment:processed:<telegram_payment_charge_id>`. الـ `telegram_payment_charge_id` فريد لكل عملية دفع (Telegram بتضمن ده في الـ Bot Payments API).

```ts
const chargeId = msg.successful_payment.telegram_payment_charge_id || "";
let alreadyProcessed = false;
if (chargeId) {
  const acquired = await redis.set(
    `payment:processed:${chargeId}`,
    String(Date.now()),
    "EX", 90 * 24 * 3600,
    "NX",
  ).catch(() => null);
  alreadyProcessed = acquired !== "OK";
}

if (!alreadyProcessed) {
  await setPremium(userId, true, 30, {...});
} else {
  L.warn("payment", "Duplicate successful_payment redelivered — premium NOT re-granted", {...});
  redis.incr("tel:payment:duplicate_redelivery").catch(() => {});
}

// رسالة النجاح بتترسل في الحالتين
await bot.sendMessage(chatId, "🎉 تم تفعيل Premium بنجاح!", ...);
```

**قرارات تصميمية مهمة:**

- **TTL = 90 يوم** للمفتاح: أطول بكتير من أي retry معقول من Telegram أو من crash recovery، وأقصر من إن نخلّيه دائم (يحفظ ذاكرة Redis). الاحتمال إن يحصل redelivery لـ payment حقيقي بعد 90 يوم تقريباً صفر.
- **رسالة النجاح بترسل في الحالتين**: لو الـ retry حصل لأن الرد الأصلي ضاع، المستخدم لازم يشوف confirmation تاني — ده تجربة المستخدم الصح. الـ idempotency بس على الـ DB write (الـ premium grant)، مش على رسالة الـ UI.
- **`SET ... NX` atomic**: مفيش race بين فحص الـ existence والـ write — Redis بيضمن atomicity.
- **Telemetry counter `tel:payment:duplicate_redelivery`**: نقدر نشوف من الـ dashboard لو ده بيحصل فعلاً في الـ production، ونفهم تكراره.
- **Defensive: لو `chargeId` فارغ** (ما يحصلش لـ Stars بس defensive)، بنـ skip الـ dedup ونـ fall back للسلوك الأصلي (no regression).

**تأثير:** يمنع double-grant على كل payment من اليوم اللي بيتنشر فيه. الـ payments السابقة اللي حصل لها double-grant بالفعل (لو حصل) ما هتتعدلش — بس ما هيحصلش تاني.

**تأكيد سلامة سلوك non-Stars (مفيش حالياً):** الـ check `payload.startsWith("premium:")` يمنع منح Premium لأي invoice بـ payload مختلف. مفيش تغيير في ده.

**اختبار:** `test-payment-idempotency.mjs` (13 probes) بتـ verify:
- الـ chargeId بيتقرأ صح من الـ event
- الـ dedup key namespace صحيح (`payment:processed:`)
- SET NX بيتستخدم بشكل atomic
- `setPremium` مرة واحدة بس (no double-grant path)
- رسالة النجاح بترسل في الحالتين
- Logging و metrics للـ duplicate path
- TTL ≥ 30 يوم (90 يوم في النسخة الحالية)
- Empty chargeId بيـ skip الـ dedup بشكل صحيح (no regression)

15/15 test files pass، tsc نظيف، build 457.3 kb.

---

## [31.3.17] — 2026-05-05

### 🧹 تنظيف — حذف 3 نداءات `invalidateRecentSearchesCache()` ميتة في `bookRequest.ts`

في `server/bot/engine.ts:62-68` الدالة:

```ts
export function invalidateRecentSearchesCache(bookName?: string): void {
  if (!bookName) return;          // ← early-return لو ما فيش argument
  const key = searchCacheKey(bookName);
  redis.del(key).catch(() => {});
  const normalizedKey = searchCacheKey(normalizeForCache(bookName));
  if (normalizedKey !== key) redis.del(normalizedKey).catch(() => {});
}
```

كان فيه 3 نداءات في `bookRequest.ts` (سطور 384، 414، 833) بدون أي argument:

- `bookRequest.ts:384` — مسار نجاح cache hit بـ `telegramFileId`
- `bookRequest.ts:414` — مسار نجاح cache hit بـ `sourceUrl`
- `bookRequest.ts:833` — مسار نجاح بحث كامل + تحميل + إرسال

النداءات الـ 3 دي كانت **no-ops تماماً** — الـ early-return بيخرج بدون عمل أي شيء. فحص git history (`git log -G '_recentInvalidated'`) أكد إن:

1. النسخة الأصلية للدالة كانت `_recentInvalidated = Date.now()` — flag global ما حدش قراه أبداً (write-only).
2. PR #62 غيّر الدالة لتعمل `redis.del` مع `bookName` المُمرَّر، لكن الـ 3 نداءات في `bookRequest.ts` ما اتـ updated.
3. الـ flag الأصلي كان (في الأرجح) للـ dashboard's recent-searches cache اللي إما اتشال أو اتنقل لمكان تاني — مفيش قارئ ليه في الكود الحالي.

**ليه ما عملناش fix بإضافة `bookName` للنداءات بدل الحذف؟** لأن المسارات الـ 3 كلها مسارات **نجاح**:

- في cache-hit، الـ Redis search cache هو اللي بيخدم عمليات بحث المستخدمين القادمين — حذفه هيرغم Firecrawl re-search وقت ما الكاش لسه شغال صح.
- في fresh download، لسه كتبنا الكاش لتوّه (`engine.ts:122-123`) — حذفه فوراً يلغي فايدة الكاش بالكامل.

يعني الـ correct behavior في المسارات الـ 3 هو **عدم حذف الكاش** — وده اللي بيحصل فعلاً (لأن الـ no-arg call هو no-op). فالحل الـ minimal هو حذف الـ dead calls + تنظيف الـ import.

**التأثير:** كود أنظف. مفيش تغيير في السلوك — الـ no-ops كانت no-ops، فحذفها مكافئ تماماً.

**النداء الوحيد المتبقي والصحيح:** `callbacks.ts:313` في `bad_file:` handler، بيمرّر `entry.bookName` صح. ده اللي اتـ-installed في PR #62 وبيشتغل بشكل سليم.

**اختبار:** إضافة `test-no-noop-cache-invalidation.mjs` (8 probes) بتـ verify:
- `bookRequest.ts` ما فيهاش أي نداء لـ `invalidateRecentSearchesCache`
- الـ import من `engine.js` فيه `isFirecrawlDown` بس
- الدالة لسه مُصدَّرة من `engine.ts` للنداء الصحيح في `callbacks.ts`
- الـ early-return guard مازال موجود في الدالة (دفاع في العمق)
- النداء الصحيح في `callbacks.ts` (مع `entry.bookName`) ما اتأثرش
- مسارات النجاح الـ 3 في `bookRequest.ts` لسه بتنده `logSearch` و `setLastBook` (تليمتري حقيقية ما اتشالش)

---

## [31.3.16] — 2026-05-05

### 🐛 إصلاح — `summaryHandler` بيستهلك من حد الملخصات اليومي حتى لو الـ AI فشل

في `server/bot/summaryHandler.ts:110` نداء `checkAndConsumeUsage(userId, premium)` بيـ increment الـ counter اليومي للمستخدم (`summary:usage:<uid>:<date>`) **قبل** أي محاولة لتوليد الملخص.

بعد كده الـ orchestrator `getBookSummary()` بيشتغل، وممكن يـ throw في عدة حالات:

1. **`GlobalSummaryLimitError`** — البوت وصل للحد اليومي العام للـ AI، ومفيش Wikipedia extract يصلح كـ fallback.
2. **All providers exhausted** — Gemini/Groq/Cerebras/Cloudflare كلهم رجعوا أخطاء (rate limit upstream، timeouts، إلخ).
3. **Cap-hit + no Wikipedia** — العداد العالمي اتخطى لكن `wiki?.extract` قصير أو غير موجود.

في كل الحالات دي، الـ catch في `summaryHandler` بيعرض رسالة خطأ للمستخدم — لكن الـ counter اليومي بتاعه فضل مرتفع. مستخدم بـ 4/5 ملخصات مستهلكة بيدوّر على ملخص → الـ AI يفشل (لسبب خارج عنه) → بيشوف رسالة خطأ → يحاول كتاب تاني → يلاقي `وصلت إلى حد الملخصات اليومي`. بيدفع بكوتاه على شيء مفيش له لازمة.

**التأثير:** المستخدمون مش premium بيخسروا حصتهم اليومية بسبب أخطاء البنية التحتية. أيام شغل الـ AI providers بتكون متذبذبة (rate limits متفاوتة، quota متراكمة من users تانيين)، الـ users بيشتكوا "ما بقدرش أعمل ملخص".

**الإصلاح:**

1. تصدير دالة جديدة `refundUserSummaryUsage(userId, premium)` في `summary.ts` بتعمل `DECR` على نفس الـ key. `premium` و `SUMMARY_DAILY_LIMIT_FREE <= 0` بتعمل early-return عشان no-op على الـ users اللي مش بيتم احتساب كوتا عليهم.

2. في `summaryHandler.ts`، رفع `premium` و `usageConsumed` لخارج الـ try block عشان يكونوا مرئيين في الـ catch. الـ flag `usageConsumed` بيتعمل `true` بس لما `checkAndConsumeUsage` يرجع `blocked=false` (يعني فعلاً اتـ-incremented).

3. الـ catch بقى ينده `refundUserSummaryUsage(userId, premium)` (fire-and-forget مع `.catch()`) قبل ما يعرض رسالة الخطأ. لو `usageConsumed=false` (مثل: cache hit، أو blocked مسبقاً)، مفيش refund.

ملحوظة: الـ wikipedia-fallback (سطور `summary.ts:267-282`) بيعتبر **نجاح** ويرجع `SummaryResponse` — المستخدم بيستلم محتوى مفيد فعلاً، فبيتم احتسابه (مفيش refund). المهم إن الـ refund بيحصل بس على المسارات اللي بتـ throw فعلاً.

**اختبار:** إضافة `test-summary-refund.mjs` (12 probes) بتـ verify:
- الـ helper موجود ومُصدَّر بالتوقيع الصحيح
- early-return للـ premium/disabled-cap
- الـ handler بيـ import الـ helper
- الـ flags `premium` و `usageConsumed` مرفوعين خارج الـ try
- `usageConsumed` بيتعمل `true` بس لما الـ consume ينجح (`!usage.blocked`)
- الـ catch بينده الـ refund بـ fire-and-forget pattern
- الـ refund داخل الـ catch (مش الـ finally، عشان ما يـ refund بعد المسار الناجح)

---

## [31.3.15] — 2026-05-05

### 🐛 إصلاح حرج (security/limit-bypass) — `ipRateLimit` كان يولّد member متطابق في كل EVAL

في `server/bot/ipRateLimit.ts:24` كان فيه:

```lua
redis.call("ZADD", key, now, tostring(now) .. "-" .. tostring(math.random(1, 1000000)))
```

**المشكلة**: Redis بيـ reset الـ Lua RNG seed قبل **كل** EVAL عشان السكربتات تفضل deterministic للـ replication ([Redis docs](https://redis.io/docs/latest/develop/programmability/eval-intro/)). معنى ده إن `math.random(1, 1000000)` بترجع نفس الرقم في كل invocation. 

**التأثير على الحماية الفعلية:**

تخيّل سيناريو هجوم مع طلبات متزامنة على `/api/search`:
- request A و request B وصلوا في نفس الـ millisecond من نفس الـ IP.
- الاتنين بياخدوا نفس `now` و نفس `math.random()` → نفس الـ ZSET member: `"<now>-<same_rand>"`.
- request A: `ZCARD = 0 < 20`، يضيف member جديد، يرجع 1 ✓
- request B: `ZCARD = 1 < 20`، يحاول يضيف **نفس** الـ member → `ZADD` is no-op، يرجع 2 لكن الـ ZSET لسه فيه entry واحد فقط.

في النافذة (60s)، أقصى ما يقدر يضيفه الـ ZSET هو entry واحد لكل millisecond مهما كان عدد الـ requests في نفس الـ ms. يعني الحد الأقصى الفعلي = 60,000 طلب/دقيقة بدل الـ 20 طلب/دقيقة المُعلَن. **bypass بنسبة 3000×** على concurrent burst.

ده مش مشكلة على الـ bot Telegram نفسه (مش web-facing مباشرة، الـ rate limit هنا للـ HTTP API endpoints على dashboard/public). لكن `/api/search` بتستهلك Firecrawl quota — burst attack من نفس الـ IP بيقدر يستنزف الـ quota في ثواني.

**الإصلاح:** نفس النمط المطبَّق في `rateLimit.ts:30` (للـ user-level rate limit): توليد الـ random في Node.js (Math.random ← system-seeded) وتمريره كـ `ARGV[4]`. كده كل EVAL عنده rand فريد، والـ ZSET member يبقى unique لكل request حتى لو الـ `now` متطابق.

```lua
local rand = ARGV[4]
…
redis.call("ZADD", key, now, tostring(now) .. "-" .. rand)
```

**اختبار:** إضافة `test-iprate-lua-rand.mjs` (5 probes) بتـ verify إن الـ Lua source ما بيـ call `math.random()` تاني، وإن الـ Node call site بيمرّر 4th ARGV.

---

## [31.3.14] — 2026-05-05

### 🐛 إصلاح — `warmRelatedCache` ما كانش بيشتغل أصلاً (truthiness bug على array)

في `suggestions.ts:719-727` كان فيه:

```ts
const cached = await getSearchCacheResults(book);
if (!cached) {
  await searchAllSources(book);
  L.info("suggestions", `Warmed cache for: ${book.slice(0, 50)}`);
}
```

`getSearchCacheResults` بترجع `Promise<BookResult[]>` دايماً (ولو الكاش فاضي بترجع `[]`، ما بترجعش `null`). يعني `!cached` كان `false` على طول، والـ branch جوّاه ما كانش بيتنفّذ أبداً.

النتيجة: `warmRelatedCache` كانت **dead code** بالكامل من غير ما حد ياخد باله. الـ helper ده مفروض يـ warm 3 كتب من نفس التصنيف بعد كل تحميل ناجح، عشان لما يبحث مستخدم تاني عن كتاب من نفس التصنيف يلاقي النتايج جاهزة في الكاش.

**الإصلاح:**
1. إضافة helper جديد في `engine.ts` اسمه `hasRecentSearchCache(query)` — بيستخدم `redis.exists(searchCacheKey(query))`، فبيرجع `true` لو فيه أي entry (HIT أو MISS) — مش بس HIT.
2. تغيير الـ check في suggestions.ts من `if (!cached)` إلى `if (await hasRecentSearchCache(book)) continue;`.

السبب وراء استخدام `EXISTS` بدل `length === 0`: بعد PR #68 (TTL fix)، النتايج الفاضية (`[]`) بتتـ cache لمدة 5 دقايق كـ MISS. لو استخدمت `length === 0`، كنت هكرر الـ Firecrawl call على query MISS كل ما الـ helper يتنده — هدر بدون فايدة. `EXISTS` بيحترم سلوك الـ engine (HIT 1h، MISS 5min) فالـ warming بيفضل bounded.

**الأثر على الميزانية:**
- لكل تحميل ناجح: في أسوأ احتمال 3 نداءات Firecrawl خلفية (لو الـ 3 كتب المختارة عشوائياً مش متخزنة).
- بعد الكاش يمتلئ: معظم الـ warming attempts بتبقى no-op (HIT مَخزّنة).
- الـ Firecrawl quota guard في `searchAllSources:91-96` بيمنع الاستدعاءات لما الـ quota تتعدى — مش هيستهلك أكتر من اللازم.

---

## [31.3.13] — 2026-05-05

### ⚡ تحسين أداء — `redis.keys()` → `scanKeys()` في endpoint التكلفة بالـ dashboard

`/api/admin/system/costs` كان فيه نداءَين متوازيين لـ `redis.keys()`:

```ts
redis.keys(`counter:firecrawl:credits:${month}*`)
redis.keys(`counter:ai:*:${month}*`)
```

نفس المشكلة اللي اتعالجت في PR #58 و PR #61: الأمر `KEYS` بيحجب الـ Redis event loop على كامل الـ keyspace (O(n) بغض النظر عن الـ pattern). على Redis للبوت بآلاف المفاتيح (cache search، daily limits، sessions، premium TTLs، rate limits)، كل فتح للـ dashboard من admin بيمنع الأوامر المتزامنة لمدة 5–50ms — ويأثر على البوت في نفس اللحظة لو فيه users بيبحثوا.

**الإصلاح:** استخدام helper `scanKeys()` المعرّف في `redis.ts` (بنفس الطريقة المستخدمة في analytics و queue). `SCAN` بيقسّم العمل على دفعات (`COUNT 200`) فبيخلي الـ event loop يخدم أوامر تانية بين الدفعات.

**التأثير:**
- لما admin يفتح cost dashboard: ما بيحصلش stalls في معالجة الـ search/download requests للمستخدمين العاديين
- متاح للتوسّع: لو الـ counter keys زادوا بمرور الشهور، الأداء بيفضل ثابت

**ملاحظة:** الـ counter keys المعنية (`counter:firecrawl:credits:*`, `counter:ai:*:*`) حالياً مش بيُكتب فيها من أي مكان في الكود — مش feature مكتمل. لكن السلوك على Redis نفسه (KEYS scan على كل keyspace) موجود فعلاً ومستحق الإصلاح بمعزل عن إكمال الـ counters لاحقاً.

---

## [31.3.12] — 2026-05-04

### 🐛 إصلاح حرج — `SEARCH_CACHE_TTL` كانت بالـ milliseconds لكن بتُمرَّر لـ `setex` (يقبل ثواني)

السياق: في `config.ts` كان فيه:
```ts
// ── Cache TTLs (ms) ───────────────────────────
export const SEARCH_CACHE_TTL_HIT     = 3_600_000;  // 1 hour
export const SEARCH_CACHE_TTL_MISS    = 300_000;    // 5 minutes
```
الـ header annotation بيقول `(ms)` والقيم متطابقة مع milliseconds (3,600,000ms = 1h)، لكن الاستخدام في `engine.ts:110, 112` هو `redis.setex(key, ttl, value)` — والـ `setex` في ioredis (و Redis نفسه) بياخد **ثواني** فقط (تأكدت من النوع في `node_modules/ioredis/built/utils/RedisCommander.d.ts`: `setex(key, seconds: number | string, value, ...)`).

التأثير الفعلي:
- **Hit cache**: 3,600,000 ثانية ≈ **41 يوم** بدل 1 ساعة. النتايج الناجحة بتفضل في cache شهر+ بعد أول بحث، فلو URL اتـ blacklist، أو مصدر اتـ disable يدوياً، أو الـ ranking اتغيّر، التحسينات بتاخد أسابيع عشان تـ propagate.
- **Miss cache**: 300,000 ثانية ≈ **3.5 يوم** بدل 5 دقايق. أخطر بكثير: استعلام رجع بدون نتايج بيـ cache كـ `[]` لـ 3.5 يوم. لو Firecrawl ما لقاش الكتاب أول مرة (بسبب transient issue، أو لأن الكتاب ما كانش متاح وقتها)، أي مستخدم تاني يـ search نفس الاستعلام في الـ 3.5 يوم اللي جايين هيشوف "لم أعثر على هذا الكتاب" بدون أي بحث حقيقي — حتى لو الكتاب موجود فعلاً.

الإصلاح: تغيير القيم لتطابق وحدة `setex` (ثواني):
```ts
export const SEARCH_CACHE_TTL_HIT     = 3_600;      // 1 hour
export const SEARCH_CACHE_TTL_MISS    = 300;        // 5 minutes
```
+ تحديث الـ header annotation من `(ms)` إلى `(seconds; consumed by redis.setex)`. دلوقتي الـ TTL الفعلي في Redis مطابق للنية.

ملاحظة على الانتشار: الـ keys اللي اتكتبت في Redis قبل النشر هتفضل بالـ TTL القديم (41 يوم/3.5 يوم) لحد ما تنتهي طبيعياً أو تُمسح. عشان ينتقل البوت للسلوك الصحيح فوراً ممكن نعمل `redis-cli --scan --pattern 'sc:*' | xargs redis-cli del` على السيرفر بعد النشر (اختياري).

---

## [31.3.11] — 2026-05-04

### 🐛 إصلاح صحة — "ملف خاطئ؟" ما كانش بيمسح الـ search cache فعلياً

السياق: في `engine.ts` الـ search cache key يتولّد بـ `searchCacheKey(q) = "sc:" + canonicalizeForCache(q)` (`canonicalizeForCache` = `cleanSearchQuery` ثم `normalizeForCache`، يعني بيشيل كلمات الحشو زي "تحميل/كتاب/pdf" قبل الـ normalize). لكن في `callbacks.ts` معالج زر "⚠️ ملف خاطئ؟" كان بيحذف الـ cache بـ `redis.del("sc:" + normalizeForCache(entry.bookName))` بدون `cleanSearchQuery` — يعني المفتاحَين مش بيتطابقوا لو `entry.bookName` بقى فيه أي filler جوّاه.

التأثير الفعلي على المستخدمين:
- مستخدم يستلم ملف غلط ويضغط "⚠️ ملف خاطئ؟" → البوت يضيف الـ URL للـ blacklist ويحذف الـ DB cache row، لكن الـ Redis search cache ما بيتمسحش لأن المفتاح غلط.
- المستخدم التالي اللي يدوّر بنفس الاستعلام (في حدود الـ 1h TTL) يستلم نفس الملف الغلط من الـ Redis cache مرة تانية، رغم إن الـ blacklist قاعدة تشتغل (هنا الـ cache بيتجاوز الـ blacklist filter لأنه نتيجة كاملة محفوظة).
- البوت بيـ log "Cache cleared for bad file" فالـ admin يفترض إن الـ invalidation اشتغلت.

الإصلاح: في `callbacks.ts` نستدعي `invalidateRecentSearchesCache(entry.bookName)` المُصدَّر من `engine.ts` (الـ source of truth لتوليد المفتاح). الدالة دي بتستخدم نفس `searchCacheKey` ومحصّنة بفايل-سيف يجرّب الـ key من الاستعلام الأصلي ومن نسخة `normalizeForCache` كمان عشان تغطي حالات النقل/إعادة التشكيل القديمة.

سبب اختيار النداء بدل تكرار توليد المفتاح: لو فيا تنوّع في صيغة المفتاح في المستقبل، الـ engine module يفضل المرجع الوحيد، فأي تغيير في `searchCacheKey` يلتقط الـ invalidation تلقائياً.

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

