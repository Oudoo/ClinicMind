import { randomUUID } from "node:crypto";
import type { ChannelType, ConversationStatus, LeadSource, LeadStage, LostReason, MessageAuthor, MessageDelivery, ObjectionTag, Prisma } from "@prisma/client";
import type { SeedContext, SeedPatient } from "./index";
import { egyptianMobile, makeRandom, type Random } from "./util";
import { listTreatments } from "../../src/modules/treatments/service";
import { DEFAULT_TEMPLATES } from "../../src/modules/messaging/default-templates";
import { tagObjections } from "../../src/modules/messaging/tagger";
import { SOURCE_LABELS } from "../../src/modules/crm/shared";
import { zonedParts } from "../../src/lib/time";

/**
 * The CRM and the reception inbox of the demo clinic:
 *
 *  - six ads campaigns (Meta click-to-WhatsApp and Google search) tied to treatments;
 *  - ~140 leads over 26 weeks with Egyptian names and numbers, sources,
 *    interests and stages in realistic proportions (≈35 % reach a booked
 *    consultation, ≈12 % won, ≈30 % lost with reasons and objections); won and
 *    attended leads are the clinic's existing patients, tied to the completed
 *    consultation that converted them (and booked leads to their upcoming one);
 *  - follow-ups: ~25 open (8 overdue by 1–5 days) and ~40 done;
 *  - the 26 conversations of the core seed made coherent (authors, contact,
 *    status, timestamps, read receipts) and ~60 more on leads, answered by the
 *    AI within 20–90 s or by reception within 8–40 min, with objection tags;
 *  - the eight reply templates and a WhatsApp integration left on "manual".
 *
 * Deterministic content (`makeRandom(11)`); ids are generated so that every
 * row can be written with createMany.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The demo clinic's clock (the core seed's clinic). */
const TIMEZONE = "Africa/Cairo";

type TreatmentKey = "hair-transplant" | "prp-hair" | "acne" | "pigmentation" | "laser-hair-removal" | "botox-fillers" | "general-dermatology";
type Lang = "ar" | "en";

const INTEREST_WEIGHTS: readonly (readonly [TreatmentKey, number])[] = [
  ["hair-transplant", 24],
  ["prp-hair", 18],
  ["acne", 20],
  ["pigmentation", 13],
  ["laser-hair-removal", 17],
  ["botox-fillers", 5],
  ["general-dermatology", 3],
];

/** Share of women among enquiries per treatment (picks the first name). */
const FEMALE_SHARE: Record<TreatmentKey, number> = {
  "hair-transplant": 0.15,
  "prp-hair": 0.45,
  acne: 0.6,
  pigmentation: 0.9,
  "laser-hair-removal": 0.85,
  "botox-fillers": 0.9,
  "general-dermatology": 0.55,
};

/** The core seed's clinical scenario → the treatment such a patient would have enquired about. */
const CONDITION_INTEREST: Record<string, TreatmentKey> = {
  aga: "prp-hair",
  fue: "hair-transplant",
  acne: "acne",
  melasma: "pigmentation",
  eczema: "general-dermatology",
  psoriasis: "general-dermatology",
  rosacea: "general-dermatology",
  "alopecia-areata": "prp-hair",
  "laser-hr": "laser-hair-removal",
  warts: "general-dermatology",
};

const AR_TREATMENT: Record<TreatmentKey, string> = {
  "hair-transplant": "زراعة الشعر",
  "prp-hair": "جلسات البلازما للشعر",
  acne: "علاج حب الشباب",
  pigmentation: "علاج الكلف",
  "laser-hair-removal": "جلسة الليزر",
  "botox-fillers": "البوتوكس والفيلر",
  "general-dermatology": "كشف الجلدية",
};

const FIRST_F = ["Mai", "Shahd", "Habiba", "Jana", "Malak", "Rawan", "Esraa", "Doaa", "Marwa", "Noha", "Ghada", "Shaimaa", "Asmaa", "Aliaa", "Nada", "Rahma", "Basma", "Riham", "Yara", "Hagar"];
const FIRST_M = ["Mazen", "Seif", "Yassin", "Hamza", "Eslam", "Abdelrahman", "Moataz", "Walid", "Ayman", "Essam", "Fady", "Bassem", "Ramy", "Hesham", "Osama", "Ehab", "Tamer", "Wael", "Belal", "Marwan"];
const LAST = ["El-Sayed", "Abdallah", "Hegazy", "Soliman", "Ragab", "Badawy", "El-Masry", "Farouk", "Khalil", "Moussa", "Barakat", "Sabry", "Radwan", "Hosny", "Shawky", "Galal", "Sharaf", "Atef", "Nassar", "Zidan"];

/** Lead creation hours on the clinic clock: evenings are when Cairo writes to clinics. */
const HOURS: readonly (readonly [number, number])[] = [
  [9, 2], [10, 4], [11, 5], [12, 6], [13, 6], [14, 6], [15, 6], [16, 6], [17, 7], [18, 8], [19, 9], [20, 10], [21, 10], [22, 8], [23, 5], [0, 2], [1, 1],
];

const LOST_REASON_QUOTA: readonly (readonly [LostReason, number])[] = [
  ["NO_RESPONSE", 38],
  ["PRICE", 22],
  ["TIMING", 12],
  ["CHOSE_COMPETITOR", 9],
  ["DISTANCE", 8],
  ["NOT_A_FIT", 7],
  ["OTHER", 4],
];

/** Where in the pipeline each reason tends to bite. */
const LOST_STAGE: Record<LostReason, readonly (readonly [LeadStage, number])[]> = {
  NO_RESPONSE: [["NEW", 5], ["CONTACTED", 4], ["QUALIFIED", 1]],
  PRICE: [["QUALIFIED", 45], ["CONSULTATION_BOOKED", 20], ["CONSULTATION_ATTENDED", 35]],
  TIMING: [["CONTACTED", 4], ["QUALIFIED", 4], ["CONSULTATION_BOOKED", 2]],
  CHOSE_COMPETITOR: [["QUALIFIED", 1], ["CONSULTATION_ATTENDED", 1]],
  DISTANCE: [["CONTACTED", 1], ["QUALIFIED", 1]],
  NOT_A_FIT: [["QUALIFIED", 2], ["CONSULTATION_ATTENDED", 3]],
  OTHER: [["CONTACTED", 1], ["QUALIFIED", 1], ["CONSULTATION_BOOKED", 1]],
};

