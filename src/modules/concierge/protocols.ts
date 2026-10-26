import { z } from "zod";

/**
 * Protocol definitions: the shape of a step (what `Protocol.steps` holds), the
 * default protocols every tenant starts with, and the patient-facing message
 * each step produces. Pure: no database, importable from client components.
 *
 * A step lives at `offsetHours` after the procedure. INSTRUCTION steps only
 * send text; CHECK_IN steps carry structured questions (and optionally the
 * 1–5 satisfaction question); PHOTO_REQUEST steps ask for named views. Every
 * question may declare the range we expect a healthy answer in; an answer
 * outside it is a WATCH flag, or HIGH_RISK when the question is `highRisk`.
 * `danger` is the additive extension for graded scales ("pain ≥ 8 is high
 * risk on its own, 5–7 is only out of the expected range").
 */

export const STEP_KINDS = ["INSTRUCTION", "CHECK_IN", "PHOTO_REQUEST"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const QUESTION_TYPES = ["scale", "yesno", "number", "text"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const LANGUAGES = ["ar", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const MAX_OFFSET_HOURS = 24 * 400;

const zLocalized = (max: number) => z.object({ ar: z.string().trim().max(max), en: z.string().trim().max(max) });

export const zExpected = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  value: z.boolean().optional(),
});

export const zQuestion = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_-]*$/i, "Keys are letters, digits, _ and -"),
    label: zLocalized(200),
    type: z.enum(QUESTION_TYPES),
    min: z.number().optional(),
    max: z.number().optional(),
    expected: zExpected.optional(),
    /** Numeric answers inside this range are high-risk on their own (e.g. pain `{ min: 8 }`). */
    danger: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
    highRisk: z.boolean().optional(),
  })
  .superRefine((q, ctx) => {
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (num(q.min) && num(q.max) && q.min > q.max) {
      ctx.addIssue({ code: "custom", path: ["max"], message: "The maximum must not be below the minimum" });
    }
    const e = q.expected;
    if (e && num(e.min) && num(e.max) && e.min > e.max) {
      ctx.addIssue({ code: "custom", path: ["expected"], message: "The expected range is empty (minimum above maximum)" });
    }
    if (!q.label?.ar?.trim() && !q.label?.en?.trim()) {
      ctx.addIssue({ code: "custom", path: ["label"], message: "Give the question a label in Arabic or English" });
    }
  });

export const zStep = z
  .object({
    offsetHours: z.number().min(0).max(MAX_OFFSET_HOURS),
    kind: z.enum(STEP_KINDS),
    title: z.string().trim().min(1).max(120),
    body: zLocalized(2000),
    questions: z.array(zQuestion).max(20).optional(),
    /** Ask the 1–5 satisfaction question with this step. */
    satisfaction: z.boolean().optional(),
    /** Requested views: "front", "top", "donor"… */
    photos: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
  })
  .superRefine((step, ctx) => {
    // zod 4 runs object refinements even when a field failed a check: never trust the shapes here.
    const questions = Array.isArray(step.questions) ? step.questions : [];
    const photos = Array.isArray(step.photos) ? step.photos : [];
    const keys = new Set<string>();
    for (const [i, q] of questions.entries()) {
      const key = q && typeof q.key === "string" ? q.key : null;
      if (!key) continue;
      if (keys.has(key)) {
        ctx.addIssue({ code: "custom", path: ["questions", i, "key"], message: `Duplicate question key "${key}"` });
      }
      keys.add(key);
    }
    if (step.kind === "CHECK_IN" && !(questions.length || step.satisfaction)) {
      ctx.addIssue({ code: "custom", path: ["questions"], message: "A check-in needs at least one question or the satisfaction question" });
    }
    if (step.kind === "PHOTO_REQUEST" && !photos.length) {
      ctx.addIssue({ code: "custom", path: ["photos"], message: "A photo request names at least one view" });
    }
    if (step.kind === "INSTRUCTION" && !(step.body?.ar?.trim() || step.body?.en?.trim())) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "Instructions need a message in Arabic or English" });
    }
  });

export const zSteps = z.array(zStep).max(40);

export type ProtocolQuestion = z.infer<typeof zQuestion>;
export type ProtocolStep = z.infer<typeof zStep>;
export type Localized = { ar: string; en: string };

/** `Protocol.steps` as typed steps; anything malformed is dropped (never throws). */
export function parseSteps(json: unknown): ProtocolStep[] {
  const parsed = zSteps.safeParse(json);
  if (parsed.success) return parsed.data;
  if (!Array.isArray(json)) return [];
  return json.map((s) => zStep.safeParse(s)).filter((r) => r.success).map((r) => r.data);
}

