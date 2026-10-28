import type { Prisma } from "@prisma/client";
import { checkPrescribing } from "../../src/modules/consultations/safety/engine";
import type { SafetyFinding } from "../../src/modules/consultations/types";
import type { SeedContext, SeedUser } from "./index";
import { daysBefore } from "./util";

/**
 * Prescribing safety in the demo (audit finding #10):
 *  - one pending draft that hits a stop (amoxicillin for a patient with a
 *    documented penicillin allergy), so the review panel can be tried at once;
 *  - three recent signed consultations where a clinician prescribed over a
 *    finding — two stops signed with a reason and one acknowledged warning —
 *    so the owner's Safety overrides list is not empty.
 * Every finding comes from the real rule engine, with the patient's own
 * allergies, conditions and medicines. None of these prescriptions conflicts
 * with an allergy on file (the seed consistency test holds).
 */

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

interface Facts {
  id: string;
  fullName: string;
  gender: string;
  dateOfBirth: Date | null;
  allergies: string[];
  conditions: string[];
  medications: { name: string; dosage: string | null; frequency: string | null }[];
}

interface Scenario {
  /** Which patient fits, among those the engine flags for the medicine. */
  fits: (p: Facts, age: number | null) => boolean;
  /** Patients of this clinical scenario (core seed key) are tried first. */
  preferCondition?: string;
  diagnosis: string;
  medication: { name: string; dosage: string; frequency: string };
  /** The finding the clinician prescribed over. */
  rule: string;
  /** Typed for a stop; warnings are acknowledged. */
  reason: string;
  daysAgo: number;
}

const SCENARIOS: Scenario[] = [
  {
    fits: (p, age) => p.gender === "FEMALE" && age !== null && age >= 18 && age <= 35,
    diagnosis: "Nodulocystic acne, scarring",
    medication: { name: "Isotretinoin", dosage: "20 mg", frequency: "Once daily" },
    rule: "pregnancy.teratogen",
    reason: "Pregnancy excluded: negative serum β-hCG two days ago; two forms of contraception agreed and documented; monthly tests booked.",
    daysAgo: 4,
  },
  {
    fits: (p, age) => p.gender === "FEMALE" && age !== null && age >= 48 && age <= 55,
    preferCondition: "psoriasis",
    diagnosis: "Extensive plaque psoriasis, inadequate response to topicals",
    medication: { name: "Acitretin", dosage: "25 mg", frequency: "Once daily" },
    rule: "pregnancy.teratogen",
    reason: "Post-menopausal for three years (no menses since 2023); lipids and liver tests done, repeat booked in 4 weeks.",
    daysAgo: 11,
  },
  {
    fits: (p, age) => p.gender === "FEMALE" && age !== null && age >= 18 && age <= 45,
    diagnosis: "Papulopustular rosacea",
    medication: { name: "Doxycycline", dosage: "100 mg", frequency: "Once daily" },
    rule: "pregnancy.caution",
    reason: "acknowledged",
    daysAgo: 17,
  },
];