const LOST_NOTES: Record<LostReason, readonly string[]> = {
  NO_RESPONSE: ["Three WhatsApp messages and a call, no answer.", "Read the price list and went silent.", "مبيردش على الواتساب ولا التليفون."],
  PRICE: ["Package above budget; asked for installments.", "Compared with a cheaper offer; will not pay the difference.", "شايف السعر عالي حتى بالتقسيط."],
  TIMING: ["Wants to wait until after the summer.", "Exams this month; asked us to call after.", "هيأجل لبعد رمضان."],
  CHOSE_COMPETITOR: ["Booked with a clinic in Heliopolis closer to home.", "Went with the surgeon a friend recommended."],
  DISTANCE: ["Lives in Alexandria; too far for regular sessions.", "Moved to 6th of October, prefers a closer branch."],
  NOT_A_FIT: ["The doctor advised against the procedure at this stage.", "Donor area too weak for a transplant; offered PRP instead."],
  OTHER: ["Travelling abroad for work.", "Pregnant; will come back after delivery."],
};

const LEAD_NOTES: readonly string[] = [
  "Asked about FUE vs DHI; wants a weekend appointment.",
  "Prefers Arabic; call after 6 pm.",
  "Came with her sister, both interested in the laser package.",
  "Saw the before-and-after reel on Instagram.",
  "Wants to know if sessions can be done during Ramadan.",
  "Asked for a female doctor.",
  "عايز يعرف لو في تقسيط على ٦ شهور.",
  "سألت عن عرض الصيف على الليزر.",
  "Works shifts; mornings only.",
  "Referred by a patient who had a transplant last year.",
];

const FOLLOW_UP_NOTES: readonly string[] = [
  "Call back about the price list",
  "Send before-and-after photos",
  "Confirm the consultation time",
  "Check whether she wants the summer offer",
  "Ask if the installment plan helps",
  "ابعتله العنوان واللوكيشن",
  "كلمها بعد الامتحانات",
  "Remind about the free trichoscopy",
];

const FOLLOW_UP_OUTCOMES: readonly string[] = [
  "Sent prices on WhatsApp",
  "No answer, will try again tomorrow",
  "Booked a consultation",
  "Asked to call after Eid",
  "Sent before-and-after photos; she will decide this week",
  "اتكلمنا وطلب يفكر",
  "بعتنا العرض على الواتساب",
  "Confirmed the appointment by phone",
];

const OPENERS: Record<TreatmentKey, Record<Lang, readonly string[]>> = {
  "hair-transplant": {
    ar: ["السلام عليكم، شفت إعلانكم عن زراعة الشعر. ممكن تفاصيل؟", "بكام زراعة الشعر بتقنية الاقتطاف؟", "عندي صلع في المقدمة، محتاج كام بصيلة تقريباً؟"],
    en: ["Hi, I saw your ad. What does a hair transplant involve?", "Hello, what does an FUE transplant cost at your clinic?"],
  },
  "prp-hair": {
    ar: ["عندي تساقط شعر شديد من ٦ شهور، البلازما بتنفع؟", "سعر جلسة الـ PRP للشعر كام؟"],
    en: ["Does PRP help with thinning hair?", "How many PRP sessions would I need?"],
  },
  acne: {
    ar: ["عندي حبوب في وشي من سنتين ومش راضية تخف", "بكام جلسة التقشير لحب الشباب؟", "عايزة أحجز كشف حب شباب"],
    en: ["I have had acne for two years, can you help?", "How much is a chemical peel for acne scars?"],
  },
  pigmentation: {
    ar: ["عندي كلف في وشي بعد الولادة، بيتعالج؟", "علاج الكلف بياخد قد ايه؟ والنتيجة دايمة؟"],
    en: ["Do you treat melasma? Is the result permanent?", "I have dark spots after summer, what do you suggest?"],
  },
  "laser-hair-removal": {
    ar: ["عرض الليزر لسه موجود؟", "بكام جلسة الليزر للجسم كله؟ وهل بتوجع؟", "عايزة أحجز جلسة ليزر للوش"],
    en: ["Is the laser summer offer still on?", "How much is full-body laser hair removal? Does it hurt?"],
  },
  "botox-fillers": {
    ar: ["عايزة أسأل عن البوتوكس، بيقعد قد ايه؟", "سعر الفيلر للشفايف كام؟"],
    en: ["How long does botox last?", "What's the price for lip filler?"],
  },
  "general-dermatology": {
    ar: ["عندي حساسية في الجلد ومحتاج دكتور جلدية", "ممكن ميعاد كشف جلدية النهاردة؟"],
    en: ["Can I book a dermatologist for a rash?", "Do you see walk-ins for skin allergies?"],
  },
};

const OBJECTION_LINES: Record<ObjectionTag, Record<Lang, string>> = {
  PRICE: { ar: "غالي شوية، في خصم أو تقسيط؟", en: "That's a bit expensive. Any discount or installments?" },
  PAIN: { ar: "هي بتوجع؟", en: "Is it painful?" },
  DOWNTIME: { ar: "هحتاج اجازة من الشغل كام يوم؟", en: "How many days off work will I need?" },
  RESULTS_DOUBT: { ar: "النتيجة مضمونة؟", en: "Are the results guaranteed?" },
  TRUST: { ar: "ممكن أشوف تقييمات أو تجارب ناس عملت عندكم؟", en: "Do you have reviews from other patients?" },
  TIMING: { ar: "هفكر وأرد عليكم بعد العيد", en: "Let me think about it, maybe next month." },
};

const NEUTRAL_LINES: Record<Lang, readonly string[]> = {
  ar: ["تمام، احجزلي الثلاثاء", "شكراً", "ممكن العنوان؟", "طيب، في مواعيد بالليل؟", "تمام هستنى"],
  en: ["OK, please book Tuesday.", "Thanks!", "Where exactly is the clinic?", "Do you have evening slots?", "Great, thank you."],
};

const FOLLOW_REPLIES: Record<Lang, readonly string[]> = {
  ar: [
    "متاح استشارة يوم الثلاثاء الساعة ٥ أو الأربعاء الساعة ٧. أي ميعاد يناسبك؟",
    "الجلسة بتكون تحت بنج موضعي وأغلب المرضى بيرجعوا الشغل بعد يومين.",
    "نقدر نبعتلك صور قبل وبعد لحالات مشابهة 👍",
    "عندنا تقسيط على ٦ شهور بدون فوايد.",
    "تمام، هنكلمك بعد العيد إن شاء الله 🙏",
    "تم الحجز ✅ هنبعتلك تذكير قبلها بيوم.",
    "العيادة في ١٢ شارع حسن صبري، الزمالك. في جراج قريب.",
  ],
  en: [
    "We have consultation slots on Tuesday at 5 pm or Wednesday at 7 pm. Which suits you?",
    "It is done under local anaesthesia and most patients are back at work after two days.",
    "We can send you before-and-after photos of similar cases.",
    "We offer six-month installments with no interest.",
    "Of course, we will check in with you next month.",
    "Booked! We will send you a reminder the day before.",
    "We are at 12 Hassan Sabry St, Zamalek; there is a garage next door.",
  ],
};

