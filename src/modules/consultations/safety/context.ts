import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normaliseClinicalTerm } from "../normalise";
import {
  SAFETY_WARNING_ACKNOWLEDGED,
  type SafetyCheckContext,
  type SafetyFinding,
  type SafetyOverrideInput,
} from "../types";
import { ageInYears, checkPrescribing } from "./engine";
import type { MedicationText } from "./identify";
import { pregnancyKnown, type PregnancyRecord } from "@/modules/patients/pregnancy";

/**
 * Server side of the prescribing checks: what the database says about the
 * patient (sex, date of birth, documented allergies, chronic conditions and
 * past diagnoses, active medications) and how a signing request's overrides
 * answer the findings. The findings are always recomputed here — the browser's
 * copy is only a preview.
 */

type Client = Prisma.TransactionClient | typeof db;

export interface SafetyPatientRecord extends PregnancyRecord {
  gender: string;
  dateOfBirth: Date | null;
  allergies: string[];
  chronicConditions: string[];
  diagnoses: string[];
  activeMedications: { id: string; name: string; dosage: string | null; frequency: string | null }[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

/** The patient's safety-relevant record. The caller has already proven the patient is the tenant's. */
export async function loadSafetyRecord(client: Client, tenantId: string, patientId: string): Promise<SafetyPatientRecord> {
  const patient = await client.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { gender: true, dateOfBirth: true, pregnancyStatus: true, pregnancyCheckedAt: true },
  });
  const history = await client.medicalHistory.findFirst({
    where: { patientId, tenantId },
    select: { allergies: true, chronicConditions: true, diagnoses: true },
  });
  const activeMedications = await client.medication.findMany({
    where: { tenantId, patientId, active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, dosage: true, frequency: true },
  });
  return {
    gender: patient?.gender ?? "UNDISCLOSED",
    dateOfBirth: patient?.dateOfBirth ?? null,
    pregnancyStatus: patient?.pregnancyStatus ?? null,
    pregnancyCheckedAt: patient?.pregnancyCheckedAt ?? null,
    allergies: stringList(history?.allergies),
    chronicConditions: stringList(history?.chronicConditions),
    diagnoses: stringList(history?.diagnoses),
    activeMedications,
  };
}

export interface SafetyRunInput {
  proposed: readonly MedicationText[];
  /** Diagnoses of the consultation being signed (they count as conditions too). */
  diagnoses?: readonly string[];
  /** Active medications the clinician stops in the same signing: not checked against. */
  stopMedicationIds?: readonly string[];
  now?: Date;
}

export function runSafetyChecks(record: SafetyPatientRecord, input: SafetyRunInput): { findings: SafetyFinding[]; context: SafetyCheckContext } {
  const now = input.now ?? new Date();
  const stopped = new Set(input.stopMedicationIds ?? []);
  const active = record.activeMedications.filter((m) => !stopped.has(m.id));
  const conditions = uniqueTerms([...record.chronicConditions, ...record.diagnoses, ...(input.diagnoses ?? [])]);
  const findings = checkPrescribing({
    // A pregnancy recorded recently is known (excluded: the teratogen checks need no reason); otherwise unknown.
    patient: { gender: record.gender, dateOfBirth: record.dateOfBirth, pregnant: pregnancyKnown(record, now) },
    allergies: record.allergies,
    conditions,
    activeMedications: active,
    proposed: input.proposed,
    now,
  });
  return {
    findings,
    context: {
      sex: record.gender,
      age: ageInYears(record.dateOfBirth, now),
      allergies: record.allergies,
      conditions,
      activeMedications: active.map((m) => [m.name, m.dosage, m.frequency].filter(Boolean).join(" · ")),
    },
  };
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms.filter((t) => {
    const key = normaliseClinicalTerm(t);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Overrides answer findings by rule and medication (case- and spacing-insensitive). */
export function overrideKey(rule: string, medication: string): string {
  return `${rule.trim()}|${normaliseClinicalTerm(medication)}`;
}

export type OverrideResolution =
  | { ok: true; accepted: { finding: SafetyFinding; reason: string }[] }
  | { ok: false; error: "safety_stop" | "safety_warning"; missing: { rule: string; medication: string }[] };

/**
 * Every "stop" needs an override with a reason; "warn" findings need the
 * acknowledgement flag (a specific reason may be given, otherwise
 * "acknowledged" is recorded). Overrides for findings that no longer exist
 * are ignored.
 */
export function resolveOverrides(
  findings: readonly SafetyFinding[],
  overrides: readonly SafetyOverrideInput[],
  acknowledgedWarnings: boolean,
): OverrideResolution {
  const reasons = new Map(overrides.map((o) => [overrideKey(o.rule, o.medication), o.reason.trim()]));
  const missing = findings
    .filter((f) => f.severity === "stop" && !reasons.get(overrideKey(f.rule, f.medication)))
    .map((f) => ({ rule: f.rule, medication: f.medication }));
  if (missing.length) return { ok: false, error: "safety_stop", missing };
  if (findings.some((f) => f.severity === "warn") && !acknowledgedWarnings) {
    return { ok: false, error: "safety_warning", missing: [] };
  }
  return {
    ok: true,
    accepted: findings.map((finding) => ({
      finding,
      reason: reasons.get(overrideKey(finding.rule, finding.medication)) || SAFETY_WARNING_ACKNOWLEDGED,
    })),
  };
}
