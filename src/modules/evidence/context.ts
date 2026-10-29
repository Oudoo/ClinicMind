import { db } from "@/lib/db";
import { deidentify, type Identity } from "@/lib/ai/deidentify";
import { getTenantTimezone } from "@/modules/appointments/service";
import { loadSafetyRecord } from "@/modules/consultations/safety/context";
import { ageInYears } from "@/modules/consultations/safety/engine";
import { pregnancyLine } from "@/modules/patients/pregnancy";

/**
 * What goes with a question about a patient: their age, sex, pregnancy (when
 * it matters), allergies, medications and conditions, never their name,
 * phone, national ID or date of birth. And what to take out of the
 * question itself before it goes anywhere: the patient's name, numbers and
 * e-mail addresses.
 */

export interface EvidenceContext {
  /** Shown to the doctor before asking and sent with the question. */
  lines: string[];
  /** Who the question is about: their name, numbers, e-mail and date of birth are taken out of it. */
  identity: Identity;
}

export async function evidenceContext(tenantId: string, patientId: string, now: Date = new Date()): Promise<EvidenceContext | null> {
  const [patient, record, tz] = await Promise.all([
    db.patient.findFirst({ where: { id: patientId, tenantId, deletedAt: null }, select: { fullName: true, phone: true, whatsapp: true, nationalId: true, email: true } }),
    loadSafetyRecord(db, tenantId, patientId),
    getTenantTimezone(tenantId),
  ]);
  if (!patient) return null;
  const age = ageInYears(record.dateOfBirth, now);
  const sex = record.gender === "FEMALE" ? "Woman" : record.gender === "MALE" ? "Man" : "Sex not recorded";
  const conditions = [...new Set([...record.chronicConditions, ...record.diagnoses])];
  const lines = [
    age === null ? `${sex}, age not recorded` : `${sex}, ${age} years`,
    ...(record.gender === "MALE" ? [] : [pregnancyLine(record, tz, now)]),
    // "; " between items: a diagnosis can hold a comma ("Atopic dermatitis flare, flexural").
    record.allergies.length ? `Allergies: ${record.allergies.join("; ")}` : "No allergies recorded",
    record.activeMedications.length
      ? `Medications: ${record.activeMedications.map((m) => [m.name, m.dosage, m.frequency].filter(Boolean).join(" ")).join("; ")}`
      : "No medications recorded",
    conditions.length ? `Conditions: ${conditions.join("; ")}` : "No conditions recorded",
  ];
  const identity: Identity = { id: patientId, fullName: patient.fullName, phone: patient.phone, whatsapp: patient.whatsapp, nationalId: patient.nationalId, email: patient.email, dateOfBirth: record.dateOfBirth };
  return { lines, identity };
}

/** The question with the patient's name, any long number (phone, ID) and any e-mail address taken out. */
export function redactQuestion(question: string, identity?: Identity | null): string {
  return deidentify(question, identity);
}
