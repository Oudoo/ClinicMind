import type { Gender } from "@prisma/client";
import { db } from "@/lib/db";
import { addDays, startOfDayInTz, zonedParts } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";

/**
 * The assistant's evaluation set (audit #16): fixed questions whose correct
 * answer is computed independently of the assistant, from a snapshot of the
 * clinic's records, by plain predicates written per question. The same set runs
 * on every commit against a fixture clinic (eval.test.ts) and on demand against
 * the demo clinic (scripts/assistant-eval.ts). Each answer must contain exactly
 * the expected patients (precision and recall 100%).
 *
 * The oracles deliberately do not reuse the parser or the cohort query: they
 * restate each question's meaning as regular expressions over the raw records.
 */

export interface SnapshotPatient {
  id: string;
  fullName: string;
  gender: Gender;
  dob: Date | null;
  tags: string[];
  createdAt: Date;
  allergies: string[];
  conditions: string[];
  surgeries: string[];
  activeMeds: { name: string; dosage: string | null }[];
  signedDiagnoses: string[];
  signedProcedures: string[];
  visits: { at: Date; doctorId: string | null }[];
  appointments: { at: Date; status: string; doctorId: string | null }[];
}

export interface Snapshot {
  tenantId: string;
  now: Date;
  timeZone: string;
  patients: SnapshotPatient[];
  doctors: { id: string; name: string }[];
}

export type ExpectedMode = "cohort" | "patient" | "rag" | "clarify";

export interface Expectation {
  mode: ExpectedMode;
  /** The exact set of patients the answer must list (cohort / patient / clarify modes). */
  ids?: string[];
  /** Retrieval answers: every cited patient must be in this set, and retrieval must have been used. */
  citedWithin?: string[];
  /** Yes/no checks: the verdict. */
  verdict?: "yes" | "no";
}

export interface EvalCase {
  id: string;
  category: string;
  question: string;
  expect: (s: Snapshot) => Expectation;
}

/** Load every non-archived patient of the tenant with the fields the oracles read. */
export async function loadSnapshot(tenantId: string, now = new Date()): Promise<Snapshot> {
  const timeZone = await getTenantTimezone(tenantId);
  const [patients, doctors] = await Promise.all([
    db.patient.findMany({
      where: { tenantId, deletedAt: null },
      select: {
        id: true,
        fullName: true,
        gender: true,
        dateOfBirth: true,
        tags: true,
        createdAt: true,
        medicalHistory: { select: { allergies: true, chronicConditions: true, diagnoses: true, surgeries: true } },
        medications: { where: { active: true, stoppedAt: null }, select: { name: true, dosage: true } },
        consultations: { where: { status: "SIGNED" }, select: { extraction: true } },
        procedures: { where: { status: "SIGNED", deletedAt: null }, select: { treatment: { select: { name: true, key: true } } } },
        visits: { select: { createdAt: true, doctorId: true } },
        appointments: { where: { deletedAt: null }, select: { startsAt: true, status: true, doctorId: true } },
      },
    }),
    db.user.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, fullName: true, email: true } }),
  ]);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : []);
  return {
    tenantId,
    now,
    timeZone,
    doctors: doctors.map((d) => ({ id: d.id, name: d.fullName ?? d.email })),
    patients: patients.map((p) => ({
      id: p.id,
      fullName: p.fullName,
      gender: p.gender,
      dob: p.dateOfBirth,
      tags: p.tags,
      createdAt: p.createdAt,
      allergies: list(p.medicalHistory?.allergies),
      conditions: [...list(p.medicalHistory?.chronicConditions), ...list(p.medicalHistory?.diagnoses)],
      surgeries: list(p.medicalHistory?.surgeries),
      activeMeds: p.medications,
      signedDiagnoses: p.consultations.flatMap((c) => list((c.extraction as { diagnoses?: unknown } | null)?.diagnoses)),
      signedProcedures: p.procedures.map((x) => `${x.treatment.name} ${x.treatment.key}`),
      visits: p.visits.map((v) => ({ at: v.createdAt, doctorId: v.doctorId })),
      appointments: p.appointments.map((a) => ({ at: a.startsAt, status: a.status, doctorId: a.doctorId })),
    })),
  };
}

// ── oracle helpers (independent of the assistant's own matching code) ────────

