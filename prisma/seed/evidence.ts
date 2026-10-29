import type { EvidenceKind, EvidenceStatus } from "@prisma/client";
import { checkPrescribing } from "../../src/modules/consultations/safety/engine";
import { splitPassages } from "../../src/modules/evidence/passages";
import type { SeedContext } from "./index";
import { daysBefore } from "./util";

/**
 * The evidence panel's library in the demo (Phase 4): the clinic's own
 * protocols, drug information sheets and a treatment summary, every one
 * written for the demo and saying so (none is a real publisher's text), six
 * approved by the owner, one waiting for approval and one retired (the
 * protocol the current one replaced). And pregnancy on the record of a few
 * women: excluded recently (the prescribing checks then warn about
 * contraception instead of stopping), excluded too long ago to count, and one
 * pregnancy.
 */

const PUBLISHER = "Aura Derma & Hair Clinic, medical committee (demo)";
const DEMO = "Demo text written for the ClinicMind demo clinic. It is not clinical guidance.";
const DEMO_AR = "نص تجريبي مكتوب لعيادة العرض في ClinicMind، وليس إرشادًا طبيًا.";

interface SeedSource {
  title: string;
  kind: EvidenceKind;
  language: "en" | "ar";
  year: number;
  status: EvidenceStatus;
  /** Added this many days ago, by this doctor. */
  addedDaysAgo: number;
  by: "derm" | "hair";
  approvedDaysAgo?: number;
  retiredDaysAgo?: number;
  body: string;
}