interface LeadPlan {
  id: string;
  fullName: string;
  female: boolean;
  phone: string;
  email: string | null;
  language: Lang;
  source: LeadSource;
  campaignId: string | null;
  interests: TreatmentKey[];
  stage: LeadStage;
  ownerId: string | null;
  patientId: string | null;
  consultationAppointmentId: string | null;
  createdAt: Date;
  lastContactAt: Date | null;
  wonAt: Date | null;
  lostAt: Date | null;
  lostReason: LostReason | null;
  lostAtStage: LeadStage | null;
  lostNote: string | null;
  objections: ObjectionTag[];
  notes: string | null;
  /** Anchored to an appointment: its start (attended or upcoming consultation). */
  anchorAt: Date | null;
}

interface SeedMessage {
  direction: "INBOUND" | "OUTBOUND";
  author: MessageAuthor;
  authorId: string | null;
  body: string;
  templateKey?: string;
  createdAt: Date;
}

function shuffle<T>(items: readonly T[], r: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r.rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** `[[a, 2], [b, 1]]` → `[a, a, b]`, scaled so the counts add up to `total`. */
function quota<T>(weights: readonly (readonly [T, number])[], total: number): T[] {
  const sum = weights.reduce((s, [, w]) => s + w, 0);
  const exact = weights.map(([item, w]) => ({ item, n: (w / sum) * total }));
  const counts = exact.map((e) => ({ item: e.item, n: Math.floor(e.n), rest: e.n - Math.floor(e.n) }));
  let left = total - counts.reduce((s, c) => s + c.n, 0);
  for (const c of [...counts].sort((x, y) => y.rest - x.rest)) {
    if (left <= 0) break;
    c.n += 1;
    left -= 1;
  }
  return counts.flatMap((c) => Array.from({ length: c.n }, () => c.item));
}

function maxDate(...dates: (Date | null | undefined)[]): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date);
  return valid.length ? new Date(Math.max(...valid.map((d) => d.getTime()))) : null;
}