const PENICILLINS = /penic+il+in|penicilin|amoxic+il+in|amoxil|augmentin|co-?amoxiclav|ampicil+in|flucloxacil+in|cloxacil+in|piperacil+in|tazocin|بنسلين|بنسيلين/i;
const LIDOCAINE = /lidocain|lignocain|xylocain|ليدوكا|زيلوكا/i;
const LATEX = /latex|لاتكس|لاتيكس/i;
const PCOS = /\bpcos\b|polycystic ovar|تكيس/i;
const ROSACEA = /rosacea|وردي/i;
const PSORIASIS = /psoria|صدفي/i;
const ACNE = /\bacne\b|حب الشباب/i;
const MELASMA = /melasma|كلف/i;
const ISOTRETINOIN = /isotretinoin|roaccutane|accutane|acnotren/i;
const FINASTERIDE = /finasteride|propecia|proscar/i;
const CEPHALEXIN = /cephalexin|cefalexin|keflex|ceporex/i;
const TRANEXAMIC = /tranexamic|cyklokapron/i;
const HAIR_TRANSPLANT = /hair transplant|\bfue\b|hair-transplant/i;

const any = (xs: string[], re: RegExp) => xs.some((x) => re.test(x));
const ids = (ps: SnapshotPatient[]) => ps.map((p) => p.id);

function ageOf(p: SnapshotPatient, s: Snapshot): number | null {
  if (!p.dob) return null;
  const t = zonedParts(s.now, s.timeZone);
  const by = p.dob.getUTCFullYear();
  const bm = p.dob.getUTCMonth() + 1;
  const bd = p.dob.getUTCDate();
  return t.year - by - (t.month < bm || (t.month === bm && t.day < bd) ? 1 : 0);
}

function byName(s: Snapshot, name: string): SnapshotPatient[] {
  return s.patients.filter((p) => p.fullName.trim().toLowerCase() === name.toLowerCase());
}

/** A yes/no question about one named patient: "patient" mode when exactly one patient has the name. */
function namedCheck(s: Snapshot, name: string, test: (p: SnapshotPatient) => boolean): Expectation {
  const matches = byName(s, name);
  if (matches.length !== 1) return { mode: "clarify", ids: [] };
  return { mode: "patient", ids: [matches[0]!.id], verdict: test(matches[0]!) ? "yes" : "no" };
}

const conditionsOf = (p: SnapshotPatient) => [...p.conditions, ...p.signedDiagnoses];
const upcoming = (p: SnapshotPatient, s: Snapshot) => p.appointments.some((a) => a.at >= s.now && !["CANCELLED", "NO_SHOW", "COMPLETED"].includes(a.status));

