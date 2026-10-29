import { db } from "@/lib/db";
import { Pseudonyms, type Identity } from "./deidentify";

/**
 * Who may be named in what goes to an AI provider, read for the
 * de-identification (lib/ai/deidentify.ts): the patients' names, numbers,
 * e-mail and date of birth, and the clinic's staff names, which stay.
 */

/** The patients' identities, in the order of `ids` (unknown ids are left out). */
export async function patientIdentities(tenantId: string, ids: readonly string[]): Promise<Identity[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const rows = await db.patient.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true, phone: true, whatsapp: true, nationalId: true, email: true, dateOfBirth: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
}

/** The clinic's staff names: a doctor called Hassan is not a patient called Hassan. */
export async function staffNames(tenantId: string): Promise<string[]> {
  const rows = await db.user.findMany({ where: { tenantId }, select: { fullName: true } });
  return rows.map((r) => r.fullName ?? "").filter((n) => n.trim().length > 0);
}

/** One patient's text as it may leave the clinic (their name "the patient", their numbers and e-mail out), staff names kept. */
export async function scrubberFor(tenantId: string, patientId: string | null): Promise<(text: string) => string> {
  const [patients, staff] = await Promise.all([patientIdentities(tenantId, patientId ? [patientId] : []), staffNames(tenantId)]);
  const pseudonyms = new Pseudonyms(patients, { single: true, keep: staff });
  return (text) => pseudonyms.scrub(text);
}

export async function deidentifyForPatient(tenantId: string, patientId: string | null, text: string): Promise<string> {
  return (await scrubberFor(tenantId, patientId))(text);
}
