// ══════════════════════════════════════════════════════════════════
// UI VARIANTS — pools of varied messages so the bot doesn't feel
// repetitive across multiple book requests. All long-form Arabic
// messages (especially wait/reassurance) are written in formal
// Modern Standard Arabic (الفصحى) at the user's request — no
// Egyptian or Gulf dialect.
// ══════════════════════════════════════════════════════════════════

// ── helpers ────────────────────────────────────────────────────
export function pickRandom<T>(pool: readonly T[]): T {
  if (pool.length === 0) throw new Error("pickRandom: empty pool");
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Returns true with `pct` percent probability. Used to fire
 *  occasional personality lines without being noisy. */
export function chance(pct: number): boolean {
  return Math.random() * 100 < pct;
}

// ══════════════════════════════════════════════════════════════════
// PROGRESS step variants — each step has 5-6 icon+label pairs.
// Every editMsg(buildProgress(...)) call will randomly select one,
// so users see varied phrasing across requests.
//
// NOTE: kept terse (≤ 5 words after the icon) so they fit on one
// line on small screens. All in formal Arabic.
// ══════════════════════════════════════════════════════════════════

interface StepVariant { icon: string; label: string; }

export const PROGRESS_VARIANTS: ReadonlyArray<readonly StepVariant[]> = [
  // Step 0 — initial
  [
    { icon: "🔭", label: "أتفقّد المكتبة الرقميّة"     },
    { icon: "🌌", label: "أبدأ رحلة البحث"             },
    { icon: "📚", label: "تستيقظ مكتبتي الواسعة"        },
    { icon: "🔍", label: "أتجوّل بين الرفوف الإلكترونيّة" },
    { icon: "🌠", label: "أُرسل إشاراتي إلى آلاف الكتب"  },
    { icon: "🧭", label: "أرسم خارطة البحث"             },
  ],
  // Step 1 — searching
  [
    { icon: "🔎", label: "أُفتّش في المصادر العربيّة"      },
    { icon: "🌐", label: "أتصفّح الشبكة بحثاً عن نسختك"   },
    { icon: "📡", label: "أبعث إشاراتي إلى مصادر متعدّدة" },
    { icon: "📖", label: "أقلّب صفحات الفهارس"             },
    { icon: "🗂️", label: "أراجع أرشيفات المكتبات"          },
  ],
  // Step 2 — fuzzy/retry
  [
    { icon: "🧠", label: "أُعمِل الفكر بصياغة مختلفة"      },
    { icon: "🎯", label: "أُجرّب أقرب صياغة"                },
    { icon: "💡", label: "أُعيد المحاولة بطريقة أذكى"      },
    { icon: "🔁", label: "أُكرّر البحث بمنهج آخر"           },
    { icon: "✨", label: "أبحث في الزوايا غير المألوفة"      },
  ],
  // Step 3 — found candidates
  [
    { icon: "📡", label: "وجدتُ أثراً، أتحقّق منه"          },
    { icon: "📍", label: "اقتنصتُ بعض الإشارات"             },
    { icon: "🛰️", label: "وصلتني نتائج واعدة"              },
    { icon: "🎣", label: "أصطاد أفضل الروابط"               },
    { icon: "🔬", label: "أمحّص ما عُثر عليه"               },
  ],
  // Step 4 — quality testing
  [
    { icon: "🔬", label: "أختبر جودة الروابط"               },
    { icon: "⚖️", label: "أُوازن بين النتائج"               },
    { icon: "🧪", label: "أُحلّل المرشّحين"                 },
    { icon: "🎓", label: "أُقيّم مصداقيّة كلّ ملف"          },
    { icon: "🛡️", label: "أتحقّق من سلامة المحتوى"         },
  ],
  // Step 5 — downloading
  [
    { icon: "⚡",  label: "أُحمّل الكتاب من أقرب مصدر"      },
    { icon: "📥", label: "يجري تحميل الملف الآن"            },
    { icon: "🚂", label: "في طريقي إلى المصدر الأنسب"       },
    { icon: "💎", label: "أُحضِر النسخة الأجود"             },
    { icon: "🌊", label: "تتدفّق البيانات بسرعة"            },
  ],
  // Step 6 — uploading to Telegram
  [
    { icon: "🚀", label: "في الطريق إليك الآن"              },
    { icon: "📤", label: "تبقّت ثوانٍ قليلة"                },
    { icon: "🎁", label: "أُغلِّف لك هديّتك"                 },
    { icon: "✨", label: "ها هو في الأفق"                    },
    { icon: "🦋", label: "وَصَل، أُحضِره إليك"               },
    { icon: "📬", label: "أُسلّمك الكتاب فوراً"             },
  ],
] as const;

// ══════════════════════════════════════════════════════════════════
// SUCCESS taglines — replaces the fixed "✨ وصل كتابك!" headline.
// Mix of warm welcoming + more energetic options. All formal.
// ══════════════════════════════════════════════════════════════════

export const SUCCESS_TAGLINES: readonly string[] = [
  "✨ *وصل كتابك!*",
  "🎁 *تفضّل، هذا كتابك*",
  "📦 *طلبك بين يديك الآن*",
  "🚀 *ها هو الكتاب — استمتع!*",
  "🎯 *إصابة موفّقة!*",
  "🌟 *جاء الكتاب على رغبتك*",
  "📖 *كتابك جاهز للقراءة*",
  "🦋 *وصلت السحب — هاك الكتاب*",
  "💎 *حصلتَ على نسخة جيّدة*",
] as const;

export const SUCCESS_TAGLINES_PREMIUM: readonly string[] = [
  "✨ *وصل كتابك — بأولوية Premium!*",
  "🌟 *كتابك جاهز — أولويّة كاملة*",
  "🎯 *تفضّل، طلبك معالَج بأولويّة*",
  "🚀 *وصل بأولويّة Premium*",
  "💎 *كتابك بين يديك — درجة أولى*",
  "📖 *كتابك جاهز — معالجة سريعة*",
] as const;

// ══════════════════════════════════════════════════════════════════
// CACHE-HIT taglines — the "you got it instantly" feeling.
// Replace "⚡ من الأرشيف — وصلك في ثوانٍ".
// ══════════════════════════════════════════════════════════════════

export const CACHE_HIT_TAGLINES: readonly string[] = [
  "⚡ _من الأرشيف — وصلك في ثوانٍ_",
  "💾 _محفوظ مسبقاً — أُرسل فوراً_",
  "🌟 _نسخة جاهزة — تفضّل!_",
  "⏱️ _قياسيّ! وصل بسرعة فائقة_",
  "🔥 _الذاكرة سريعة — هاك الكتاب_",
] as const;

// ══════════════════════════════════════════════════════════════════
// LONG-WAIT REASSURANCE — fires when a step lingers > 15 / 30 sec.
// User asked for ALL formal Arabic (الفصحى) here. No dialect.
// ══════════════════════════════════════════════════════════════════

export const WAIT_REASSURANCE_15S: readonly string[] = [
  "⏳ _لا يزال البحث جارياً — يحتاج هذا الكتاب جهداً إضافيّاً_",
  "🔥 _المصادر مزدحمة قليلاً، أرجو الصبر_",
  "🎯 _اقتربتُ من النتيجة، فلتنتظر قليلاً_",
  "🧠 _أُفكّر في طريقة أذكى لاستحضار الكتاب_",
  "📡 _أتواصل مع مكتبات بعيدة المدى_",
  "🌊 _البحث في عمق الأرشيفات الرقميّة يستغرق وقتاً_",
  "⚙️ _آليّات البحث تعمل بكامل طاقتها_",
] as const;

export const WAIT_REASSURANCE_30S: readonly string[] = [
  "💪 _الكتاب يستحقّ الانتظار — أرجو الصبر قليلاً بعد_",
  "🌌 _البحث في الأعماق يحتاج وقتاً إضافياً_",
  "🚂 _في الطريق — مع توقّفات قصيرة_",
  "🪶 _الجودة تتطلّب وقتاً، فلتطمئنّ_",
  "🛰️ _أتواصل مع مصادر إضافيّة بعيدة_",
  "📚 _أتنقّل بين أرشيفات متعدّدة، اقترب الإنجاز_",
] as const;

// ══════════════════════════════════════════════════════════════════
// PERSONALITY LINES — appended to ~10% of successful deliveries.
// Formal, polite, complimentary. Never pushy.
// ══════════════════════════════════════════════════════════════════

export const PERSONALITY_LINES: readonly string[] = [
  "🌹 _ملاحظة: ذوقك في الكتب يدلّ على عقل راقٍ_",
  "📖 _ملاحظة: اختيار موفّق — قراءة ممتعة_",
  "🌟 _ملاحظة: قارئ من القرّاء — وافر الاحترام_",
  "☕ _ملاحظة: استمتع بالقراءة في وقت هادئ_",
  "🪶 _ملاحظة: من أجمل ما يُقرأ — أتمنّى لك الفائدة_",
  "💫 _ملاحظة: كتاب يستحقّ التأمّل والتدبّر_",
  "🌿 _ملاحظة: قراءة موفّقة، ودمت قارئاً_",
  "📜 _ملاحظة: من خير الجلساء — كتاب نافع_",
] as const;

// Probability for personality line append (percentage 0-100).
export const PERSONALITY_LINE_CHANCE = 10;

// ══════════════════════════════════════════════════════════════════
// REACTION POOLS — Telegram bot reactions (👀 / 🎉 / 😢 / etc.)
// Each outcome has a small pool the bot picks from randomly.
// Limited to free-tier reactions:
//   https://core.telegram.org/bots/api#setmessagereaction
// ══════════════════════════════════════════════════════════════════

export const REACTION_RECEIVED:  readonly string[] = ["👀", "✍️", "🤔", "👌"];
export const REACTION_SUCCESS:   readonly string[] = ["🎉", "🔥", "🤩", "🥳", "❤️", "⚡", "🏆", "💯", "👏", "🤝"];
export const REACTION_CACHE_HIT: readonly string[] = ["⚡", "🔥", "💯", "🤩"];
export const REACTION_NO_RESULT: readonly string[] = ["😢", "🤔", "🥱"];
export const REACTION_ERROR:     readonly string[] = ["😱", "🤯", "😨"];
export const REACTION_PAID_BOOK: readonly string[] = ["🤔", "😐", "😢"];

// ══════════════════════════════════════════════════════════════════
// PAID BOOK / NO RESULTS — varied openings (kept brief).
// ══════════════════════════════════════════════════════════════════

export const PAID_BOOK_HEADLINES: readonly string[] = [
  "📕 *كتاب مدفوع أو غير متوفّر مجّاناً*",
  "📕 *لم أعثر على نسخة مجّانيّة من هذا الكتاب*",
  "📕 *هذا الكتاب لا يتوفّر له PDF مجّاني*",
  "📕 *النسخة الإلكترونيّة المجّانية غير متاحة*",
] as const;

export const NO_RESULTS_HEADLINES: readonly string[] = [
  "😔 *لم أجد PDF متاحاً*",
  "😔 *لم تُسفر مصادري عن نتيجة*",
  "😔 *البحث لم يُثمر هذه المرّة*",
  "😔 *لا أملك نتيجة موثوقة الآن*",
] as const;