export const EVAL_CASES: EvalCase[] = [
  // ── allergies ──
  {
    id: "allergy-or",
    category: "allergy (or)",
    question: "Which patients have a documented allergy to lidocaine or penicillin?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(p.allergies, PENICILLINS) || any(p.allergies, LIDOCAINE))) }),
  },
  {
    id: "allergy-penicillin",
    category: "allergy",
    question: "Which patients have a documented allergy to penicillin?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(p.allergies, PENICILLINS))) }),
  },
  {
    id: "allergy-typo",
    category: "allergy (typo)",
    question: "Who is alergic to penicilin?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(p.allergies, PENICILLINS))) }),
  },
  {
    id: "allergy-arabic",
    category: "allergy (Arabic)",
    question: "مين عنده حساسية من البنسلين؟",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(p.allergies, PENICILLINS))) }),
  },
  {
    id: "allergy-lidocaine",
    category: "allergy (brand in record)",
    question: "List patients allergic to lidocaine",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(p.allergies, LIDOCAINE))) }),
  },
  {
    id: "allergy-and",
    category: "allergy (and)",
    question: "Which patients are allergic to penicillin and latex?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(p.allergies, PENICILLINS) && any(p.allergies, LATEX))) }),
  },
  {
    id: "allergy-nothing",
    category: "nothing matches",
    question: "Which patients have a documented allergy to chlorhexidine?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(p.allergies, /chlorhexidine|كلورهيكسيدين/i))) }),
  },
  {
    id: "allergy-none-recorded",
    category: "allergy (negated)",
    question: "Which patients have no known allergies?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.allergies.length === 0)) }),
  },
  // ── conditions ──
  {
    id: "pcos-male",
    category: "condition + sex",
    question: "Which male patients have PCOS?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.gender === "MALE" && any(conditionsOf(p), PCOS))) }),
  },
  {
    id: "pcos-female",
    category: "condition (synonym) + sex",
    question: "Which women have polycystic ovary syndrome?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.gender === "FEMALE" && any(conditionsOf(p), PCOS))) }),
  },
  {
    id: "rosacea-count",
    category: "condition (signed consultations)",
    question: "How many patients have rosacea?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(conditionsOf(p), ROSACEA))) }),
  },
  {
    id: "pcos-male-arabic",
    category: "condition + sex (Arabic)",
    question: "رجالة عندهم تكيس على المبايض",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.gender === "MALE" && any(conditionsOf(p), PCOS))) }),
  },
  {
    id: "psoriasis-arabic-count",
    category: "condition (Arabic count)",
    question: "كام مريض عنده صدفية؟",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(conditionsOf(p), PSORIASIS))) }),
  },
  {
    id: "acne-prescribed",
    category: "condition + detail",
    question: "Who was treated for acne vulgaris and what was prescribed?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(conditionsOf(p), ACNE))) }),
  },
  // ── medications ──
  {
    id: "isotretinoin-generic",
    category: "medication (generic)",
    question: "Who is currently on isotretinoin, and at what dose?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.activeMeds.some((m) => ISOTRETINOIN.test(m.name)))) }),
  },
  {
    id: "isotretinoin-brand",
    category: "medication (brand)",
    question: "Which patients take Roaccutane?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.activeMeds.some((m) => ISOTRETINOIN.test(m.name)))) }),
  },
  {
    id: "finasteride-strength",
    category: "medication (strength)",
    question: "Who takes finasteride 1 mg?",
    expect: (s) => ({
      mode: "cohort",
      ids: ids(s.patients.filter((p) => p.activeMeds.some((m) => FINASTERIDE.test(m.name) && /(^|[^\d.])1\s?mg/i.test(`${m.name} ${m.dosage ?? ""}`)))),
    }),
  },
  {
    id: "cephalexin",
    category: "medication (brand in record)",
    question: "Which patients are on cephalexin?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.activeMeds.some((m) => CEPHALEXIN.test(m.name)))) }),
  },
  {
    id: "warfarin-nothing",
    category: "nothing matches",
    question: "Which patients are on warfarin?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.activeMeds.some((m) => /warfarin|coumadin|marevan/i.test(m.name)))) }),
  },
  {
    id: "not-finasteride",
    category: "medication (negated)",
    question: "Which patients are not on finasteride?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => !p.activeMeds.some((m) => FINASTERIDE.test(m.name)))) }),
  },
  // ── sex and age ──
  {
    id: "finasteride-over-50",
    category: "medication + age",
    question: "Which patients over 50 are on finasteride?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => (ageOf(p, s) ?? -1) > 50 && p.activeMeds.some((m) => FINASTERIDE.test(m.name)))) }),
  },
  {
    id: "female-under-18",
    category: "sex + age",
    question: "List female patients under 18",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.gender === "FEMALE" && ageOf(p, s) !== null && ageOf(p, s)! < 18)) }),
  },
  {
    id: "age-between",
    category: "age range",
    question: "Which patients are between 20 and 30 years old?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => { const a = ageOf(p, s); return a !== null && a >= 20 && a <= 30; })) }),
  },
  {
    id: "women-over-40",
    category: "sex + age (birthday edge)",
    question: "Which female patients are over 40?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.gender === "FEMALE" && (ageOf(p, s) ?? -1) > 40)) }),
  },
  {
    id: "arabic-sex-age-allergy",
    category: "sex + age + allergy (Arabic)",
    question: "ستات فوق ٤٠ عندهم حساسية من البنسلين",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.gender === "FEMALE" && (ageOf(p, s) ?? -1) > 40 && any(p.allergies, PENICILLINS))) }),
  },
  // ── tags, doctors, appointments, last visit, procedures ──
  {
    id: "vip-melasma",
    category: "tag + condition",
    question: "Which VIP patients have melasma?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => p.tags.some((t) => t.toLowerCase() === "vip") && any(conditionsOf(p), MELASMA))) }),
  },
  {
    id: "doctor-acne",
    category: "doctor + condition",
    question: "Which patients of Dr. Mariam Tarek have acne?",
    expect: (s) => {
      const doctor = s.doctors.find((d) => /mariam tarek/i.test(d.name));
      if (!doctor) return { mode: "clarify", ids: [] };
      return {
        mode: "cohort",
        ids: ids(
          s.patients.filter(
            (p) =>
              any(conditionsOf(p), ACNE) &&
              (p.visits.some((v) => v.doctorId === doctor.id) ||
                p.appointments.some((a) => a.doctorId === doctor.id && a.at >= s.now && !["CANCELLED", "NO_SHOW"].includes(a.status))),
          ),
        ),
      };
    },
  },
  {
    id: "upcoming",
    category: "upcoming appointment",
    question: "Which patients have an upcoming appointment?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => upcoming(p, s))) }),
  },
  {
    id: "not-seen-6-months",
    category: "no visit since",
    question: "Which patients haven't been seen in 6 months?",
    expect: (s) => {
      const cutoff = addDays(startOfDayInTz(s.now, s.timeZone), -180, s.timeZone);
      return {
        mode: "cohort",
        ids: ids(
          s.patients.filter((p) => {
            const last = p.visits.reduce<Date | null>((m, v) => (!m || v.at > m ? v.at : m), null);
            return last ? last < cutoff : p.createdAt < cutoff;
          }),
        ),
      };
    },
  },
  {
    id: "hair-transplant",
    category: "surgery / procedure + detail",
    question: "Which patients had an FUE hair transplant, and how many grafts?",
    expect: (s) => ({ mode: "cohort", ids: ids(s.patients.filter((p) => any(p.surgeries, HAIR_TRANSPLANT) || any(p.signedProcedures, HAIR_TRANSPLANT))) }),
  },
  // ── named patients ──
  {
    id: "named-tarek-cephalexin",
    category: "named patient (no)",
    question: "Is Tarek Ezzat on Cephalexin?",
    expect: (s) => namedCheck(s, "Tarek Ezzat", (p) => p.activeMeds.some((m) => CEPHALEXIN.test(m.name))),
  },
  {
    id: "named-hassan-keflex",
    category: "named patient (brand)",
    question: "Is Hassan Ezzat on Keflex?",
    expect: (s) => namedCheck(s, "Hassan Ezzat", (p) => p.activeMeds.some((m) => CEPHALEXIN.test(m.name))),
  },
  {
    id: "named-arabic",
    category: "named patient (Arabic)",
    question: "هل طارق عزت بياخد سيفالكسين؟",
    expect: (s) => namedCheck(s, "Tarek Ezzat", (p) => p.activeMeds.some((m) => CEPHALEXIN.test(m.name))),
  },
  {
    id: "named-ambiguous",
    category: "named patient (ambiguous)",
    question: "Is Ahmed on finasteride?",
    expect: (s) => {
      const ahmeds = s.patients.filter((p) => /^ahmed\b/i.test(p.fullName.trim()));
      if (ahmeds.length === 1) return { mode: "patient", ids: [ahmeds[0]!.id], verdict: ahmeds[0]!.activeMeds.some((m) => FINASTERIDE.test(m.name)) ? "yes" : "no" };
      return { mode: "clarify", ids: [] };
    },
  },
  {
    id: "not-understood",
    category: "criterion not understood",
    question: "Which patients of Dr. Smith have acne?",
    expect: () => ({ mode: "clarify", ids: [] }),
  },
  // ── open questions: still answered by retrieval ──
  {
    id: "open-today",
    category: "open question (retrieval)",
    question: "Summarise today's appointments",
    expect: (s) => {
      const t0 = startOfDayInTz(s.now, s.timeZone);
      const t1 = addDays(t0, 1, s.timeZone);
      return { mode: "rag", citedWithin: ids(s.patients.filter((p) => p.appointments.some((a) => a.at >= t0 && a.at < t1 && a.status !== "CANCELLED"))) };
    },
  },
  {
    id: "open-melasma",
    category: "open question (retrieval)",
    question: "Compare melasma progress for patients on tranexamic acid",
    expect: (s) => ({
      mode: "rag",
      citedWithin: ids(s.patients.filter((p) => any(conditionsOf(p), MELASMA) && p.activeMeds.some((m) => TRANEXAMIC.test(m.name)))),
    }),
  },
];