export async function seedCrm(ctx: SeedContext): Promise<void> {
  const r = makeRandom(11);
  const { db, tenantId } = ctx;
  const now = ctx.today.getTime();
  const nowDate = new Date(now);
  const clamp = (t: number, latest = now - 5 * MIN) => new Date(Math.min(t, latest));

  const owner = ctx.users.find((u) => u.email === "owner@demo.clinic") ?? ctx.users.find((u) => u.role === "CLINIC_OWNER")!;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? owner;
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });

  // Instants on the clinic clock.
  const at = (daysAgo: number, hour: number, minute: number) => {
    const day = ctx.calendarDay(-daysAgo);
    return ctx.zoned(day.y, day.m, day.d, hour, minute);
  };
  const enquiryTime = (daysAgo: number): Date => {
    const t = at(daysAgo, r.weighted(HOURS), r.between(0, 59));
    return t.getTime() > now - 10 * MIN ? new Date(now - r.between(15, 150) * MIN) : t;
  };
  const dayKey = (daysAgo: number) => {
    const d = ctx.calendarDay(-daysAgo);
    return new Date(Date.UTC(d.y, d.m - 1, d.d));
  };

  // ── Treatments and campaigns ───────────────────────────────────────────────
  const treatments = await listTreatments(tenantId, {}, db);
  const treatment = new Map(treatments.map((t) => [t.key, t]));
  const treatmentId = (key: TreatmentKey | null) => (key ? (treatment.get(key)?.id ?? null) : null);

  const campaignDefs = [
    { slot: "hair", externalId: "120210000000001", name: "Meta · Hair transplant click-to-WhatsApp", platform: "META", source: "CLICK_TO_WHATSAPP_AD", treatment: "hair-transplant", startedDaysAgo: 182 },
    { slot: "acne", externalId: "120210000000002", name: "Meta · Adult acne", platform: "META", source: "CLICK_TO_WHATSAPP_AD", treatment: "acne", startedDaysAgo: 160 },
    { slot: "laser", externalId: "120210000000003", name: "Meta · Laser summer offer", platform: "META", source: "CLICK_TO_WHATSAPP_AD", treatment: "laser-hair-removal", startedDaysAgo: 70 },
    { slot: "always", externalId: "120210000000004", name: "Meta · Always-on", platform: "META", source: "CLICK_TO_WHATSAPP_AD", treatment: "prp-hair", startedDaysAgo: 182 },
    { slot: "brand", externalId: "21034567890", name: "Google · Brand search", platform: "GOOGLE", source: "WEBSITE", treatment: null, startedDaysAgo: 182 },
    { slot: "melasma", externalId: "21034567891", name: "Google · Melasma treatment Cairo", platform: "GOOGLE", source: "WEBSITE", treatment: "pigmentation", startedDaysAgo: 120 },
  ] as const;
  const campaigns = campaignDefs.map((c) => ({ ...c, id: randomUUID(), startedAt: dayKey(c.startedDaysAgo) }));
  await db.campaign.createMany({
    data: campaigns.map((c) => ({
      id: c.id,
      tenantId,
      externalId: c.externalId,
      name: c.name,
      platform: c.platform,
      source: c.source,
      treatmentId: treatmentId(c.treatment),
      active: true,
      startedAt: c.startedAt,
      createdAt: c.startedAt,
    })),
  });
  const campaign = (slot: (typeof campaignDefs)[number]["slot"]) => campaigns.find((c) => c.slot === slot)!;
  const runningAt = (slot: (typeof campaignDefs)[number]["slot"], when: Date) => campaign(slot).startedAt.getTime() <= when.getTime();

  // ── Appointments the leads hang on ─────────────────────────────────────────
  const appointments = await db.appointment.findMany({
    where: { tenantId, deletedAt: null, status: { in: ["COMPLETED", "SCHEDULED", "CONFIRMED"] } },
    orderBy: { startsAt: "asc" },
    select: { id: true, patientId: true, startsAt: true, status: true, kind: true },
  });
  const firstCompleted = new Map<string, (typeof appointments)[number]>();
  const nextUpcoming = new Map<string, (typeof appointments)[number]>();
  for (const a of appointments) {
    if (a.status === "COMPLETED" && a.startsAt.getTime() < now - DAY) {
      const current = firstCompleted.get(a.patientId);
      if (!current || (current.kind !== "CONSULTATION" && a.kind === "CONSULTATION")) firstCompleted.set(a.patientId, a);
    } else if (a.status !== "COMPLETED" && a.startsAt.getTime() > now + 2 * HOUR) {
      const current = nextUpcoming.get(a.patientId);
      if (!current || (current.kind !== "CONSULTATION" && a.kind === "CONSULTATION")) nextUpcoming.set(a.patientId, a);
    }
  }
  const usedPatients = new Set<string>();
  const patientPool = shuffle(ctx.patients, r);
  const interestOf = (p: SeedPatient): TreatmentKey => CONDITION_INTEREST[p.condKey] ?? "general-dermatology";
  /** A free patient (matching `ok`), chosen so the treatments they came for follow the enquiry weights. */
  function takePatient(ok: (p: SeedPatient) => boolean): SeedPatient | null {
    const groups = new Map<TreatmentKey, SeedPatient[]>();
    for (const p of patientPool) {
      if (usedPatients.has(p.id) || !ok(p)) continue;
      groups.set(interestOf(p), [...(groups.get(interestOf(p)) ?? []), p]);
    }
    const options = INTEREST_WEIGHTS.filter(([key]) => groups.has(key));
    if (!options.length) return null;
    const pick = groups.get(r.weighted(options))![0]!;
    usedPatients.add(pick.id);
    return pick;
  }

  // ── Leads ──────────────────────────────────────────────────────────────────
  const STAGE_QUOTA: readonly (readonly [LeadStage, number])[] = [
    ["NEW", 9],
    ["CONTACTED", 21],
    ["QUALIFIED", 26],
    ["CONSULTATION_BOOKED", 12],
    ["CONSULTATION_ATTENDED", 7],
    ["PROCEDURE_BOOKED", 6],
    ["WON", 17],
    ["LOST", 42],
  ];
  const stages = shuffle(
    STAGE_QUOTA.flatMap(([stage, n]) => Array.from({ length: n }, () => stage)),
    r,
  );
  const sources = shuffle(
    quota<LeadSource>(
      [
        ["CLICK_TO_WHATSAPP_AD", 38],
        ["INSTAGRAM_ORGANIC", 22],
        ["WEBSITE", 14],
        ["REFERRAL", 12],
        ["WALK_IN", 6],
        ["PHONE", 8],
      ],
      stages.length,
    ),
    r,
  );
  const lostReasons = shuffle(quota(LOST_REASON_QUOTA, stages.filter((s) => s === "LOST").length), r);
  const usedNames = new Set(ctx.patients.map((p) => p.fullName));
  const usedPhones = new Set(ctx.patients.map((p) => p.phone));

  const freshName = (female: boolean) => {
    let name = "";
    do name = `${r.pick(female ? FIRST_F : FIRST_M)} ${r.pick(LAST)}`;
    while (usedNames.has(name));
    usedNames.add(name);
    return name;
  };
  const freshPhone = () => {
    let phone = "";
    do phone = egyptianMobile(r);
    while (usedPhones.has(phone));
    usedPhones.add(phone);
    return phone;
  };

  const leads: LeadPlan[] = [];
  const twoInterests = new Set(shuffle(stages.map((_, i) => i), r).slice(0, Math.round(stages.length * 0.15)));
  let wonAnchored = 0;
  stages.forEach((stage, i) => {
    const source = sources[i]!;
    let createdAt: Date;
    let patient: SeedPatient | null = null;
    let consultationAppointmentId: string | null = null;
    let anchorAt: Date | null = null;

    // Leads that reached a consultation are the clinic's patients now, tied to
    // the completed consultation that converted them (or the booked one).
    const attended = stage === "CONSULTATION_ATTENDED" || stage === "PROCEDURE_BOOKED" || (stage === "WON" && wonAnchored < 10);
    if (attended && (patient = takePatient((p) => firstCompleted.has(p.id)))) {
      const appt = firstCompleted.get(patient.id)!;
      consultationAppointmentId = appt.id;
      anchorAt = appt.startsAt;
      createdAt = clamp(appt.startsAt.getTime() - r.between(2, 9) * DAY + (r.weighted(HOURS) - 12) * HOUR + r.between(0, 59) * MIN);
      if (stage === "WON") wonAnchored += 1;
    } else if (stage === "CONSULTATION_BOOKED" && (patient = takePatient((p) => nextUpcoming.has(p.id)))) {
      const appt = nextUpcoming.get(patient.id)!;
      consultationAppointmentId = appt.id;
      anchorAt = appt.startsAt;
      createdAt = enquiryTime(r.between(2, 18));
    } else if (stage === "WON") {
      patient = takePatient(() => true);
      createdAt = enquiryTime(r.between(45, 180));
    } else if (stage === "NEW") {
      createdAt = enquiryTime(r.weighted([[0, 4], [1, 3], [2, 2], [4, 1], [7, 1]] as const));
    } else if (stage === "CONTACTED") {
      createdAt = enquiryTime(r.weighted([[2, 2], [6, 3], [12, 3], [25, 3], [45, 3], [70, 2], [100, 1], [140, 1]] as const) + r.between(0, 4));
    } else if (stage === "QUALIFIED") {
      createdAt = enquiryTime(r.weighted([[3, 2], [8, 3], [15, 3], [30, 3], [50, 3], [80, 2], [120, 2], [160, 1]] as const) + r.between(0, 5));
    } else if (stage === "CONSULTATION_BOOKED") {
      createdAt = enquiryTime(r.between(2, 18));
    } else if (stage === "LOST") {
      createdAt = enquiryTime(r.between(3, 180));
    } else {
      createdAt = enquiryTime(r.between(10, 60));
    }

    // Google's melasma ads bring melasma searches to the website.
    const interest: TreatmentKey = patient ? interestOf(patient) : source === "WEBSITE" && r.chance(0.45) ? "pigmentation" : r.weighted(INTEREST_WEIGHTS);
    const female = patient ? patient.gender === "FEMALE" : r.chance(FEMALE_SHARE[interest]);
    const fullName = patient ? patient.fullName : freshName(female);
    const phone = patient ? patient.phone : freshPhone();
    const language: Lang = patient ? (patient.language === "en" ? "en" : "ar") : r.chance(0.8) ? "ar" : "en";
    const interests: TreatmentKey[] = [interest];
    if (twoInterests.has(i)) interests.push(r.weighted(INTEREST_WEIGHTS.filter(([k]) => k !== interest)));

    let campaignId: string | null = null;
    if (source === "CLICK_TO_WHATSAPP_AD") {
      campaignId =
        interest === "hair-transplant"
          ? campaign("hair").id
          : interest === "acne" && runningAt("acne", createdAt)
            ? campaign("acne").id
            : interest === "laser-hair-removal" && runningAt("laser", createdAt)
              ? campaign("laser").id
              : campaign("always").id;
    } else if (source === "WEBSITE" && r.chance(0.75)) {
      campaignId = interest === "pigmentation" && runningAt("melasma", createdAt) ? campaign("melasma").id : campaign("brand").id;
    }

    const first = fullName.split(" ")[0]!.toLowerCase().replace(/[^a-z]/g, "");
    const last = fullName.split(" ").slice(1).join("").toLowerCase().replace(/[^a-z]/g, "");
    leads.push({
      id: randomUUID(),
      fullName,
      female,
      phone,
      email: r.chance(0.3) ? `${first}.${last}${r.between(1, 99)}@gmail.com` : null,
      language,
      source,
      campaignId,
      interests,
      stage,
      ownerId: stage === "NEW" && r.chance(0.3) ? null : r.chance(0.75) ? reception.id : owner.id,
      patientId: patient?.id ?? null,
      consultationAppointmentId,
      createdAt,
      lastContactAt: null,
      wonAt: null,
      lostAt: null,
      lostReason: null,
      lostAtStage: null,
      lostNote: null,
      objections: [],
      notes: r.chance(0.35) ? r.pick(LEAD_NOTES) : null,
      anchorAt,
    });
  });

  // Outcomes: when they were won or lost, why, and what staff heard.
  let lostIndex = 0;
  for (const lead of leads) {
    const created = lead.createdAt.getTime();
    if (lead.stage === "LOST") {
      const reason = lostReasons[lostIndex++]!;
      lead.lostReason = reason;
      lead.lostAtStage = r.weighted(LOST_STAGE[reason]);
      lead.lostNote = r.chance(0.8) ? r.pick(LOST_NOTES[reason]) : null;
      const span = Math.max(HOUR, Math.min(r.between(2, 21) * DAY, now - created - 2 * HOUR));
      lead.lostAt = clamp(created + span);
    } else if (lead.stage === "WON") {
      const base = lead.anchorAt ? lead.anchorAt.getTime() + r.between(2, 12) * DAY : created + r.between(15, 40) * DAY;
      lead.wonAt = clamp(base, now - HOUR);
    }
  }
  const lost = leads.filter((l) => l.stage === "LOST");
  const withObjections = new Set(shuffle(lost, r).slice(0, Math.round(lost.length * 0.6)).map((l) => l.id));
  for (const lead of lost) {
    if (!withObjections.has(lead.id)) continue;
    const base: ObjectionTag[] =
      lead.lostReason === "PRICE"
        ? ["PRICE"]
        : lead.lostReason === "TIMING" || lead.lostReason === "OTHER"
          ? ["TIMING"]
          : lead.lostReason === "CHOSE_COMPETITOR"
            ? [r.pick(["PRICE", "TRUST"] as const)]
            : lead.lostReason === "NOT_A_FIT"
              ? ["RESULTS_DOUBT"]
              : lead.lostReason === "DISTANCE"
                ? ["DOWNTIME"]
                : [r.pick(["PRICE", "TRUST", "RESULTS_DOUBT"] as const)];
    if (r.chance(0.3)) base.push(r.pick(["PAIN", "DOWNTIME", "RESULTS_DOUBT"] as const));
    lead.objections = [...new Set(base)];
  }
  for (const lead of leads.filter((l) => l.stage === "WON")) {
    if (r.chance(0.3)) lead.objections = [r.pick(["PAIN", "DOWNTIME", "PRICE"] as const)];
  }

  // ── Conversations on leads (~60) ───────────────────────────────────────────
  const conversationRows: Prisma.ConversationCreateManyInput[] = [];
  const messageRows: Prisma.MessageCreateManyInput[] = [];
  const humanTouch = new Map<string, Date>();
  const bySource = (source: LeadSource, n: number) => shuffle(leads.filter((l) => l.source === source), r).slice(0, n);
  const threadLeads = [...bySource("CLICK_TO_WHATSAPP_AD", 44), ...bySource("INSTAGRAM_ORGANIC", 6), ...bySource("WEBSITE", 7), ...bySource("PHONE", 3)];
  const channelOf = (source: LeadSource): ChannelType => (source === "WEBSITE" ? "WEB_CHAT" : source === "PHONE" ? "SMS" : "WHATSAPP");

  for (const lead of threadLeads) {
    const channel = channelOf(lead.source);
    const interest = lead.interests[0]!;
    const lang = lead.language;
    const start = lead.createdAt.getTime();
    const closedAt = lead.lostAt ?? lead.wonAt;
    const ageDays = (now - start) / DAY;
    const endsWithPatient = !closedAt && (ageDays < 3 ? r.chance(0.6) : ageDays < 10 ? r.chance(0.15) : false);
    // Open leads that went quiet get chased: a nudge from reception in the last few days.
    const nudge = !closedAt && ageDays > 5 && r.chance(0.6);
    const length = nudge ? r.pick([2, 2, 4]) : r.pick(endsWithPatient ? [3, 5] : [2, 4, 4, 6]);
    const startHour = zonedParts(lead.createdAt, TIMEZONE).hour;
    const office = startHour >= 10 && startHour <= 21;
    // A closed lead's thread ends before the lead was won or lost.
    const limit = closedAt ? Math.min(now - MIN, closedAt.getTime() - 10 * MIN) : now - MIN;
    const firstByHuman = office && r.chance(0.35);
    const handoff = !firstByHuman && r.chance(0.4);
    const staffId = lead.ownerId ?? reception.id;

    const msgs: SeedMessage[] = [];
    let t = start;
    const objectionQueue: ObjectionTag[] = [...lead.objections];
    for (let i = 0; i < length; i++) {
      if (i % 2 === 0) {
        if (i > 0) t += r.chance(0.2) ? r.between(4, 20) * HOUR : r.between(1, 45) * MIN;
        const body =
          i === 0
            ? r.pick(OPENERS[interest][lang])
            : objectionQueue.length
              ? OBJECTION_LINES[objectionQueue.shift()!][lang]
              : r.chance(0.35)
                ? OBJECTION_LINES[r.pick(["PRICE", "PAIN", "DOWNTIME", "RESULTS_DOUBT", "TRUST", "TIMING"] as const)][lang]
                : r.pick(NEUTRAL_LINES[lang]);
        if (t > limit) break;
        msgs.push({ direction: "INBOUND", author: "PATIENT", authorId: null, body, createdAt: new Date(t) });
      } else {
        const human = i === 1 ? firstByHuman : firstByHuman || handoff;
        t += human ? (i === 1 ? r.between(8, 40) * MIN : r.between(3, 25) * MIN) : r.between(20, 90) * 1000;
        if (t > limit) break;
        const price = treatment.get(interest)?.priceFrom ?? 0;
        const body =
          i === 1
            ? lang === "ar"
              ? `أهلاً بحضرتك في ${tenant.name.includes("Aura") ? "عيادة أورا" : tenant.name} 🌿 ${AR_TREATMENT[interest]} بيبدأ من ${price.toLocaleString("en-US")} جنيه والسعر النهائي بيتحدد بعد الكشف. تحب نحجزلك استشارة؟`
              : `Welcome to ${tenant.name}! ${treatment.get(interest)?.name ?? "The treatment"} starts from ${price.toLocaleString("en-US")} EGP; the final price is set at the consultation. Would you like to book one?`
            : r.pick(FOLLOW_REPLIES[lang]);
        msgs.push({ direction: "OUTBOUND", author: human ? "HUMAN" : "AI", authorId: human ? staffId : null, body, createdAt: new Date(t) });
        if (human) humanTouch.set(lead.id, new Date(t));
      }
    }
    if (!msgs.length) continue;
    if (nudge) {
      let tn = now - r.between(6, 96) * HOUR;
      if (tn > msgs[msgs.length - 1]!.createdAt.getTime() + DAY) {
        const firstName = lead.fullName.split(" ")[0];
        const staffName = (ctx.users.find((u) => u.id === staffId)?.fullName ?? reception.fullName).replace(/^Dr\. /, "").split(" ")[0];
        msgs.push({
          direction: "OUTBOUND",
          author: "HUMAN",
          authorId: staffId,
          body:
            lang === "ar"
              ? `أهلاً ${firstName}، معاك ${staffName} من عيادة أورا. حابين نطمن إن كل حاجة واضحة بخصوص استفسارك. لو عندك أي سؤال أو حابب تحجز، إحنا هنا 🙏`
              : `Hi ${firstName}, this is ${staffName} from Aura Clinic. Just checking whether you have any questions about your enquiry — happy to book you in whenever suits you.`,
          templateKey: `follow-up-nudge-${lang}`,
          createdAt: new Date(tn),
        });
        humanTouch.set(lead.id, new Date(tn));
        tn += r.between(10, 180) * MIN;
        if (r.chance(0.55) && tn < now - MIN) {
          const objection = r.chance(0.5) ? r.pick(["PRICE", "TIMING", "DOWNTIME", "PAIN"] as const) : null;
          msgs.push({ direction: "INBOUND", author: "PATIENT", authorId: null, body: objection ? OBJECTION_LINES[objection][lang] : r.pick(NEUTRAL_LINES[lang]), createdAt: new Date(tn) });
        }
      }
    }

    const last = msgs[msgs.length - 1]!;
    const lastAt = last.createdAt.getTime();
    let status: ConversationStatus;
    let threadClosedAt: Date | null = null;
    if (closedAt) {
      status = "CLOSED";
      threadClosedAt = clamp(Math.max(lastAt + HOUR, closedAt.getTime()));
    } else if (last.direction === "INBOUND") {
      status = "WAITING_ON_CLINIC";
    } else if (now - lastAt < 5 * DAY) {
      status = last.author === "HUMAN" && r.chance(0.3) ? "OPEN" : "WAITING_ON_PATIENT";
    } else {
      status = "CLOSED";
      threadClosedAt = clamp(lastAt + 2 * HOUR);
    }
    const suggested = [...new Set(msgs.filter((m) => m.direction === "INBOUND").flatMap((m) => tagObjections(m.body)))] as ObjectionTag[];
    const confirmed = closedAt && lead.objections.length ? lead.objections : null;
    const conversationId = randomUUID();
    const humanHandled = msgs.some((m) => m.author === "HUMAN");
    conversationRows.push({
      id: conversationId,
      tenantId,
      patientId: lead.patientId,
      leadId: lead.id,
      channel,
      externalId: channel === "WHATSAPP" ? lead.phone.replace(/\D/g, "") : `${channel.toLowerCase()}_${r.between(100000, 999999)}`,
      locale: lang,
      status,
      assignedToId: humanHandled || status === "WAITING_ON_CLINIC" ? staffId : null,
      objections: confirmed ?? suggested,
      objectionsConfirmedAt: confirmed ? (threadClosedAt ?? closedAt) : null,
      contactName: lead.fullName,
      contactPhone: lead.phone,
      lastInboundAt: maxDate(...msgs.filter((m) => m.direction === "INBOUND").map((m) => m.createdAt)),
      lastOutboundAt: maxDate(...msgs.filter((m) => m.direction === "OUTBOUND").map((m) => m.createdAt)),
      closedAt: threadClosedAt,
      createdAt: msgs[0]!.createdAt,
      updatedAt: last.createdAt,
    });
    msgs.forEach((m, i) => {
      const next = msgs[i + 1];
      const trailingUnread = status === "WAITING_ON_CLINIC" && m.direction === "INBOUND" && !msgs.slice(i + 1).some((x) => x.direction === "OUTBOUND");
      const delivery: MessageDelivery = m.direction === "INBOUND" ? "DELIVERED" : next ? "READ" : now - m.createdAt.getTime() > HOUR ? "DELIVERED" : "SENT";
      messageRows.push({
        tenantId,
        conversationId,
        direction: m.direction,
        author: m.author,
        authorId: m.authorId,
        body: m.body,
        templateKey: m.templateKey ?? null,
        delivery,
        externalId: channel === "WHATSAPP" ? `wamid.seed${randomUUID().replace(/-/g, "").slice(0, 20)}` : null,
        deliveredAt: delivery === "SENT" ? null : new Date(m.createdAt.getTime() + (m.direction === "INBOUND" ? 0 : 4000)),
        readAt: m.direction === "INBOUND" && !trailingUnread ? new Date(m.createdAt.getTime() + r.between(1, 10) * MIN) : null,
        createdAt: m.createdAt,
      });
    });
  }

  // ── Follow-ups: ~25 open (8 overdue) and ~40 done ──────────────────────────
  const followUps: Prisma.LeadFollowUpCreateManyInput[] = [];
  const doneTouch = new Map<string, Date>();
  const openCandidates = shuffle(
    leads.filter((l) => ["CONTACTED", "QUALIFIED", "CONSULTATION_BOOKED", "CONSULTATION_ATTENDED", "PROCEDURE_BOOKED", "NEW"].includes(l.stage)),
    r,
  );
  const overdueLeads = openCandidates.filter((l) => l.stage !== "NEW" && now - l.createdAt.getTime() > 2 * DAY).slice(0, 8);
  const restOpen = openCandidates.filter((l) => !overdueLeads.includes(l)).slice(0, 17);
  for (const lead of overdueLeads) {
    const dueAt = new Date(Math.max(lead.createdAt.getTime() + HOUR, now - r.between(1, 5) * DAY - r.between(0, 6) * HOUR));
    followUps.push({ tenantId, leadId: lead.id, ownerId: lead.ownerId ?? reception.id, dueAt, note: r.pick(FOLLOW_UP_NOTES), channel: r.chance(0.7) ? "WHATSAPP" : "VOICE", createdById: lead.ownerId ?? reception.id, createdAt: new Date(dueAt.getTime() - r.between(1, 3) * DAY) });
  }
  const todayEnd = (() => {
    const d = ctx.calendarDay(0);
    return ctx.zoned(d.y, d.m, d.d, 21, 0).getTime();
  })();
  restOpen.forEach((lead, i) => {
    let due: number;
    if (i < 5 && todayEnd - now > HOUR) due = now + r.between(30, Math.floor((todayEnd - now) / MIN) - 10) * MIN;
    else {
      const days = r.between(1, 10);
      const day = ctx.calendarDay(days);
      due = ctx.zoned(day.y, day.m, day.d, r.pick([10, 11, 12, 14, 16, 18, 19]), r.pick([0, 15, 30, 45])).getTime();
    }
    followUps.push({ tenantId, leadId: lead.id, ownerId: lead.ownerId ?? reception.id, dueAt: new Date(due), note: r.pick(FOLLOW_UP_NOTES), channel: r.chance(0.7) ? "WHATSAPP" : "VOICE", createdById: lead.ownerId ?? reception.id, createdAt: clamp(now - r.between(1, 48) * HOUR) });
  });
  const doneCandidates = shuffle(
    leads.filter((l) => l.stage !== "NEW" && now - l.createdAt.getTime() > 2 * DAY),
    r,
  ).slice(0, 38);
  let doneCount = 0;
  for (const [index, lead] of doneCandidates.entries()) {
    const rounds = index < 10 ? 2 : 1;
    const end = (lead.lostAt ?? lead.wonAt ?? nowDate).getTime() - HOUR;
    for (let k = 0; k < rounds && doneCount < 40; k++) {
      const dueAt = lead.createdAt.getTime() + r.between(1, 4) * DAY + k * r.between(2, 5) * DAY;
      if (dueAt >= end) break;
      const doneAt = Math.min(dueAt + r.between(0, 6) * HOUR, end);
      const by = lead.ownerId ?? reception.id;
      followUps.push({
        tenantId,
        leadId: lead.id,
        ownerId: by,
        dueAt: new Date(dueAt),
        note: r.pick(FOLLOW_UP_NOTES),
        channel: r.chance(0.7) ? "WHATSAPP" : "VOICE",
        doneAt: new Date(doneAt),
        doneById: by,
        outcome: r.pick(FOLLOW_UP_OUTCOMES),
        createdById: by,
        createdAt: new Date(dueAt - r.between(1, 2) * DAY),
      });
      doneTouch.set(lead.id, maxDate(doneTouch.get(lead.id), new Date(doneAt))!);
      doneCount += 1;
    }
  }

  // Last contact: the latest staff touch, the stage change, or nothing for a NEW lead.
  for (const lead of leads) {
    if (lead.stage === "NEW") {
      lead.lastContactAt = humanTouch.get(lead.id) ?? null;
      continue;
    }
    const created = lead.createdAt.getTime();
    const stageTouch = lead.lostAt ?? lead.wonAt ?? clamp(created + Math.max(20 * MIN, (now - created) * (0.2 + r.rand() * 0.6)));
    lead.lastContactAt = maxDate(stageTouch, humanTouch.get(lead.id), doneTouch.get(lead.id));
  }

  await db.lead.createMany({
    data: leads.map((l) => ({
      id: l.id,
      tenantId,
      patientId: l.patientId,
      fullName: l.fullName,
      phone: l.phone,
      whatsapp: l.phone,
      email: l.email,
      source: l.source,
      campaignId: l.campaignId,
      interests: l.interests,
      stage: l.stage,
      ownerId: l.ownerId,
      lostReason: l.lostReason,
      lostAtStage: l.lostAtStage,
      lostAt: l.lostAt,
      lostNote: l.lostNote,
      objections: l.objections,
      consultationAppointmentId: l.consultationAppointmentId,
      notes: l.notes,
      firstTouchAt: l.createdAt,
      lastContactAt: l.lastContactAt,
      wonAt: l.wonAt,
      createdAt: l.createdAt,
      updatedAt: maxDate(l.lastContactAt, l.createdAt)!,
    })),
  });
  await db.leadFollowUp.createMany({ data: followUps });
  await db.conversation.createMany({ data: conversationRows });
  await db.message.createMany({ data: messageRows });

  // Patients who came in as leads: first-touch source, the LEAD event, the booking's lead.
  const linked = leads.filter((l) => l.patientId);
  const referrers = ctx.patients.map((p) => p.fullName);
  await db.$transaction([
    ...linked.map((l) =>
      db.patient.updateMany({
        where: { id: l.patientId!, tenantId, source: null },
        data: { source: l.source, referredBy: l.source === "REFERRAL" ? r.pick(referrers.filter((n) => n !== l.fullName)) : null },
      }),
    ),
    ...linked
      .filter((l) => l.consultationAppointmentId)
      .map((l) => db.appointment.updateMany({ where: { id: l.consultationAppointmentId!, tenantId }, data: { leadId: l.id } })),
  ]);
  await db.timelineEvent.createMany({
    data: linked.map((l) => ({
      tenantId,
      patientId: l.patientId!,
      kind: "LEAD" as const,
      title: `Came in as a lead (${SOURCE_LABELS[l.source]})`,
      body: `Interested in: ${l.interests.map((k) => treatment.get(k)?.name ?? k).join(", ")}`,
      refId: l.id,
      occurredAt: l.createdAt,
    })),
  });

  await fixCoreConversations(ctx, r, { receptionId: reception.id, excludeIds: new Set(conversationRows.map((c) => c.id!)), freshName, freshPhone });

  // Two enquiries from numbers nobody has filed yet, waiting on the desk: what
  // "Create lead from this thread" is for.
  const strangers = [
    { channel: "WHATSAPP" as const, name: "Omar Nabil", locale: "en", script: [["INBOUND", 25 * MIN, "Hi, do you do laser hair removal for men? How much for the back?"]] },
    {
      channel: "WEB_CHAT" as const,
      name: null,
      locale: "ar",
      script: [
        ["INBOUND", 2 * HOUR, "السلام عليكم، عندي تساقط شعر بعد الولادة، ممكن أعرف المواعيد المتاحة؟"],
        ["OUTBOUND", 2 * HOUR - 40_000, "أهلاً بحضرتك 🌿 نقدر نحجزلك كشف تساقط شعر مع د. عمر فهمي. تحبي الأسبوع ده ولا الجاي؟"],
        ["INBOUND", 2 * HOUR - 12 * MIN, "الأسبوع ده لو ينفع. بكام الكشف؟"],
      ],
    },
  ] as const;
  for (const s of strangers) {
    const id = randomUUID();
    const msgs = s.script.map(([direction, ago, body]) => ({ direction, at: new Date(now - ago), body }));
    const inbound = msgs.filter((m) => m.direction === "INBOUND");
    await db.conversation.create({
      data: {
        id,
        tenantId,
        channel: s.channel,
        locale: s.locale,
        status: "WAITING_ON_CLINIC",
        contactName: s.name,
        contactPhone: freshPhone(),
        objections: [...new Set(inbound.flatMap((m) => tagObjections(m.body)))] as ObjectionTag[],
        lastInboundAt: inbound[inbound.length - 1]!.at,
        lastOutboundAt: msgs.filter((m) => m.direction === "OUTBOUND").pop()?.at ?? null,
        createdAt: msgs[0]!.at,
        updatedAt: msgs[msgs.length - 1]!.at,
        messages: {
          create: msgs.map((m) => ({
            tenantId,
            direction: m.direction,
            author: m.direction === "INBOUND" ? "PATIENT" : "AI",
            body: m.body,
            delivery: m.direction === "INBOUND" ? "DELIVERED" : "READ",
            deliveredAt: m.at,
            createdAt: m.at,
          })),
        },
      },
    });
  }

  // ── Templates and the (unconnected) WhatsApp channel ───────────────────────
  await db.messageTemplate.createMany({
    data: DEFAULT_TEMPLATES.map((t) => ({ tenantId, key: t.key, name: t.name, language: t.language, category: t.category, body: t.body, active: true })),
    skipDuplicates: true,
  });
  await db.channelIntegration.upsert({
    where: { tenantId_channel: { tenantId, channel: "WHATSAPP" } },
    create: { tenantId, channel: "WHATSAPP", provider: "manual", enabled: false, config: {} },
    update: {},
  });

  const reached = leads.filter((l) => ["CONSULTATION_BOOKED", "CONSULTATION_ATTENDED", "PROCEDURE_BOOKED", "WON"].includes(l.stage) || ["CONSULTATION_BOOKED", "CONSULTATION_ATTENDED", "PROCEDURE_BOOKED"].includes(l.lostAtStage ?? "")).length;
  console.log(
    `     ${campaigns.length} campaigns, ${leads.length} leads (${reached} reached a consultation, ${leads.filter((l) => l.stage === "WON").length} won, ${lost.length} lost, ${linked.length} linked to patients), ` +
      `${followUps.filter((f) => !f.doneAt).length} open follow-ups (${overdueLeads.length} overdue) and ${followUps.filter((f) => f.doneAt).length} done, ${conversationRows.length} lead conversations with ${messageRows.length} messages`,
  );
}

