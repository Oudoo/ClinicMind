import type { Prisma } from "@prisma/client";
import { IntakeFormInput } from "../../src/modules/intake/form";
import { issueIntakeToken } from "../../src/modules/intake/tokens";
import { conflictingMedications } from "./clinical";
import type { SeedContext, SeedPatient } from "./index";
import { daysAfter, daysBefore, egyptianMobile, makeRandom, type Random } from "./util";

/**
 * Onboarding for the demo clinic: the reception desk's open QR link, two
 * personal links still waiting to be filled, and three forms in the review
 * queue — one from a registered patient (same phone number, so the queue
 * offers "Merge into …"), one new patient who answered in English and one
 * who answered entirely in Arabic (Arabic-Indic digits included).
 *
 * Tokens come from the same helper the intake service uses (`generateToken`,
 * keyed hash stored, eight-character prefix kept), and every form goes
 * through the public POST's zod schema, so `acceptSubmission()` reads exactly
 * what a real submission stores. The raw token of the desk link is printed
 * once, like the embed secret; nothing else can recover it.
 */

const DESK_LABEL = "Reception desk QR";

type Lang = "ar" | "en";

/** What brings them in, per treatment key, in both languages. */
const CONCERNS: Record<string, { en: string; ar: string; sinceEn: string; sinceAr: string }> = {
  "hair-transplant": {
    en: "Thinning at the crown and a receding hairline; I would like to know whether I am a candidate for a transplant.",
    ar: "خفة في الشعر عند التاج وانحسار في مقدمة الرأس، وعايز أعرف لو أنا مناسب للزراعة.",
    sinceEn: "About two years",
    sinceAr: "من حوالي سنتين",
  },
  "prp-hair": {
    en: "Heavy shedding when I wash my hair and a wider parting than before.",
    ar: "تساقط شديد مع غسيل الشعر والفرق بقى أوسع من الأول.",
    sinceEn: "Eight months",
    sinceAr: "من ٨ شهور",
  },
  acne: {
    en: "Painful spots on the jawline that flare before my period, and dark marks they leave behind.",
    ar: "حبوب مؤلمة على الفك بتزيد قبل الدورة، وبتسيب آثار غامقة.",
    sinceEn: "Since university",
    sinceAr: "من أيام الجامعة",
  },
  pigmentation: {
    en: "Brown patches on both cheeks that get darker every summer.",
    ar: "بقع بني على الخدين بتغمق كل صيف.",
    sinceEn: "Three summers",
    sinceAr: "من ٣ سنين",
  },
  "laser-hair-removal": {
    en: "I would like to start laser hair removal for the face and underarms; waxing irritates my skin.",
    ar: "عايزة أبدأ ليزر إزالة الشعر للوش وتحت الإبط، الشمع بيعمل لي تهيج.",
    sinceEn: "Waxing for years",
    sinceAr: "بستخدم الشمع من سنين",
  },
  "general-dermatology": {
    en: "An itchy, dry rash on the elbows that keeps coming back.",
    ar: "طفح جلدي جاف وبيهرش على الكوعين وبيرجع كل شوية.",
    sinceEn: "A few months",
    sinceAr: "من كام شهر",
  },
};

/** The treatment a core-seed scenario is about. */
const TREATMENT_FOR_CONDITION: Record<string, string> = {
  aga: "prp-hair",
  "alopecia-areata": "prp-hair",
  fue: "hair-transplant",
  acne: "acne",
  melasma: "pigmentation",
  "laser-hr": "laser-hair-removal",
};

const NEW_HISTORY: Record<Lang, { chronic: string; allergy: string; medication: { name: string; dose: string } }> = {
  en: { chronic: "Vitamin D deficiency", allergy: "Ibuprofen", medication: { name: "Vitamin D3", dose: "50,000 IU weekly" } },
  ar: { chronic: "نقص فيتامين د", allergy: "إيبوبروفين", medication: { name: "فيتامين د٣", dose: "٥٠ ألف وحدة أسبوعياً" } },
};

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const toArabicDigits = (s: string) => s.replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]!);
/** `+2010…` as a patient types it on a phone keyboard: `010…`. */
const localForm = (phone: string) => phone.replace(/^\+20/, "0");

/** A mobile number no patient of the tenant holds yet (deterministic from the stream). */
async function freshMobile(ctx: SeedContext, r: Random, taken: Set<string>): Promise<string> {
  for (;;) {
    const candidate = egyptianMobile(r);
    if (taken.has(candidate)) continue;
    const clash = await ctx.db.patient.count({ where: { tenantId: ctx.tenantId, OR: [{ phone: candidate }, { whatsapp: candidate }] } });
    taken.add(candidate);
    if (!clash) return candidate;
  }
}

/**
 * A well-formed Egyptian national id for a date of birth: century digit,
 * YYMMDD, governorate (01 = Cairo), a sequence whose last digit is odd for
 * men and even for women, and a check digit.
 */