const SOURCES: SeedSource[] = [
  {
    title: "Isotretinoin for acne: the clinic's protocol (demo text)",
    kind: "PROTOCOL",
    language: "en",
    year: 2026,
    status: "APPROVED",
    addedDaysAgo: 122,
    by: "derm",
    approvedDaysAgo: 120,
    body: `${DEMO}

# Who it is for
Severe nodular or cystic acne, acne that scars, and moderate acne that has not cleared after three months of an oral antibiotic with topical treatment.

# Before starting
Fasting lipids (cholesterol and triglycerides) and liver tests (ALT, AST) at baseline.
Women who could become pregnant: a negative pregnancy test before the first prescription, and contraception agreed and documented. Isotretinoin is teratogenic: one highly effective method, or two methods together, from one month before treatment until one month after the last dose.
Ask about low mood, depression and thoughts of self-harm, and record the answer.

# Dose
Start at 0.5 mg/kg a day taken with food, rising to 1 mg/kg a day if tolerated. A course usually aims at a total of 120 to 150 mg/kg.

# Monitoring during treatment
A pregnancy test every month for women who could become pregnant, and one month after the last dose.
Repeat lipids and liver tests after one month, then every three months.
Ask about mood at every visit. Prescribe for at most 30 days at a time for women who could become pregnant.

# Do not combine
Do not prescribe tetracyclines (doxycycline, minocycline, lymecycline) with isotretinoin: together they raise the risk of benign intracranial hypertension. Treat a flare or a skin infection during the course with another antibiotic, after checking allergies.
No vitamin A supplements during the course.

# Advice for the patient
Use a moisturiser and lip balm every day: dry lips and skin are expected.
No waxing, laser, dermabrasion or medium and deep chemical peels during treatment and for six months after it.
No blood donation during treatment and for one month after it.`,
  },
  {
    title: "Doxycycline: drug information sheet (demo text)",
    kind: "DRUG_INFO",
    language: "en",
    year: 2026,
    status: "APPROVED",
    addedDaysAgo: 110,
    by: "derm",
    approvedDaysAgo: 108,
    body: `${DEMO}

# Use in the clinic
Moderate inflammatory acne and papulopustular rosacea: 100 mg once a day (40 mg modified-release for rosacea). For acne, at most three months, always with benzoyl peroxide or a topical retinoid, to limit bacterial resistance.

# How to take it
With a full glass of water, sitting or standing, and not just before lying down: it can ulcerate the oesophagus. With food if it upsets the stomach.
Two to three hours apart from antacids, iron, calcium or zinc supplements, which stop it being absorbed.

# Who should not take it
Pregnancy and breastfeeding: tetracyclines stain the baby's teeth and affect bone growth.
Children under 8 years.
Patients taking isotretinoin: together they raise the risk of benign intracranial hypertension.

# Side effects to explain
Sensitivity to sunlight: sunscreen, and no strong sun.
Stop it and come back the same day with a severe headache or blurred vision.`,
  },
  {
    title: "Acne treatment ladder: the clinic's summary (demo text)",
    kind: "GUIDELINE",
    language: "en",
    year: 2026,
    status: "APPROVED",
    addedDaysAgo: 100,
    by: "derm",
    approvedDaysAgo: 99,
    body: `${DEMO}

# Mild acne
Comedones and a few papules: a topical retinoid (adapalene) or benzoyl peroxide, or both together. Review after eight to twelve weeks.

# Moderate acne
Papules and pustules on the face or the back: a topical retinoid with benzoyl peroxide, adding oral doxycycline for up to three months when it is widespread. Never a topical and an oral antibiotic together.
Women: a combined oral contraceptive or spironolactone can be added for acne that flares with the cycle.

# Severe acne
Nodules, cysts or scarring: isotretinoin under the clinic's protocol. The same week for acne fulminans (fever, painful ulcerated nodules).

# Acne in pregnancy
Azelaic acid, or topical clindamycin with benzoyl peroxide. Avoid isotretinoin, topical retinoids and tetracyclines.`,
  },
  {
    title: "بروتوكول العيادة: التقشير الكيميائي (نص تجريبي)",
    kind: "PROTOCOL",
    language: "ar",
    year: 2026,
    status: "APPROVED",
    addedDaysAgo: 90,
    by: "derm",
    approvedDaysAgo: 88,
    body: `${DEMO_AR}

# قبل الجلسة
إيقاف الريتينويد الموضعي (التريتينوين والأدابالين) قبل التقشير بأسبوع.
لا تقشير متوسط أو عميق خلال ستة أشهر من آخر جرعة إيزوتريتينوين.
لمن لديه تاريخ مع الهربس حول الفم: أسيكلوفير وقائي يبدأ قبل التقشير المتوسط بيوم ويستمر خمسة أيام.

# الحمل والرضاعة
لا يُستخدم حمض الساليسيليك ولا مادة TCA أثناء الحمل والرضاعة. حمض الجليكوليك وحمض اللاكتيك بتركيز منخفض مقبولان بعد موافقة الطبيب.

# بعد الجلسة
واقي شمس SPF 30 أو أعلى كل ساعتين نهارًا لمدة أسبوعين على الأقل، وتجنب الشمس المباشرة.
عدم إزالة القشور باليد، واستخدام مرطب خفيف.`,
  },
  {
    title: "Botulinum toxin injections: the clinic's protocol (demo text)",
    kind: "PROTOCOL",
    language: "en",
    year: 2026,
    status: "APPROVED",
    addedDaysAgo: 80,
    by: "derm",
    approvedDaysAgo: 79,
    body: `${DEMO}

# Who should not have it
Pregnancy and breastfeeding: not studied, so the clinic does not inject.
Myasthenia gravis, Lambert-Eaton syndrome and other disorders of the nerve and muscle junction.
Infection or active inflammation at the injection site.

# Medicines to ask about
Aminoglycoside antibiotics (gentamicin, amikacin) strengthen the effect of the toxin: wait until the course is finished.
Blood thinners and aspirin: more bruising, not a reason to stop them.

# Treatment
At least three months between treatments of the same area. Review after two weeks; a top-up only at that review.

# Advice for the patient
Stay upright for four hours, do not rub the area, and no sport or sauna for the rest of the day.
Come back the same day with drooping of the eyelid, difficulty swallowing or breathing.`,
  },
  {
    title: "Minoxidil and finasteride for hair loss: drug information (demo text)",
    kind: "DRUG_INFO",
    language: "en",
    year: 2026,
    status: "APPROVED",
    addedDaysAgo: 75,
    by: "hair",
    approvedDaysAgo: 74,
    body: `${DEMO}

# Topical minoxidil
Men: 5% foam or solution twice a day. Women: 2% twice a day or 5% foam once a day. Shedding in the first two to eight weeks is expected; judge the result after six months.
Not in pregnancy or breastfeeding.

# Low-dose oral minoxidil
An option the doctor chooses for patients who cannot use the topical: start low, check blood pressure and pulse at each visit, and ask about swollen ankles and palpitations. Unwanted hair growth on the face and body is common.

# Finasteride
Men with androgenetic alopecia: 1 mg once a day. It lowers PSA by about half: tell the doctor who checks the prostate.
Not for women who are or could become pregnant: it can affect the development of a male foetus. Women should not handle crushed or broken tablets.
Ask about low mood and sexual side effects at follow-up.

# After a hair transplant
Restart topical minoxidil two weeks after the transplant, when the scabs are gone; finasteride can continue throughout.`,
  },
  {
    title: "Laser hair removal: before and after (demo text, waiting for approval)",
    kind: "PROTOCOL",
    language: "en",
    year: 2026,
    status: "DRAFT",
    addedDaysAgo: 2,
    by: "hair",
    body: `${DEMO}

# Before the session
No sun or tanning for four weeks. Shave the area the day before; no waxing, plucking or threading for four weeks.
Ask about medicines that make the skin sensitive to light (doxycycline, isotretinoin in the last six months) and about cold sores on the face.
Postpone during pregnancy.

# After the session
Cool packs for redness, sunscreen SPF 50 for two weeks, no hot baths or sauna for two days.`,
  },
  {
    title: "Isotretinoin for acne: protocol 2024 (demo text, replaced)",
    kind: "PROTOCOL",
    language: "en",
    year: 2024,
    status: "RETIRED",
    addedDaysAgo: 640,
    by: "derm",
    approvedDaysAgo: 635,
    retiredDaysAgo: 120,
    body: `${DEMO}

# Before starting
Lipids and liver tests at baseline. Women who could become pregnant: a negative pregnancy test and contraception agreed before the first prescription.

# Monitoring during treatment
Lipids and liver tests every two months. A pregnancy test every month for women who could become pregnant.

# Do not combine
No tetracyclines with isotretinoin. No vitamin A supplements.`,
  },
];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function ageOn(dob: Date | null, now: Date): number | null {
  if (!dob) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  if (now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export async function seedEvidence(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const now = ctx.today;
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER" && u.kind)!;
  const doctor = (kind: "derm" | "hair") => ctx.users.find((u) => u.role === "DOCTOR" && u.kind === kind) ?? owner;

  // ── The library ───────────────────────────────────────────────────────────
  let passages = 0;
  for (const s of SOURCES) {
    const added = daysBefore(now, s.addedDaysAgo);
    const approvedAt = s.approvedDaysAgo !== undefined ? daysBefore(now, s.approvedDaysAgo) : null;
    const retiredAt = s.retiredDaysAgo !== undefined ? daysBefore(now, s.retiredDaysAgo) : null;
    const source = await db.evidenceSource.create({
      data: {
        tenantId,
        title: s.title,
        kind: s.kind,
        publisher: PUBLISHER,
        year: s.year,
        language: s.language,
        body: s.body,
        status: s.status,
        approvedById: approvedAt ? owner.id : null,
        approvedAt,
        retiredAt,
        createdById: doctor(s.by).id,
        createdAt: added,
        updatedAt: retiredAt ?? approvedAt ?? added,
      },
      select: { id: true },
    });
    const split = splitPassages(s.body);
    await db.evidencePassage.createMany({ data: split.map((p) => ({ tenantId, sourceId: source.id, index: p.index, heading: p.heading, content: p.content })) });
    passages += split.length;
  }

  // ── Pregnancy on the record ───────────────────────────────────────────────
  const women = (
    await db.patient.findMany({
      where: { tenantId, deletedAt: null, gender: "FEMALE" },
      orderBy: { fullName: "asc" },
      select: {
        id: true,
        fullName: true,
        dateOfBirth: true,
        medicalHistory: { select: { chronicConditions: true, diagnoses: true, allergies: true } },
        medications: { where: { active: true }, select: { name: true, dosage: true, frequency: true } },
        consultations: { where: { status: "PENDING_REVIEW" }, select: { id: true } },
      },
    })
  ).map((w) => ({ ...w, age: ageOn(w.dateOfBirth, now) }));
  const childbearing = (w: (typeof women)[number]) => w.age !== null && w.age >= 18 && w.age <= 42;
  const used = new Set<string>();
  const record = async (w: (typeof women)[number] | undefined, status: "PREGNANT" | "NOT_PREGNANT", daysAgo: number, why: string) => {
    if (!w) {
      console.warn(`   ! evidence: no patient for ${why}`);
      return;
    }
    used.add(w.id);
    await db.patient.update({ where: { id: w.id }, data: { pregnancyStatus: status, pregnancyCheckedAt: daysBefore(now, daysAgo) } });
  };

  // The isotretinoin prescribed over a teratogen stop: her negative test, two days before the signature.
  const override = await db.safetyOverride.findFirst({
    where: { tenantId, rule: "pregnancy.teratogen", medication: { contains: "isotretinoin", mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    select: { patientId: true, createdAt: true },
  });
  if (override) {
    await record(
      women.find((w) => w.id === override.patientId),
      "NOT_PREGNANT",
      (now.getTime() - override.createdAt.getTime()) / 86_400_000 + 2,
      "the isotretinoin override",
    );
  }
  // A woman whose draft waits for review: excluded last week, so the evidence panel shows it.
  await record(
    women.find((w) => !used.has(w.id) && childbearing(w) && w.consultations.length > 0),
    "NOT_PREGNANT",
    9,
    "a draft with pregnancy excluded",
  );
  // Excluded, but too long ago to count (the checks treat her as unknown again).
  await record(
    women.find((w) => !used.has(w.id) && childbearing(w)),
    "NOT_PREGNANT",
    75,
    "an old exclusion",
  );
  // Pregnant: none of her current medicines or waiting drafts is one to avoid in pregnancy.
  await record(
    women.find((w) => {
      if (used.has(w.id) || !childbearing(w) || w.consultations.length) return false;
      const findings = checkPrescribing({
        patient: { gender: "FEMALE", dateOfBirth: w.dateOfBirth, pregnant: true },
        allergies: strings(w.medicalHistory?.allergies),
        conditions: [...strings(w.medicalHistory?.chronicConditions), ...strings(w.medicalHistory?.diagnoses)],
        activeMedications: [],
        proposed: w.medications,
        now,
      });
      return !findings.some((f) => f.rule.startsWith("pregnancy."));
    }),
    "PREGNANT",
    70,
    "a pregnancy",
  );

  console.log(`   · evidence: ${SOURCES.length} sources (${passages} passages); pregnancy recorded for ${used.size} women`);
}