export function isLanguage(code: string | null | undefined): code is Language {
  return code === "ar" || code === "en";
}

export function pickLanguage(code: string | null | undefined): Language {
  return isLanguage(code) ? code : "ar";
}

export function text(l: Localized, language: Language): string {
  return (language === "ar" ? l.ar : l.en) || l.en || l.ar;
}

/** The step's day number: 0 for the procedure day, 1 for 24 h after… */
export function stepDay(step: { offsetHours: number }): number {
  return Math.round(step.offsetHours / 24);
}

/** "Day 7" / "اليوم ٧" (months once the protocol runs long). */
export function dayLabel(step: { offsetHours: number }, language: Language = "en"): string {
  const day = stepDay(step);
  if (day >= 60 && day % 30 === 0) {
    const month = day / 30;
    return language === "ar" ? `الشهر ${arabicDigits(month)}` : `Month ${month}`;
  }
  if (day === 365) return language === "ar" ? "بعد سنة" : "Month 12";
  return language === "ar" ? `اليوم ${arabicDigits(day)}` : `Day ${day}`;
}

/** The patient-facing heading of a step: "Day 1 check-in" / "متابعة اليوم ١". */
export function stepHeading(step: ProtocolStep, language: Language): string {
  const day = dayLabel(step, language);
  switch (step.kind) {
    case "CHECK_IN":
      return language === "ar" ? `متابعة ${day}` : `${day} check-in`;
    case "PHOTO_REQUEST":
      return language === "ar" ? `صور ${day}` : `${day} photos`;
    default:
      return language === "ar" ? "تعليمات بعد الجلسة" : "Aftercare instructions";
  }
}

/** True when the step asks a question whose answer can be high-risk. */
export function stepHasHighRisk(step: ProtocolStep): boolean {
  return (step.questions ?? []).some((q) => q.highRisk || q.danger);
}

/** The last day of the protocol (the "M" of "day N of M"). */
export function protocolLengthDays(steps: readonly ProtocolStep[]): number {
  return steps.reduce((max, s) => Math.max(max, stepDay(s)), 0);
}

export function arabicDigits(n: number): string {
  return String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]!);
}

export const SATISFACTION_QUESTION: Localized = {
  ar: "قد إيه إنت راضي عن الرعاية لحد دلوقتي؟",
  en: "How satisfied are you with your care so far?",
};

// ── Messages ─────────────────────────────────────────────────────────────────

export interface MessageContext {
  language: Language;
  clinicName: string;
  clinicPhone: string | null;
  patientFirstName: string;
  /** The public check-in link (check-ins and photo requests). */
  link?: string | null;
  reminder?: boolean;
}

function fill(body: string, ctx: MessageContext): string {
  const phone = ctx.clinicPhone ?? (ctx.language === "ar" ? "رقم العيادة" : "the clinic number");
  return body.replace(/\{\{phone\}\}/g, phone).replace(/\{\{clinic\}\}/g, ctx.clinicName).replace(/\{\{name\}\}/g, ctx.patientFirstName);
}

/** The WhatsApp text of a step for one patient. */
export function buildStepMessage(step: ProtocolStep, ctx: MessageContext): string {
  const ar = ctx.language === "ar";
  const greeting = ar ? `أهلاً ${ctx.patientFirstName} 👋` : `Hi ${ctx.patientFirstName},`;
  const signature = ar ? `— ${ctx.clinicName}` : `— ${ctx.clinicName}`;
  const link = ctx.link ? ctx.link : "";

  if (ctx.reminder && step.kind !== "INSTRUCTION") {
    const what = stepHeading(step, ctx.language);
    const line = ar
      ? `تذكير بسيط 🔔 لسه مستنيين إجابات «${what}». محتاجة دقيقة واحدة بس:`
      : `A gentle reminder 🔔 we have not received your "${what}" yet. It takes one minute:`;
    return [greeting, line, link, signature].filter(Boolean).join("\n\n");
  }

  const body = fill(text(step.body, ctx.language), ctx);
  if (step.kind === "INSTRUCTION") {
    return [greeting, body, signature].join("\n\n");
  }
  const cta =
    step.kind === "PHOTO_REQUEST"
      ? ar
        ? "ابعت الصور من هنا:"
        : "Upload the photos here:"
      : ar
        ? "جاوب من هنا (دقيقة واحدة):"
        : "Answer here (one minute):";
  return [greeting, body, `${cta}\n${link}`.trim(), signature].join("\n\n");
}