function ageOn(dob: Date | null, now: Date): number | null {
  if (!dob) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  if (now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function findingsFor(p: Facts, medication: Scenario["medication"], now: Date): SafetyFinding[] {
  return checkPrescribing({
    patient: { gender: p.gender, dateOfBirth: p.dateOfBirth },
    allergies: p.allergies,
    conditions: p.conditions,
    activeMedications: p.medications,
    proposed: [medication],
    now,
  });
}

export async function seedSafety(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const now = ctx.today;
  const rows = await db.patient.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { fullName: "asc" },
    select: {
      id: true,
      fullName: true,
      gender: true,
      dateOfBirth: true,
      medicalHistory: { select: { allergies: true, chronicConditions: true } },
      medications: { where: { active: true }, select: { name: true, dosage: true, frequency: true } },
    },
  });
  const patients: Facts[] = rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    gender: r.gender,
    dateOfBirth: r.dateOfBirth,
    allergies: strings(r.medicalHistory?.allergies),
    conditions: strings(r.medicalHistory?.chronicConditions),
    medications: r.medications,
  }));
  const doctorFor = (patientId: string): SeedUser => {
    const kind = ctx.patients.find((p) => p.id === patientId)?.doctorKind ?? "derm";
    return ctx.users.find((u) => u.kind === kind && u.role === "DOCTOR") ?? ctx.users.find((u) => u.kind === kind)!;
  };
  const used = new Set<string>();

  // ── Recent overrides, each in its own signed consultation ─────────────────
  let overrides = 0;
  for (const s of SCENARIOS) {
    const condKey = (id: string) => ctx.patients.find((p) => p.id === id)?.condKey;
    const match = patients
      .filter((p) => !used.has(p.id) && s.fits(p, ageOn(p.dateOfBirth, now)))
      .sort((a, b) => Number(condKey(b.id) === s.preferCondition) - Number(condKey(a.id) === s.preferCondition))
      .map((p) => ({ p, findings: findingsFor(p, s.medication, now) }))
      // The finding the reason answers is there, and it is the only stop.
      .find(({ findings }) => findings.some((f) => f.rule === s.rule) && findings.every((f) => f.severity !== "stop" || f.rule === s.rule));
    if (!match) {
      console.warn(`   ! safety: no patient fits the ${s.medication.name} scenario`);
      continue;
    }
    const { p, findings } = match;
    used.add(p.id);
    const doctor = doctorFor(p.id);
    const signedAt = daysBefore(now, s.daysAgo);
    const summary = `${s.diagnosis}. Plan: ${s.medication.name} ${s.medication.dosage} ${s.medication.frequency.toLowerCase()}. Review in 4 weeks.`;
    const extraction = { symptoms: [], diagnoses: [s.diagnosis], medications: [s.medication], tests: [], followUps: ["Review in 4 weeks"] };
    const visit = await db.visit.create({
      data: { tenantId, patientId: p.id, doctorId: doctor.id, notes: summary, summary, createdAt: signedAt },
      select: { id: true },
    });
    const consultation = await db.consultation.create({
      data: {
        tenantId,
        patientId: p.id,
        visitId: visit.id,
        doctorId: doctor.id,
        status: "SIGNED",
        extraction: extraction as Prisma.InputJsonObject,
        summary,
        reviewedById: doctor.id,
        reviewedAt: signedAt,
        createdAt: daysBefore(signedAt, 0.02),
      },
      select: { id: true },
    });
    await db.medication.create({
      data: { tenantId, patientId: p.id, name: s.medication.name, dosage: s.medication.dosage, frequency: s.medication.frequency, startDate: signedAt, visitId: visit.id, createdAt: signedAt },
    });
    // What the signing would have stored: every stop with the clinician's reason, every warning acknowledged.
    for (const f of findings) {
      await db.safetyOverride.create({
        data: {
          tenantId,
          consultationId: consultation.id,
          patientId: p.id,
          userId: doctor.id,
          rule: f.rule,
          severity: f.severity,
          medication: f.medication,
          message: f.message,
          detail: f.detail as Prisma.InputJsonObject,
          reason: f.severity === "stop" ? s.reason : "acknowledged",
          createdAt: signedAt,
        },
      });
      overrides++;
    }
    await db.timelineEvent.create({
      data: { tenantId, patientId: p.id, kind: "VISIT", title: "Consultation signed", body: summary, refId: visit.id, occurredAt: signedAt },
    });
  }

  // ── A draft waiting for review that hits a stop ───────────────────────────
  const allergic = patients.find(
    (p) => !used.has(p.id) && findingsFor(p, { name: "Amoxicillin", dosage: "500 mg", frequency: "Three times daily" }, now).some((f) => f.severity === "stop" && f.rule.startsWith("allergy")),
  );
  if (allergic) {
    const doctor = doctorFor(allergic.id);
    const first = allergic.fullName.split(" ")[0];
    const transcript = [
      `Doctor: Hello ${first}, what brings you in today?`,
      "Patient: The patch on my scalp has started crusting and it hurts.",
      "Doctor: It looks infected. I'll give you an antibiotic, amoxicillin five hundred three times a day for a week, and keep the cream.",
      "Patient: Okay.",
    ].join("\n");
    const medication = { name: "Amoxicillin", dosage: "500 mg", frequency: "Three times daily" };
    await db.consultation.create({
      data: {
        tenantId,
        patientId: allergic.id,
        doctorId: doctor.id,
        status: "PENDING_REVIEW",
        transcript,
        extraction: {
          symptoms: ["Crusting, painful scalp patch"],
          diagnoses: ["Secondary bacterial infection (impetiginisation)"],
          medications: [medication],
          tests: [],
          followUps: ["Review in 1 week"],
        } as Prisma.InputJsonObject,
        summary: "Painful crusting scalp patch, likely secondary infection. Plan: Amoxicillin 500 mg three times daily for 7 days. Review in 1 week.",
        createdAt: daysBefore(now, 0.05),
      },
    });
    console.log(`   · safety: ${overrides} override rows; a draft with a known stop for ${allergic.fullName} (${doctor.fullName})`);
  } else {
    console.warn("   ! safety: no penicillin-allergic patient for the stop draft");
  }
}