/**
 * The core seed's 26 AI-receptionist threads: replies by the AI (`meta.by`)
 * or by reception, inbound messages from the patient, delivered and read;
 * contact name and number; status from how recent the thread is; first and
 * last message stamps; suggested objection tags.
 */
async function fixCoreConversations(
  ctx: SeedContext,
  r: Random,
  opts: { receptionId: string; excludeIds: Set<string>; freshName: (female: boolean) => string; freshPhone: () => string },
): Promise<void> {
  const { db, tenantId } = ctx;
  const now = ctx.today.getTime();
  const threads = await db.conversation.findMany({
    where: { tenantId, id: { notIn: [...opts.excludeIds] } },
    include: {
      messages: { orderBy: { createdAt: "asc" }, select: { id: true, direction: true, meta: true, body: true, createdAt: true } },
      patient: { select: { fullName: true, phone: true, whatsapp: true } },
    },
  });
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const thread of threads) {
    const msgs = thread.messages;
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1]!;
    const lastAt = last.createdAt.getTime();
    const recent = now - lastAt < 2 * DAY;
    const status: ConversationStatus = last.direction === "INBOUND" ? "WAITING_ON_CLINIC" : recent ? "WAITING_ON_PATIENT" : "CLOSED";
    const inbound = msgs.filter((m) => m.direction === "INBOUND");
    const outbound = msgs.filter((m) => m.direction === "OUTBOUND");
    let byReception = false;
    msgs.forEach((m, i) => {
      if (m.direction === "INBOUND") {
        const answered = msgs.slice(i + 1).some((x) => x.direction === "OUTBOUND");
        updates.push(
          db.message.update({
            where: { id: m.id },
            data: { author: "PATIENT", authorId: null, delivery: "DELIVERED", deliveredAt: m.createdAt, readAt: answered || status === "CLOSED" ? new Date(m.createdAt.getTime() + r.between(1, 5) * MIN) : null },
          }),
        );
      } else {
        const ai = (m.meta as { by?: unknown } | null)?.by === "ai";
        if (!ai) byReception = true;
        const readByPatient = msgs.slice(i + 1).some((x) => x.direction === "INBOUND");
        updates.push(
          db.message.update({
            where: { id: m.id },
            data: { author: ai ? "AI" : "HUMAN", authorId: ai ? null : opts.receptionId, delivery: readByPatient ? "READ" : "DELIVERED", deliveredAt: new Date(m.createdAt.getTime() + 4000) },
          }),
        );
      }
    });
    const female = r.chance(0.6);
    updates.push(
      db.conversation.update({
        where: { id: thread.id },
        data: {
          contactName: thread.patient?.fullName ?? opts.freshName(female),
          contactPhone: thread.patient?.whatsapp ?? thread.patient?.phone ?? opts.freshPhone(),
          status,
          closedAt: status === "CLOSED" ? new Date(lastAt + HOUR) : null,
          assignedToId: byReception || status !== "CLOSED" ? opts.receptionId : null,
          lastInboundAt: inbound.length ? inbound[inbound.length - 1]!.createdAt : null,
          lastOutboundAt: outbound.length ? outbound[outbound.length - 1]!.createdAt : null,
          objections: [...new Set(inbound.flatMap((m) => tagObjections(m.body)))] as ObjectionTag[],
          updatedAt: last.createdAt,
        },
      }),
    );
  }
  await db.$transaction(updates);
}