// ── Default protocols ────────────────────────────────────────────────────────

export interface DefaultProtocol {
  treatmentKey: string;
  name: string;
  steps: ProtocolStep[];
}

const H = (days: number, hours = 0) => days * 24 + hours;

const q = {
  pain: (expectedMax: number, dangerMin: number): ProtocolQuestion => ({
    key: "pain",
    label: { ar: "الألم دلوقتي (٠ = مفيش، ١٠ = أسوأ ألم)", en: "Pain right now (0 = none, 10 = worst)" },
    type: "scale",
    min: 0,
    max: 10,
    expected: { max: expectedMax },
    danger: { min: dangerMin },
  }),
  fever: (): ProtocolQuestion => ({
    key: "fever",
    label: { ar: "حرارة أو رعشة؟", en: "Fever or chills?" },
    type: "yesno",
    expected: { value: false },
    highRisk: true,
  }),
  yesno: (key: string, ar: string, en: string, opts: { expected?: boolean; highRisk?: boolean } = {}): ProtocolQuestion => ({
    key,
    label: { ar, en },
    type: "yesno",
    ...(opts.expected === undefined ? {} : { expected: { value: opts.expected } }),
    ...(opts.highRisk ? { highRisk: true } : {}),
  }),
  scale: (key: string, ar: string, en: string, expected: { min?: number; max?: number }, danger?: { min?: number; max?: number }): ProtocolQuestion => ({
    key,
    label: { ar, en },
    type: "scale",
    min: 0,
    max: 10,
    expected,
    ...(danger ? { danger } : {}),
  }),
  text: (key: string, ar: string, en: string): ProtocolQuestion => ({ key, label: { ar, en }, type: "text" }),
};

const comments = q.text("comments", "في حاجة حابب الدكتور يعرفها؟", "Anything you would like the doctor to know?");