function egyptianNationalId(r: Random, dob: Date, female: boolean): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const century = dob.getUTCFullYear() >= 2000 ? 3 : 2;
  const yymmdd = `${pad(dob.getUTCFullYear() % 100)}${pad(dob.getUTCMonth() + 1)}${pad(dob.getUTCDate())}`;
  const sexDigit = female ? r.pick([2, 4, 6, 8]) : r.pick([1, 3, 5, 7, 9]);
  return `${century}${yymmdd}01${r.between(100, 999)}${sexDigit}${r.between(1, 9)}`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function seedIntake(ctx: SeedContext): Promise<void> {
  const r = makeRandom(31);
  const { db, tenantId } = ctx;
  const now = ctx.today;

  // Re-runs rebuild the same queue: drop what an earlier run of this module left.
  await db.intakeSubmission.deleteMany({ where: { tenantId } });
  await db.intakeLink.deleteMany({ where: { tenantId } });

  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0];
  if (!reception || !ctx.patients.length) return;
  const nurse = ctx.users.find((u) => u.role === "NURSE") ?? reception;

  const offered = new Set((await db.treatment.findMany({ where: { tenantId, active: true }, select: { key: true } })).map((t) => t.key));
  const treatments = (keys: string[]) => (offered.size ? keys.filter((k) => offered.has(k)) : keys);

  // ── Links ────────────────────────────────────────────────────────────────
  const desk = issueIntakeToken();
  const deskCreated = daysBefore(now, 12);
  const deskLink = await db.intakeLink.create({
    data: {
      tenantId,
      kind: "OPEN",
      tokenHash: desk.tokenHash,
      tokenPrefix: desk.tokenPrefix,
      language: "ar",
      label: DESK_LABEL,
      createdAt: deskCreated,
      expiresAt: daysAfter(deskCreated, 90),
      createdById: reception.id,
      uses: 3,
    },
    select: { id: true },
  });

  // Personal links for two patients with a visit coming up, one per language.
  const upcoming = await db.appointment.findMany({
    where: { tenantId, deletedAt: null, startsAt: { gt: now }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
    orderBy: { startsAt: "asc" },
    select: { patientId: true },
    take: 200,
  });
  const upcomingIds = new Set(upcoming.map((a) => a.patientId));
  const withVisit = ctx.patients.filter((p) => upcomingIds.has(p.id));
  const pool = withVisit.length >= 2 ? withVisit : ctx.patients;
  const arabicFirst = pool.filter((p) => p.language === "ar");
  const englishFirst = pool.filter((p) => p.language === "en");
  const personal: SeedPatient[] = [];
  const firstPick = arabicFirst.length ? r.pick(arabicFirst) : r.pick(pool);
  personal.push(firstPick);
  const rest = (englishFirst.length ? englishFirst : pool).filter((p) => p.id !== firstPick.id);
  if (rest.length) personal.push(r.pick(rest));

  for (const [i, p] of personal.entries()) {
    const t = issueIntakeToken();
    const created = daysBefore(now, i === 0 ? 1 : 3);
    await db.intakeLink.create({
      data: {
        tenantId,
        kind: "PATIENT",
        tokenHash: t.tokenHash,
        tokenPrefix: t.tokenPrefix,
        patientId: p.id,
        language: p.language === "en" ? "en" : "ar",
        createdAt: created,
        expiresAt: daysAfter(created, 14),
        maxUses: 1,
        createdById: i === 0 ? reception.id : nurse.id,
      },
    });
  }

  // ── Submissions waiting for review (all through the desk QR) ─────────────
  const personalIds = new Set(personal.map((p) => p.id));
  const known = ctx.patients.filter((p) => !personalIds.has(p.id) && p.language === "ar" && p.phone);
  // The form adds an ibuprofen allergy: offer it for a patient whose medicines
  // it does not conflict with (no NSAIDs or salicylates), so approving it keeps
  // the record plausible. One draw either way, so the rest of the seed is unchanged.
  const activeMeds = await db.medication.findMany({
    where: { patientId: { in: known.map((p) => p.id) }, active: true },
    select: { patientId: true, name: true },
  });
  const compatible = known.filter(
    (p) => conflictingMedications([NEW_HISTORY.en.allergy], activeMeds.filter((m) => m.patientId === p.id).map((m) => m.name)).length === 0,
  );
  const candidates = compatible.length ? compatible : known;
  const returning = candidates.length ? r.pick(candidates) : ctx.patients[0]!;
  const history = await db.medicalHistory.findUnique({ where: { patientId: returning.id }, select: { chronicConditions: true, allergies: true } });
  const onFile = await db.patient.findUnique({ where: { id: returning.id }, select: { dateOfBirth: true } });
  const lang: Lang = returning.language === "en" ? "en" : "ar";
  const key = TREATMENT_FOR_CONDITION[returning.condKey] ?? "general-dermatology";
  const concern = CONCERNS[key] ?? CONCERNS["general-dermatology"]!;
  const extra = NEW_HISTORY[lang];
  const takenPhones = new Set(ctx.patients.map((p) => p.phone));

  const returningForm = IntakeFormInput.parse({
    language: lang,
    fullName: returning.fullName,
    // Typed the local way, exactly the number on file once canonicalised.
    phone: localForm(returning.phone),
    whatsappSame: true,
    gender: returning.gender,
    city: lang === "ar" ? "القاهرة" : "Cairo",
    nationalId: egyptianNationalId(r, onFile?.dateOfBirth ?? new Date(Date.UTC(1990, 0, 15)), returning.gender === "FEMALE"),
    treatmentKeys: treatments([key]),
    concern: lang === "ar" ? concern.ar : concern.en,
    sinceWhen: lang === "ar" ? concern.sinceAr : concern.sinceEn,
    // One condition already on file (the merge must not duplicate it) and one new.
    chronicConditions: [...strings(history?.chronicConditions).slice(0, 1), extra.chronic],
    allergies: [...strings(history?.allergies).slice(0, 1), extra.allergy],
    medications: [extra.medication],
    surgeries: [],
    consent: true,
    whatsappUpdates: true,
  });

  const englishPhone = await freshMobile(ctx, r, takenPhones);
  const englishForm = IntakeFormInput.parse({
    language: "en",
    fullName: "Yara Abdelaziz",
    phone: `+20 ${englishPhone.slice(3, 5)} ${englishPhone.slice(5, 9)} ${englishPhone.slice(9)}`,
    whatsappSame: true,
    dateOfBirth: "1994-06-17",
    gender: "FEMALE",
    city: "New Cairo",
    nationalId: "29406170104562",
    email: "yara.abdelaziz@example.com",
    address: "Building 14, Street 90, Fifth Settlement, New Cairo",
    emergencyContactName: "Hossam Abdelaziz",
    emergencyContactPhone: await freshMobile(ctx, r, takenPhones),
    emergencyContactRelation: "Brother",
    treatmentKeys: treatments(["pigmentation", "laser-hair-removal"]),
    concern: `${CONCERNS.pigmentation!.en} ${CONCERNS["laser-hair-removal"]!.en}`,
    sinceWhen: "Since my second pregnancy, about two years",
    chronicConditions: ["Polycystic ovary syndrome (PCOS)"],
    allergies: [],
    medications: [{ name: "Metformin", dose: "500 mg twice daily" }],
    surgeries: ["Caesarean section (2022)"],
    consent: true,
    whatsappUpdates: true,
  });

  const arabicPhone = await freshMobile(ctx, r, takenPhones);
  const arabicForm = IntakeFormInput.parse({
    language: "ar",
    fullName: "محمود عبد الحميد السيد",
    // Typed on an Arabic keyboard: Arabic-Indic digits, local form.
    phone: toArabicDigits(localForm(arabicPhone)),
    whatsappSame: true,
    dateOfBirth: toArabicDigits("1988-03-05"),
    gender: "MALE",
    city: "المنصورة",
    nationalId: toArabicDigits("28803051200431"),
    address: "شارع الجمهورية، المنصورة، الدقهلية",
    emergencyContactName: "منى عبد الحميد",
    emergencyContactPhone: toArabicDigits(localForm(await freshMobile(ctx, r, takenPhones))),
    emergencyContactRelation: "الزوجة",
    treatmentKeys: treatments(["hair-transplant", "prp-hair"]),
    concern: "تساقط في الشعر في مقدمة الرأس ومنطقة التاج من حوالي سنتين، وعايز أعرف لو حالتي مناسبة للزراعة ولا محتاج جلسات بلازما الأول.",
    sinceWhen: "من سنتين تقريباً",
    chronicConditions: ["ضغط دم مرتفع"],
    allergies: ["البنسلين"],
    medications: [{ name: "كونكور", dose: "٥ مجم مرة يومياً" }],
    surgeries: ["استئصال الزائدة الدودية"],
    consent: true,
    whatsappUpdates: false,
  });

  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const rows: Prisma.IntakeSubmissionCreateManyInput[] = [
    { form: englishForm, matchedPatientId: null, submittedAt: minutesAgo(2 * 24 * 60 + r.between(200, 400)) },
    { form: returningForm, matchedPatientId: returning.id, submittedAt: minutesAgo(r.between(20 * 60, 30 * 60)) },
    { form: arabicForm, matchedPatientId: null, submittedAt: minutesAgo(r.between(25, 55)) },
  ].map(({ form, matchedPatientId, submittedAt }) => ({
    tenantId,
    linkId: deskLink.id,
    status: "PENDING" as const,
    fullName: form.fullName,
    phone: form.phone,
    email: form.email ?? null,
    // JSON round trip drops the absent optional fields, exactly as the public POST stores them.
    data: JSON.parse(JSON.stringify(form)) as Prisma.InputJsonObject,
    matchedPatientId,
    submittedAt,
  }));
  await db.intakeSubmission.createMany({ data: rows });

  const base = (process.env.PUBLIC_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  console.log(`   · ${DESK_LABEL} (shown once, stored hashed): ${base}/onboard/${desk.token}`);
}
