import { db } from "@/lib/db";
import { getTenantTimezone } from "@/modules/appointments/service";
import { toAsciiDigits } from "@/modules/assistant/text";
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
  /** The patient's name words, numbers and e-mail: taken out of the question. */
  identifiers: string[];
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
  const identifiers = [
    ...patient.fullName.split(/\s+/).filter((w) => w.length >= 3),
    ...[patient.phone, patient.whatsapp, patient.nationalId, patient.email].filter((v): v is string => Boolean(v)),
  ];
  return { lines, identifiers };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The question with the patient's name words, any long number (phone, ID) and any e-mail address taken out. */
export function redactQuestion(question: string, identifiers: string[] = []): string {
  let out = toAsciiDigits(question).replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, "[email]");
  out = out.replace(/\+?\d[\d\s-]{5,}\d/g, "[number]");
  for (const id of identifiers) {
    if (/\d/.test(id) || id.includes("@")) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(id)}(?![\\p{L}\\p{N}])`, "giu"), "the patient");
  }
  return out.replace(/(the patient)(\s+the patient)+/gi, "$1");
}