export const DEFAULT_PROTOCOLS: readonly DefaultProtocol[] = [
  {
    treatmentKey: "hair-transplant",
    name: "Hair transplant aftercare",
    steps: [
      {
        offsetHours: H(0, 4),
        kind: "INSTRUCTION",
        title: "Tonight after your transplant",
        body: {
          ar: "العملية تمت بخير والحمد لله. الليلة: نام على ضهرك ورأسك مرفوعة على مخدتين، ما تلمسش ولا تهرش مكان الزراعة، ورُش المحلول الملحي كل ساعتين وإنت صاحي. خد المضاد الحيوي والمسكن زي ما هو مكتوب بالظبط. ممنوع التدخين والانحناء والمجهود لمدة ٧ أيام.\n\nلو حصل نزيف ما بيقفش بعد ١٠ دقايق ضغط خفيف، أو حرارة، أو ألم المسكن ما بيهدّيهوش، كلّمنا حالاً على {{phone}}.",
          en: "Your procedure went well. Tonight: sleep on your back with your head raised on two pillows, do not touch or scratch the grafts, and spray the saline every 2 hours while you are awake. Take the antibiotic and the painkiller exactly as written. No smoking, alcohol, bending or heavy effort for 7 days.\n\nIf there is bleeding that does not stop with 10 minutes of gentle pressure, a fever, or pain the tablets do not control, call us now on {{phone}}.",
        },
      },
      {
        offsetHours: H(1),
        kind: "CHECK_IN",
        title: "Day 1 check-in",
        body: {
          ar: "عدّت أول ليلة إزاي؟ ٤ أسئلة سريعة عشان الدكتور وفريق التمريض يطمّنوا عليك.",
          en: "How was your first night? Four quick questions so the doctor and the nursing team can keep an eye on you.",
        },
        questions: [
          q.pain(4, 8),
          q.yesno("swelling", "في تورم في الجبهة أو حوالين العين؟", "Any swelling of the forehead or around the eyes?"),
          q.yesno("bleeding", "في نزيف من مكان الزراعة أو المنطقة المانحة؟", "Any bleeding from the grafts or the donor area?", { expected: false, highRisk: true }),
          q.fever(),
        ],
      },
      {
        offsetHours: H(3),
        kind: "CHECK_IN",
        title: "Day 3 check-in",
        body: {
          ar: "اليوم التالت. التورم اللي بينزل ناحية العين شائع وبيروح في كام يوم؛ خلّي رأسك مرفوعة. تلات أسئلة سريعة:",
          en: "Day 3. Swelling that moves down towards the eyes is common and settles within a few days; keep your head raised. Three quick questions:",
        },
        questions: [
          q.pain(3, 7),
          q.yesno("swelling", "التورم لسه موجود؟", "Is the swelling still there?"),
          q.yesno("discharge", "في صديد أو إفرازات صفرا من مكان الزراعة؟", "Any pus or yellow discharge from the grafts?", { expected: false, highRisk: true }),
          q.fever(),
        ],
      },
      {
        offsetHours: H(7),
        kind: "CHECK_IN",
        title: "Day 7 check-in",
        body: {
          ar: "أسبوع عدّى! من النهارده تقدر تبدأ الغسيل الخفيف زي ما ورّيناك؛ الهرش معناه إن الجرح بيلتئم. قولنا الوضع عامل إيه:",
          en: "One week in. From today you can start gentle washing as we showed you; itching means healing. Tell us how it is going:",
        },
        questions: [
          q.yesno("crusting", "القشور بدأت تنزل؟", "Are the crusts starting to come off?"),
          q.scale("itching", "الهرش (٠ = مفيش، ١٠ = شديد)", "Itching (0 = none, 10 = severe)", { max: 6 }),
          q.yesno("sleep", "بتنام كويس؟", "Are you sleeping well?", { expected: true }),
          q.fever(),
        ],
      },
      {
        offsetHours: H(7, 1),
        kind: "PHOTO_REQUEST",
        title: "Day 7 photos",
        body: {
          ar: "ابعتلنا تلات صور في نور النهار ومن غير كاب: من قدام، من فوق، والمنطقة المانحة من ورا. الصور بتتحفظ في ملفك عشان الدكتور يراجعها.",
          en: "Please send us three photos in good daylight, without a cap: from the front, from the top, and the donor area at the back. They go straight into your file for the doctor to review.",
        },
        photos: ["front", "top", "donor"],
      },
      {
        offsetHours: H(14),
        kind: "CHECK_IN",
        title: "Day 14 check-in",
        body: {
          ar: "أسبوعين. الشعر المزروع عادةً بيقع بين الأسبوع ٢ و٦؛ ده طبيعي وبيرجع ينمو من الشهر التالت.",
          en: "Two weeks. The transplanted hairs usually shed between weeks 2 and 6; this is normal and they grow back from month 3.",
        },
        questions: [
          q.yesno("shedding", "الشعر المزروع بدأ يقع؟", "Have the transplanted hairs started to shed?"),
          q.scale("redness", "احمرار منطقة الزراعة (٠–١٠)", "Redness of the recipient area (0–10)", { max: 5 }),
          q.yesno("pimples", "في حبوب أو دمامل صغيرة في المنطقة؟", "Any pimples or small boils in the area?", { expected: false }),
          q.pain(1, 6),
        ],
      },
      {
        offsetHours: H(30),
        kind: "CHECK_IN",
        title: "Month 1 check-in",
        body: { ar: "النهارده شهر! حاسس إيه لحد دلوقتي؟", en: "One month today. How are you feeling about everything so far?" },
        questions: [q.yesno("donor", "المنطقة المانحة التأمت خالص؟", "Has the donor area healed completely?", { expected: true }), comments],
        satisfaction: true,
      },
      {
        offsetHours: H(90),
        kind: "PHOTO_REQUEST",
        title: "Month 3 photos",
        body: {
          ar: "٣ شهور: أول شعر جديد بيظهر دلوقتي. تلات صور في نور النهار من نفس الزوايا لو سمحت.",
          en: "Three months: the first new hairs appear now. Three photos in daylight, please, same angles as before.",
        },
        photos: ["front", "top", "donor"],
      },
      {
        offsetHours: H(180),
        kind: "PHOTO_REQUEST",
        title: "Month 6 photos",
        body: {
          ar: "٦ شهور من الزراعة. صورتين في نور النهار: من قدام ومن فوق.",
          en: "Six months since your transplant. Two photos in daylight: from the front and from the top.",
        },
        photos: ["front", "top"],
      },
      {
        offsetHours: H(365),
        kind: "CHECK_IN",
        title: "Month 12 check-in",
        body: { ar: "سنة من يوم الزراعة. يهمنا نعرف رأيك في النتيجة.", en: "A year since your transplant. We would love to know how you feel about the result." },
        questions: [q.scale("density", "مبسوط قد إيه بالكثافة؟ (٠–١٠)", "How happy are you with the density? (0–10)", { min: 6 }), comments],
        satisfaction: true,
      },
    ],
  },
  {
    treatmentKey: "prp-hair",
    name: "PRP aftercare",
    steps: [
      {
        offsetHours: H(0, 2),
        kind: "INSTRUCTION",
        title: "After your PRP session",
        body: {
          ar: "شكراً لزيارتك النهارده. ما تغسلش شعرك ٢٤ ساعة، ابعد عن الشمس والساونا والرياضة الشاقة النهارده، ومن غير منتجات شعر لحد بكرة. شوية وجع أو إحساس بشد في فروة الرأس طبيعي.\n\nلو الفروة ورمت والتورم بيزيد، أو جاتلك حرارة، أو الألم شديد، كلّمنا حالاً على {{phone}}.",
          en: "Thank you for coming in today. Do not wash your hair for 24 hours, avoid sun, sauna and hard exercise today, and skip hair products until tomorrow. Mild tenderness or a tight feeling of the scalp is normal.\n\nIf the scalp swells and keeps spreading, you get a fever, or the pain is severe, call us now on {{phone}}.",
        },
      },
      {
        offsetHours: H(2),
        kind: "CHECK_IN",
        title: "Day 2 check-in",
        body: { ar: "يومين بعد الجلسة. تلات أسئلة سريعة:", en: "Two days after your session. Three quick questions:" },
        questions: [
          q.pain(3, 7),
          q.yesno("redness", "في احمرار في فروة الرأس؟", "Redness of the scalp?"),
          q.yesno("swelling", "في تورم؟", "Any swelling?", { expected: false }),
          q.fever(),
        ],
      },
      {
        offsetHours: H(7),
        kind: "CHECK_IN",
        title: "Day 7 check-in",
        body: { ar: "أسبوع. شوية تساقط زيادة ممكن يحصل قبل دورة النمو الجديدة.", en: "One week. A little extra shedding can happen before the new growth cycle." },
        questions: [
          q.yesno("shedding", "في تساقط زيادة شوية الأسبوع ده؟", "A little extra shedding this week?"),
          q.scale("irritation", "تهيّج فروة الرأس (٠–١٠)", "Scalp irritation (0–10)", { max: 4 }),
          q.yesno("pus", "في صديد أو ورم مؤلم في مكان الحقن؟", "Any pus or a painful lump at an injection point?", { expected: false, highRisk: true }),
        ],
      },
      {
        offsetHours: H(14),
        kind: "CHECK_IN",
        title: "Day 14 check-in",
        body: { ar: "أسبوعين بعد البلازما. رأيك إيه لحد دلوقتي؟", en: "Two weeks after your PRP. How are you finding it?" },
        questions: [q.yesno("next", "جاهز تحجز الجلسة الجاية؟", "Ready to book your next session?"), comments],
        satisfaction: true,
      },
    ],
  },
  {
    treatmentKey: "laser-hair-removal",
    name: "Laser hair removal aftercare",
    steps: [
      {
        offsetHours: H(0, 2),
        kind: "INSTRUCTION",
        title: "After your laser session",
        body: {
          ar: "الكمادات الباردة هتريّحك النهارده. لمدة ٤٨ ساعة: من غير دش سخن ولا ساونا ولا جيم ولا برفان على المنطقة. لمدة أسبوعين: ابعدي عن الشمس وحطي واقي شمس ٥٠ كل يوم الصبح؛ ممنوع الشمع والنتف، الحلاقة عادي. احمرار وشوية حبوب صغيرة ليوم أو اتنين متوقع.\n\nلو ظهرت فقاقيع، أو الجلد اتفتح، أو الحرقان شديد، كلّمينا حالاً على {{phone}}.",
          en: "Cool compresses help today. For 48 hours: no hot showers, sauna, gym or perfume on the area. For two weeks: no sun and SPF 50 every morning; no waxing or plucking, shaving is fine. Redness and a little bumpiness for a day or two are expected.\n\nIf blisters appear, the skin breaks, or the burning is severe, call us now on {{phone}}.",
        },
      },
      {
        offsetHours: H(2),
        kind: "CHECK_IN",
        title: "Day 2 check-in",
        body: { ar: "يومين بعد الجلسة. احمرار خفيف متوقع؛ قوليلنا المنطقة شكلها إيه:", en: "Two days after your session. Mild redness is expected; tell us how the area looks:" },
        questions: [
          q.scale("redness", "الاحمرار (٠ = مفيش، ١٠ = شديد)", "Redness (0 = none, 10 = severe)", { max: 4 }),
          q.scale("burning", "حرقان أو لسعة (٠–١٠)", "Burning or stinging (0–10)", { max: 3 }, { min: 8 }),
          q.yesno("blistering", "في فقاقيع أو جلد متفتح؟", "Any blisters or broken skin?", { expected: false, highRisk: true }),
          q.yesno("swelling", "في تورم؟", "Any swelling?", { expected: false }),
        ],
      },
      {
        offsetHours: H(7),
        kind: "CHECK_IN",
        title: "Day 7 check-in",
        body: { ar: "أسبوع بعد الليزر. الشعر بيبدأ يقع لوحده من الأسبوع ده.", en: "One week after your laser. The treated hairs start falling out on their own from this week." },
        questions: [
          q.scale("redness", "الاحمرار (٠–١٠)", "Redness (0–10)", { max: 2 }),
          q.yesno("pigment", "في بقع غامقة أو فاتحة في مكان الليزر؟", "Any dark or light patches where the laser was?", { expected: false }),
          q.yesno("shedding", "الشعر بيقع لوحده؟", "Hairs falling out on their own?"),
        ],
      },
      {
        offsetHours: H(14),
        kind: "CHECK_IN",
        title: "Day 14 check-in",
        body: { ar: "أسبوعين. يهمنا رأيك قبل الجلسة الجاية.", en: "Two weeks. We would like your view before the next session." },
        questions: [q.scale("smooth", "المنطقة ناعمة قد إيه دلوقتي؟ (٠–١٠)", "How smooth is the area now? (0–10)", { min: 5 }), comments],
        satisfaction: true,
      },
    ],
  },
  {
    treatmentKey: "acne",
    name: "Acne treatment aftercare",
    steps: [
      {
        offsetHours: H(0, 2),
        kind: "INSTRUCTION",
        title: "Starting your acne treatment",
        body: {
          ar: "استخدمي المنتجات زي ما هي مكتوبة بالظبط: كمية صغيرة بالليل، مرطب، وواقي شمس كل يوم الصبح. شوية جفاف وتقشير ولسعة خفيفة في أول أسبوعين متوقعين؛ وطلوع حبوب بسيطة قبل ما تتحسن شائع.\n\nلو وشك أو شفايفك ورموا فجأة، أو طلعلك أرتيكاريا، أو حسيتي بصعوبة في التنفس، كلّمينا حالاً على {{phone}} أو روحي أقرب طوارئ.",
          en: "Use the products exactly as written: a pea-sized amount at night, moisturiser, and sunscreen every morning. Some dryness, peeling and mild stinging in the first two weeks are expected; a small flare before it clears is common.\n\nIf your face or lips swell suddenly, you get hives, or you find it hard to breathe, call us now on {{phone}} or go to the nearest emergency room.",
        },
      },
      {
        offsetHours: H(2),
        kind: "CHECK_IN",
        title: "Day 2 check-in",
        body: { ar: "يومين على العلاج. تهيّج خفيف متوقع؛ قوليلنا:", en: "Two days into the treatment. Mild irritation is expected; tell us:" },
        questions: [
          q.scale("irritation", "تهيّج أو لسعة (٠–١٠)", "Irritation or stinging (0–10)", { max: 4 }),
          q.yesno("peeling", "في تقشير؟", "Any peeling?"),
          q.yesno("swelling", "تورم شديد في الوش أو الشفايف؟", "Severe swelling of the face or lips?", { expected: false, highRisk: true }),
          q.scale("burning", "حرقان (٠–١٠)", "Burning (0–10)", { max: 4 }, { min: 8 }),
        ],
      },
      {
        offsetHours: H(7),
        kind: "CHECK_IN",
        title: "Day 7 check-in",
        body: { ar: "أسبوع. حبوب جديدة في الأسبوع الأول شائعة وبتهدى مع الاستمرار.", en: "One week. New breakouts in the first week are common and settle as you continue." },
        questions: [
          q.scale("irritation", "تهيّج (٠–١٠)", "Irritation (0–10)", { max: 3 }),
          q.yesno("breakouts", "حبوب جديدة الأسبوع ده؟", "New breakouts this week?"),
          q.yesno("adherence", "بتستخدمي المنتجات كل يوم؟", "Using the products every day?", { expected: true }),
          q.yesno("swelling", "تورم شديد في الوش أو الشفايف؟", "Severe swelling of the face or lips?", { expected: false, highRisk: true }),
        ],
      },
      {
        offsetHours: H(14),
        kind: "CHECK_IN",
        title: "Day 14 check-in",
        body: { ar: "أسبوعين على العلاج. حاسة بتحسن؟", en: "Two weeks into the treatment. Noticing a change?" },
        questions: [q.scale("improvement", "التحسن لحد دلوقتي (٠–١٠)", "Improvement so far (0–10)", { min: 3 }), comments],
        satisfaction: true,
      },
    ],
  },
  {
    treatmentKey: "pigmentation",
    name: "Pigmentation treatment aftercare",
    steps: [
      {
        offsetHours: H(0, 2),
        kind: "INSTRUCTION",
        title: "Starting your pigmentation treatment",
        body: {
          ar: "علاج الكلف بياخد وقت وما بينفعش من غير حماية صارمة من الشمس: واقي شمس ٥٠ كل يوم الصبح وكل ٣ ساعات برّه، وقبعة لو تقدري. حطي كريم الليل طبقة رفيعة زي ما اتكتب؛ احمرار أو تقشير خفيف في أول أيام متوقع.\n\nلو الجلد غمق فجأة، أو طلعت فقاقيع، أو ورم، وقّفي الكريم وكلّمينا حالاً على {{phone}}.",
          en: "Melasma treatment works slowly and only with strict sun protection: SPF 50 every morning and again every 3 hours outdoors, a hat when you can. Apply the night cream thinly as prescribed; mild redness or peeling in the first days is expected.\n\nIf the skin darkens suddenly, blisters, or swells, stop the cream and call us now on {{phone}}.",
        },
      },
      {
        offsetHours: H(2),
        kind: "CHECK_IN",
        title: "Day 2 check-in",
        body: { ar: "يومين على العلاج. قوليلنا الجلد عامل إيه:", en: "Two days into the treatment. How is the skin?" },
        questions: [
          q.scale("irritation", "تهيّج أو لسعة (٠–١٠)", "Irritation or stinging (0–10)", { max: 4 }),
          q.yesno("peeling", "في تقشير؟", "Any peeling?"),
          q.yesno("darkening", "في منطقة غمقت؟", "Did any area get darker?", { expected: false }),
          q.yesno("swelling", "تورم شديد أو فقاقيع؟", "Severe swelling or blisters?", { expected: false, highRisk: true }),
        ],
      },
      {
        offsetHours: H(7),
        kind: "CHECK_IN",
        title: "Day 7 check-in",
        body: { ar: "أسبوع. واقي الشمس هو نص العلاج.", en: "One week. Sunscreen is half the treatment." },
        questions: [
          q.scale("irritation", "تهيّج (٠–١٠)", "Irritation (0–10)", { max: 3 }),
          q.yesno("sunscreen", "واقي الشمس كل يوم الصبح الأسبوع ده؟", "Sunscreen every morning this week?", { expected: true }),
          q.yesno("swelling", "تورم شديد أو فقاقيع؟", "Severe swelling or blisters?", { expected: false, highRisk: true }),
        ],
      },
      {
        offsetHours: H(14),
        kind: "CHECK_IN",
        title: "Day 14 check-in",
        body: { ar: "أسبوعين. التفتيح بيبان تدريجياً خلال ٦–٨ أسابيع.", en: "Two weeks. Lightening shows gradually over 6–8 weeks." },
        questions: [q.scale("lighter", "التصبغ أفتح؟ (٠ = زي ما هو، ١٠ = راح خالص)", "Is the pigmentation lighter? (0 = the same, 10 = gone)", { min: 2 }), comments],
        satisfaction: true,
      },
    ],
  },
  {
    treatmentKey: "botox-fillers",
    name: "Botox & fillers aftercare",
    steps: [
      {
        offsetHours: H(0, 1),
        kind: "INSTRUCTION",
        title: "After your injections",
        body: {
          ar: "خلّيكي قاعدة أو واقفة ٤ ساعات وما تضغطيش ولا تدلّكي المنطقة النهارده. من غير رياضة ولا ساونا ٢٤ ساعة؛ نامي على ضهرك الليلة. كدمات صغيرة وشوية تورم طبيعيين وبيروحوا خلال أسبوع.\n\nلو لاحظتي أي تغيير في النظر، أو الجلد بقى أبيض أو أزرق أو مبقّع، أو ألم شديد، كلّمينا فوراً على {{phone}}: ده ما يستناش.",
          en: "Stay upright for 4 hours and do not press, rub or massage the area today. No exercise, sauna or alcohol for 24 hours; sleep on your back tonight. Small bruises and a little swelling are normal and settle within a week.\n\nIf you notice any change in your vision, the skin turning white, blue or blotchy, or severe pain, call us immediately on {{phone}}: this cannot wait.",
        },
      },
      {
        offsetHours: H(1),
        kind: "CHECK_IN",
        title: "Day 1 check-in",
        body: { ar: "يوم بعد الحقن. كدمات بسيطة متوقعة؛ طمّنينا على الباقي:", en: "One day after your injections. Small bruises are expected; reassure us on the rest:" },
        questions: [
          q.yesno("bruising", "في كدمات؟", "Any bruising?"),
          q.scale("swelling", "التورم (٠–١٠)", "Swelling (0–10)", { max: 5 }),
          q.yesno("vision", "في أي تغيير في النظر؟", "Any change in your vision?", { expected: false, highRisk: true }),
          q.yesno("discolouration", "الجلد بقى أبيض أو أزرق أو مبقّع في أي مكان؟", "Skin turning white, blue or blotchy anywhere?", { expected: false, highRisk: true }),
          q.pain(3, 8),
        ],
      },
      {
        offsetHours: H(7),
        kind: "CHECK_IN",
        title: "Day 7 check-in",
        body: { ar: "أسبوع. النتيجة النهائية بتبان خلال ١٠–١٤ يوم.", en: "One week. The final result shows within 10–14 days." },
        questions: [
          q.yesno("lumps", "في تكتلات أو عدم تساوي؟", "Any lumps or unevenness?", { expected: false }),
          q.yesno("bruising", "الكدمات راحت؟", "Bruising gone?"),
          q.yesno("vision", "في أي تغيير في النظر؟", "Any change in your vision?", { expected: false, highRisk: true }),
        ],
      },
      {
        offsetHours: H(14),
        kind: "CHECK_IN",
        title: "Day 14 check-in",
        body: { ar: "أسبوعين. دلوقتي النتيجة كاملة؛ رأيك إيه؟", en: "Two weeks. The result is complete now; what do you think?" },
        questions: [q.scale("result", "مبسوطة بالنتيجة؟ (٠–١٠)", "Happy with the result? (0–10)", { min: 6 }), comments],
        satisfaction: true,
      },
    ],
  },
  {
    treatmentKey: "general-dermatology",
    name: "General dermatology follow-up",
    steps: [
      {
        offsetHours: H(0, 2),
        kind: "INSTRUCTION",
        title: "After your visit",
        body: {
          ar: "شكراً لزيارتك. استخدم العلاج زي ما اتكتب بالظبط وكمّل الكورس حتى لو الجلد اتحسن.\n\nلو الطفح انتشر بسرعة مع حرارة، أو شفايفك أو وشك ورموا، أو حسيت بصعوبة في التنفس، كلّمنا حالاً على {{phone}} أو روح أقرب طوارئ.",
          en: "Thank you for your visit. Use the treatment exactly as prescribed and finish the full course even when the skin looks better.\n\nIf a rash spreads quickly with a fever, your lips or face swell, or you find it hard to breathe, call us now on {{phone}} or go to the nearest emergency room.",
        },
      },
      {
        offsetHours: H(7),
        kind: "CHECK_IN",
        title: "Day 7 check-in",
        body: { ar: "أسبوع على العلاج. قولنا الوضع عامل إيه:", en: "One week into the treatment. Tell us how it is going:" },
        questions: [
          q.yesno("improving", "الجلد بيتحسن؟", "Is the skin improving?", { expected: true }),
          q.text("sideEffects", "في أي آثار جانبية؟", "Any side effects?"),
          q.yesno("fever", "حرارة أو طفح بينتشر؟", "Fever or a rash that is spreading?", { expected: false, highRisk: true }),
        ],
      },
      {
        offsetHours: H(14),
        kind: "CHECK_IN",
        title: "Day 14 check-in",
        body: { ar: "أسبوعين. يهمنا نعرف رأيك.", en: "Two weeks. We would like to know how you feel about it." },
        questions: [q.scale("improvement", "التحسن لحد دلوقتي (٠–١٠)", "Improvement so far (0–10)", { min: 3 }), comments],
        satisfaction: true,
      },
    ],
  },
];

export function defaultProtocolFor(treatmentKey: string): DefaultProtocol | undefined {
  return DEFAULT_PROTOCOLS.find((p) => p.treatmentKey === treatmentKey);
}
