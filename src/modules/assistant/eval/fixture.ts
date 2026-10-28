import type { Gender, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { addDays, startOfDayInTz, zonedParts } from "@/lib/time";

/**
 * A small, fully known clinic for the assistant's evaluation set and tests:
 * every patient, allergy, condition, medication, visit and appointment is
 * listed below, so the right answer to each question is known in advance.
 *
 * Tenant A ("Eval Derma Clinic") holds the patients; tenant B holds look-alike
 * patients (penicillin allergies, a male PCOS entry, a "Tarek Ezzat" on
 * cephalexin) that must never appear in tenant A's answers.
 *
 * Ages are relative to `now` on the clinic clock (Africa/Cairo); one patient
 * turns 41 tomorrow, so "over 40" must leave her out.
 */

export const FIXTURE_TIMEZONE = "Africa/Cairo";

interface FixturePatient {
  key: string;
  name: string;
  sex: Gender;
  /** Completed years today; null = no date of birth recorded. */
  age: number | null;
  /** Birthday tomorrow (age turns age+1 tomorrow). */
  birthdayTomorrow?: boolean;
  allergies?: string[];
  chronic?: string[];
  diagnoses?: string[];
  surgeries?: string[];
  meds?: { name: string; dosage?: string; frequency?: string; stopped?: boolean }[];
  tags?: string[];
  archived?: boolean;
}

export const FIXTURE_PATIENTS: FixturePatient[] = [
  // Penicillin class: eleven patients, recorded eleven different ways.
  { key: "amira", name: "Amira Shawky", sex: "FEMALE", age: 34, allergies: ["Penicillin"] },
  { key: "bassem", name: "Bassem Rashad", sex: "MALE", age: 52, allergies: ["penicillin"], chronic: ["Androgenetic alopecia"], meds: [{ name: "Finasteride", dosage: "1 mg", frequency: "Once daily" }] },
  { key: "camilia", name: "Camilia Fawzy", sex: "FEMALE", age: 47, allergies: ["Penicillin (rash)"], chronic: ["Melasma"], meds: [{ name: "Tranexamic acid", dosage: "250 mg", frequency: "Twice daily" }], tags: ["vip"] },
  { key: "doaa", name: "Doaa Helmy", sex: "FEMALE", age: 29, allergies: ["PENICILLIN", "Latex"] },
  { key: "essam", name: "Essam Nagy", sex: "MALE", age: 61, allergies: ["Penicillin V"], chronic: ["Hypertension", "Type 2 diabetes"], meds: [{ name: "Proscar", dosage: "5 mg", frequency: "Once daily" }] },
  { key: "fady", name: "Fady Wahba", sex: "MALE", age: 38, allergies: ["Penicilin"] },
  { key: "ghada", name: "Ghada Soliman", sex: "FEMALE", age: 16, allergies: ["Amoxicillin"] },
  { key: "hesham", name: "Hesham Labib", sex: "MALE", age: 44, allergies: ["بنسلين"] },
  { key: "inas", name: "Inas Farouk", sex: "FEMALE", age: 55, allergies: ["Penicillin", "Lidocaine"] },
  { key: "kamal", name: "Kamal Abdallah", sex: "MALE", age: 70, allergies: ["Augmentin"] },
  { key: "lamia", name: "Lamia Sabry", sex: "FEMALE", age: 41, allergies: ["Penicillin G"] },
  // Lidocaine by brand name.
  { key: "magdy", name: "Magdy Osman", sex: "MALE", age: 36, allergies: ["Xylocaine"] },
  // Archived: must never appear.
  { key: "nabila", name: "Nabila Sherif", sex: "FEMALE", age: 50, allergies: ["Penicillin"], chronic: ["PCOS"], archived: true },
  // PCOS: four women (one only in a signed consultation) and one male entry (a recording error).
  { key: "rania", name: "Rania Adly", sex: "FEMALE", age: 27, chronic: ["PCOS"], meds: [{ name: "Metformin", dosage: "500 mg", frequency: "Twice daily" }], tags: ["vip"] },
  { key: "salma", name: "Salma Kandil", sex: "FEMALE", age: 31, chronic: ["Polycystic ovary syndrome"] },
  { key: "tamara", name: "Tamara Youssef", sex: "FEMALE", age: 24, diagnoses: ["PCOS with hirsutism"] },
  { key: "wael", name: "Wael Hosny", sex: "MALE", age: 33, chronic: ["PCOS"] },
  { key: "yara", name: "Yara Mounir", sex: "FEMALE", age: 22, tags: ["new-patient"] },
  { key: "zeinab", name: "Zeinab Lotfy", sex: "FEMALE", age: 26 },
  // Rosacea: one in the history, one only in a signed consultation.
  { key: "omar", name: "Omar Tawfik", sex: "MALE", age: 48, chronic: ["Rosacea"] },
  { key: "nermine", name: "Nermine Fahmy", sex: "FEMALE", age: 39 },
  // Psoriasis.
  { key: "rami", name: "Rami Zaki", sex: "MALE", age: 58, chronic: ["Plaque psoriasis"] },
  // Acne and isotretinoin (generic, brand, capsules; one stopped).
  { key: "hana", name: "Hana Gaber", sex: "FEMALE", age: 19, diagnoses: ["Acne vulgaris"], meds: [{ name: "Isotretinoin", dosage: "20 mg", frequency: "Once daily" }] },
  { key: "islam", name: "Islam Badr", sex: "MALE", age: 23, diagnoses: ["Acne vulgaris, moderate"], meds: [{ name: "Roaccutane", dosage: "10mg", frequency: "Once daily" }, { name: "Doxycycline", dosage: "100 mg", frequency: "Once daily" }] },
  { key: "jana", name: "Jana Mostafa", sex: "FEMALE", age: 17, diagnoses: ["Acne vulgaris"], meds: [{ name: "Isotretinoin 10 mg capsules", frequency: "Once daily" }] },
  { key: "khaled", name: "Khaled Seif", sex: "MALE", age: 26, diagnoses: ["Acne vulgaris"], meds: [{ name: "Isotretinoin", dosage: "20 mg", frequency: "Once daily", stopped: true }] },
  // Finasteride by brand.
  { key: "mahmoud", name: "Mahmoud Selim", sex: "MALE", age: 45, chronic: ["Androgenetic alopecia"], meds: [{ name: "Propecia", dosage: "1 mg", frequency: "Once daily" }] },
  // Cephalexin: the named-patient questions.
  { key: "hassan", name: "Hassan Ezzat", sex: "MALE", age: 34, surgeries: ["FUE hair transplant (2,400 grafts)"], meds: [{ name: "Cephalexin", dosage: "500 mg", frequency: "Twice daily for 5 days" }] },
  { key: "tarek", name: "Tarek Ezzat", sex: "MALE", age: 45, chronic: ["Melasma"], meds: [{ name: "Tranexamic acid", dosage: "250 mg", frequency: "Twice daily" }, { name: "Hydroquinone 4% cream", dosage: "Thin layer", frequency: "Nightly" }], tags: ["vip"] },
  { key: "nader", name: "Nader Kamal", sex: "MALE", age: 40, meds: [{ name: "Keflex", dosage: "500 mg", frequency: "Three times daily" }] },
  // Hair transplant only as a signed procedure; one only planned.
  { key: "sherif", name: "Sherif Abbas", sex: "MALE", age: 39, chronic: ["Androgenetic alopecia"] },
  { key: "youssef", name: "Youssef Amer", sex: "MALE", age: 29, chronic: ["Androgenetic alopecia"] },
  // Two Ahmeds (an ambiguous first name), and an edge-of-age patient.
  { key: "ahmedS", name: "Ahmed Saleh", sex: "MALE", age: 50 },
  { key: "ahmedK", name: "Ahmed Kamel", sex: "MALE", age: 35 },
  { key: "mona", name: "Mona Galal", sex: "FEMALE", age: 40, birthdayTomorrow: true },
  { key: "noDob", name: "Laila Nassar", sex: "FEMALE", age: null, chronic: ["Melasma"] },
];

export interface FixtureClinic {
  tenantId: string;
  tenantSlug: string;
  otherTenantId: string;
  /** Patient key → id (tenant A). */
  ids: Record<string, string>;
  /** Tenant B's look-alike patients. */
  otherIds: string[];
  doctors: { omar: string; mariam: string };
  ownerId: string;
  now: Date;
}

function dobFor(age: number, now: Date, birthdayTomorrow = false): Date {
  const today = zonedParts(now, FIXTURE_TIMEZONE);
  // Stored at UTC midnight, like the application does.
  if (birthdayTomorrow) return new Date(Date.UTC(today.year - age - 1, today.month - 1, today.day + 1));
  return new Date(Date.UTC(today.year - age, today.month - 1, today.day - 10));
}

async function createPatient(tenantId: string, p: FixturePatient, now: Date): Promise<string> {
  const created = await db.patient.create({
    data: {
      tenantId,
      fullName: p.name,
      gender: p.sex,
      dateOfBirth: p.age === null ? null : dobFor(p.age, now, p.birthdayTomorrow),
      tags: p.tags ?? [],
      createdAt: addDays(now, -730),
      deletedAt: p.archived ? addDays(now, -5) : null,
      medicalHistory: {
        create: {
          tenantId,
          allergies: p.allergies ?? [],
          chronicConditions: p.chronic ?? [],
          diagnoses: p.diagnoses ?? [],
          surgeries: p.surgeries ?? [],
        },
      },
      medications: {
        create: (p.meds ?? []).map((m) => ({
          tenantId,
          name: m.name,
          dosage: m.dosage ?? null,
          frequency: m.frequency ?? null,
          startDate: addDays(now, -40),
          active: !m.stopped,
          stoppedAt: m.stopped ? addDays(now, -15) : null,
          stopReason: m.stopped ? "Course completed" : null,
        })),
      },
    },
    select: { id: true },
  });
  return created.id;
}

/** Build tenants A and B. `createUser` comes from the test helpers (passed in to keep this file free of them). */
export async function buildEvalClinic(
  createUser: (opts: { tenantId: string; role: "CLINIC_OWNER" | "DOCTOR"; fullName: string }) => Promise<{ id: string }>,
  opts: { now?: Date; slug?: string } = {},
): Promise<FixtureClinic> {
  const now = opts.now ?? new Date();
  const suffix = Math.random().toString(36).slice(2, 8);
  const slug = opts.slug ?? `eval-a-${suffix}`;
  const tenant = await db.tenant.create({
    data: { slug, name: "Eval Derma Clinic", status: "ACTIVE", clinics: { create: { name: "Eval Derma Clinic", timezone: FIXTURE_TIMEZONE } } },
    select: { id: true, slug: true },
  });
  const other = await db.tenant.create({
    data: { slug: `eval-b-${suffix}`, name: "Mirage Clinic", status: "ACTIVE", clinics: { create: { name: "Mirage Clinic", timezone: FIXTURE_TIMEZONE } } },
    select: { id: true },
  });

  const owner = await createUser({ tenantId: tenant.id, role: "CLINIC_OWNER", fullName: "Dr. Layla Hassan" });
  const omar = await createUser({ tenantId: tenant.id, role: "DOCTOR", fullName: "Dr. Omar Fahmy" });
  const mariam = await createUser({ tenantId: tenant.id, role: "DOCTOR", fullName: "Dr. Mariam Tarek" });

  const ids: Record<string, string> = {};
  for (const p of FIXTURE_PATIENTS) ids[p.key] = await createPatient(tenant.id, p, now);

  // Tenant B look-alikes: never part of tenant A's answers.
  const otherIds: string[] = [];
  for (const p of [
    { key: "b1", name: "Basma Hegazy", sex: "FEMALE" as const, age: 45, allergies: ["Penicillin"] },
    { key: "b2", name: "Bahaa Wahid", sex: "MALE" as const, age: 51, allergies: ["Lidocaine", "Penicillin"] },
    { key: "b3", name: "Tarek Ezzat", sex: "MALE" as const, age: 45, meds: [{ name: "Cephalexin", dosage: "500 mg" }] },
    { key: "b4", name: "Bishoy Hanna", sex: "MALE" as const, age: 33, chronic: ["PCOS"] },
    { key: "b5", name: "Hassan Ezzat", sex: "MALE" as const, age: 60, meds: [{ name: "Isotretinoin", dosage: "20 mg" }] },
  ]) {
    otherIds.push(await createPatient(other.id, p, now));
  }

  // Signed consultations: diagnoses that are only in the consultation, and an unsigned draft that must not count.
  const consult = (patientId: string, status: "SIGNED" | "PENDING_REVIEW", diagnoses: string[], summary: string, daysAgo: number, doctorId: string | null): Prisma.ConsultationCreateManyInput => ({
    tenantId: tenant.id,
    patientId,
    doctorId,
    status,
    summary,
    transcript: `Doctor: ${summary}`,
    extraction: { symptoms: [], diagnoses, medications: [], tests: [], followUps: [] },
    reviewedAt: status === "SIGNED" ? addDays(now, -daysAgo) : null,
    reviewedById: status === "SIGNED" ? doctorId : null,
    createdAt: addDays(now, -daysAgo),
  });
  await db.consultation.createMany({
    data: [
      consult(ids.yara!, "SIGNED", ["Polycystic ovarian syndrome"], "Irregular cycles; polycystic ovarian syndrome confirmed on ultrasound.", 12, mariam.id),
      consult(ids.nermine!, "SIGNED", ["Papulopustular rosacea"], "Central facial redness with papules; papulopustular rosacea.", 9, mariam.id),
      consult(ids.zeinab!, "PENDING_REVIEW", ["PCOS", "Rosacea"], "Draft: possible PCOS and rosacea, not yet reviewed.", 2, mariam.id),
      consult(ids.tarek!, "SIGNED", ["Melasma, mixed epidermal-dermal"], "Melasma follow-up: patches lighter on tranexamic acid, continue and review in 8 weeks.", 30, omar.id),
      consult(ids.camilia!, "SIGNED", ["Melasma"], "Melasma follow-up: modest improvement on tranexamic acid; strict sun protection advised.", 25, mariam.id),
    ],
  });

  // Visits (last seen) and appointments (doctor and upcoming questions).
  const visit = (patientId: string, doctorId: string, daysAgo: number, summary: string) => ({
    tenantId: tenant.id,
    patientId,
    doctorId,
    summary,
    notes: summary,
    createdAt: addDays(now, -daysAgo),
  });
  await db.visit.createMany({
    data: [
      visit(ids.hana!, mariam.id, 10, "Acne review: isotretinoin 20 mg tolerated, lips dry."),
      visit(ids.islam!, omar.id, 20, "Acne review on Roaccutane and doxycycline."),
      visit(ids.tarek!, omar.id, 30, "Melasma follow-up visit."),
      visit(ids.bassem!, omar.id, 400, "Hair loss review."),
      visit(ids.essam!, omar.id, 200, "Hair loss review on Proscar."),
      visit(ids.camilia!, mariam.id, 25, "Melasma follow-up visit."),
    ],
  });
  const today0 = startOfDayInTz(now, FIXTURE_TIMEZONE);
  const at = (base: Date, hours: number) => new Date(base.getTime() + hours * 3_600_000);
  await db.appointment.createMany({
    data: [
      // today (early morning on the clinic clock, so it is "today" whatever the time of the run)
      { tenantId: tenant.id, patientId: ids.camilia!, doctorId: mariam.id, startsAt: at(today0, 0.5), endsAt: at(today0, 1), status: "CONFIRMED", reason: "Melasma follow-up" },
      // upcoming
      { tenantId: tenant.id, patientId: ids.jana!, doctorId: mariam.id, startsAt: at(addDays(today0, 3, FIXTURE_TIMEZONE), 11), endsAt: at(addDays(today0, 3, FIXTURE_TIMEZONE), 11.5), status: "SCHEDULED", reason: "Acne review" },
      { tenantId: tenant.id, patientId: ids.tarek!, doctorId: omar.id, startsAt: at(addDays(today0, 5, FIXTURE_TIMEZONE), 12), endsAt: at(addDays(today0, 5, FIXTURE_TIMEZONE), 12.5), status: "CONFIRMED", reason: "Melasma follow-up" },
      { tenantId: tenant.id, patientId: ids.rania!, doctorId: omar.id, startsAt: at(addDays(today0, 10, FIXTURE_TIMEZONE), 13), endsAt: at(addDays(today0, 10, FIXTURE_TIMEZONE), 13.5), status: "SCHEDULED", reason: "PCOS skin review" },
      // cancelled: never counts
      { tenantId: tenant.id, patientId: ids.omar!, doctorId: omar.id, startsAt: at(addDays(today0, 4, FIXTURE_TIMEZONE), 14), endsAt: at(addDays(today0, 4, FIXTURE_TIMEZONE), 14.5), status: "CANCELLED", reason: "Rosacea review", cancelReason: "Travelling" },
    ],
  });

  // Hair transplant as a signed procedure (and one only planned).
  const transplant = await db.treatment.create({
    data: { tenantId: tenant.id, key: "hair-transplant", name: "Hair transplant", category: "hair" },
    select: { id: true },
  });
  await db.procedure.createMany({
    data: [
      { tenantId: tenant.id, patientId: ids.sherif!, treatmentId: transplant.id, doctorId: omar.id, performedAt: addDays(now, -60), price: 60000, status: "SIGNED", notes: "FUE, 2,800 grafts" },
      { tenantId: tenant.id, patientId: ids.youssef!, treatmentId: transplant.id, doctorId: omar.id, performedAt: addDays(now, 20), price: 55000, status: "PLANNED" },
    ],
  });

  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    otherTenantId: other.id,
    ids,
    otherIds,
    doctors: { omar: omar.id, mariam: mariam.id },
    ownerId: owner.id,
    now,
  };
}
