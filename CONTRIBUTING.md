# دليل المساهمة — Contributing Guide

شكراً لاهتمامك بالمساهمة في **خلاصة الكتب**! هذا الدليل يشرح كيف تساهم بشكل فعّال.

---

## 🚀 البداية

### 1. Fork وClone

```bash
git clone https://github.com/your-username/kholasa-books-bot.git
cd kholasa-books-bot
git remote add upstream https://github.com/original-owner/kholasa-books-bot.git
```

### 2. تجهيز البيئة

```bash
npm install
cp .env.example .env
# عدّل .env بقيم التطوير
npm run db:push
npm run dev
```

### 3. إنشاء Branch

```bash
git checkout -b feat/your-feature-name
# أو
git checkout -b fix/bug-description
```

---

## 📐 معايير الكود

### TypeScript

- **Strict mode** مفعّل — لا `any` إلا بعذر موثق في تعليق
- كل function تُصدَّر لها return type صريح
- أسماء واضحة بالإنجليزية، التعليقات بالعربية

```typescript
// ✅ صح
export async function getUserDailyLimit(userId: string): Promise<number> {
  // نُعيد الحد الافتراضي لو Redis فشل
  try { ... } catch { return DAILY_LIMIT; }
}

// ❌ خطأ
export async function getLimit(id: any) {
  return await redis.get(id);
}
```

### تسمية الملفات والثوابت

```
camelCase     → functions, variables
UPPER_SNAKE   → constants في config.ts
PascalCase    → Types, Interfaces
kebab-case    → file names (لو أُضيفت ملفات جديدة)
```

### Redis Keys

اتّبع نمط `prefix:entity:id`:
```
rl:dl:{userId}          rate limit download
rl:sr:{userId}          rate limit search
queue:high              high priority queue
premium:users           premium set
ulimit:{userId}         user daily limit override
```

---

## 🧪 الاختبار

قبل أي Pull Request:

```bash
# تحقق من TypeScript
npx tsc --noEmit

# تحقق من البناء
npm run build

# اختبار يدوي
npm run dev
# جرب: /start، /search كتاب، /premium، /stats
```

---

## 📝 Pull Request

### Checklist

- [ ] الكود يمر على `tsc --noEmit` بدون أخطاء
- [ ] `npm run build` ينجح
- [ ] لا `console.log` — استخدم `L.info/warn/error`
- [ ] كل Redis key يتبع نمط المشروع
- [ ] أي ثابت جديد يُضاف لـ `config.ts`
- [ ] CHANGELOG.md مُحدَّث
- [ ] الوصف يشرح المشكلة والحل

### صيغة Commit

```
feat: إضافة دعم تجديد Premium تلقائي
fix: إصلاح double answerCallbackQuery في premium_buy
perf: استبدال 7 Redis calls بـ pipeline واحد
refactor: نقل buildResetTime لـ text.ts
docs: تحديث README بقسم Telemetry
```

---

## 🐛 الإبلاغ عن مشكلة

افتح Issue مع:

1. **وصف المشكلة** — ماذا حدث؟
2. **خطوات التكرار** — كيف أعيد المشكلة؟
3. **السلوك المتوقع** — ماذا يجب أن يحدث؟
4. **البيئة** — Node.js version، OS، Docker version

---

## 💡 طلب ميزة

افتح Issue من نوع `Feature Request` مع:

1. **المشكلة التي تحلها** — لماذا هذه الميزة مهمة؟
2. **الحل المقترح** — كيف تتخيل تنفيذها؟
3. **بدائل راجعتها** — هل في طرق أخرى؟

---

## 📄 الترخيص

بمساهمتك، توافق على أن كودك يخضع لنفس [رخصة المشروع](./LICENSE).
