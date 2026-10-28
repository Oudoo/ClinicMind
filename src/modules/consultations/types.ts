import type { ClinicalExtraction } from "@/lib/ai/extraction";

/**
 * Wire shapes of the consultation API, shared by the route handlers, the
 * server-rendered page and the client components. Dates are ISO strings so
 * the same type describes a JSON response and a server-to-client prop.
 */

export type { ClinicalExtraction };

/** Transcript bounds enforced by POST /api/consultations/extract. */
export const TRANSCRIPT_MIN_LENGTH = 20;
export const TRANSCRIPT_MAX_LENGTH = 40_000;
/** Visit summary bound enforced on sign. */
export const SUMMARY_MAX_LENGTH = 5000;

/**
 * Per-field limits of a clinical extraction, for the review editor. They
 * mirror the Zod schema in `lib/ai/extraction.ts` (which the client must not
 * import, as it pulls in the AI providers and the server environment); the
 * route tests assert both stay equal.
 */
export const EXTRACTION_LIMITS = {
  items: 50,
  itemLength: 200,
  medicationName: 120,
  medicationField: 80,
} as const;

export type ConsultationStatus =
  | "RECORDING"
  | "TRANSCRIBING"
  | "EXTRACTING"
  | "PENDING_REVIEW"
  | "SIGNED"
  | "DISCARDED";

export const CONSULTATION_STATUSES: readonly ConsultationStatus[] = [
  "RECORDING",
  "TRANSCRIBING",
  "EXTRACTING",
  "PENDING_REVIEW",
  "SIGNED",
  "DISCARDED",
];

export interface ConsultationPerson {
  id: string;
  fullName: string | null;
}

export interface ConsultationListItem {
  id: string;
  status: ConsultationStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  visitId: string | null;
  patient: { id: string; fullName: string };
  /** The staff member who captured the consultation (may not be a clinician). */
  doctor: ConsultationPerson | null;
  summary: string | null;
}

export interface ConsultationDetail extends ConsultationListItem {
  transcript: string | null;
  extraction: ClinicalExtraction;
  reviewedBy: ConsultationPerson | null;
}

export interface ConsultationListResponse {
  consultations: ConsultationListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ExtractResponse {
  consultationId: string;
  extraction: ClinicalExtraction;
  summary: string;
  /** No structured data could be extracted; the review starts blank on purpose. */
  empty: boolean;
  appointmentId: string | null;
  provider: string;
  model: string;
}

/** Result of POST /api/consultations/transcribe: the transcript only; audio is not kept. */
export interface TranscribeResponse {
  transcript: string;
  provider: string;
  model: string;
  latencyMs: number;
  /** No intelligible speech was recognised. */
  empty: boolean;
}

export interface SignResponse {
  ok: true;
  visitId: string;
  patientId: string;
  editedByClinician: boolean;
  addedDiagnoses: string[];
  medications: {
    started: string[];
    adjusted: string[];
    continued: string[];
    stopped: string[];
  };
  appointmentId: string | null;
  /**
   * The linked appointment after signing: marked COMPLETED, or left as it was
   * with the reason (signed before its start time, or already cancelled).
   */
  appointment: { id: string; status: string; completed: boolean; reason: string | null } | null;
  /** Prescribing-safety findings at signing and the overrides recorded for them. */
  safety: { stops: number; warnings: number; overrides: number };
}

// ── Prescribing safety ───────────────────────────────────────────────────────

export type SafetySeverity = "stop" | "warn";

/** One prescribing-safety finding about a medication being prescribed. */
export interface SafetyFinding {
  /** Stable rule id, e.g. "allergy.cross-reactivity", "interaction.retinoid-tetracycline". */
  rule: string;
  /** "stop" needs a typed reason to sign anyway; "warn" needs acknowledging. */
  severity: SafetySeverity;
  /** The medication as written in the prescription. */
  medication: string;
  /** Plain English: names the drug and the reason. */
  message: string;
  detail: Record<string, unknown>;
}

/** A clinician's reason for prescribing despite a finding (sign body `overrides[]`). */
export interface SafetyOverrideInput {
  rule: string;
  medication: string;
  reason: string;
}

export const SAFETY_REASON_MIN_LENGTH = 10;
export const SAFETY_REASON_MAX_LENGTH = 1000;
/** Reason stored for a warning acknowledged without its own reason. */
export const SAFETY_WARNING_ACKNOWLEDGED = "acknowledged";

/** What the checks were run against, shown with the findings. */
export interface SafetyCheckContext {
  sex: string;
  age: number | null;
  allergies: string[];
  conditions: string[];
  activeMedications: string[];
}

/** POST /api/consultations/[id]/safety-check */
export interface SafetyCheckResponse {
  findings: SafetyFinding[];
  context: SafetyCheckContext;
}

/** 409 from sign: a stop without a reason, or warnings not acknowledged. The server's findings win. */
export interface SafetyConflictBody {
  error: "safety_stop" | "safety_warning";
  findings: SafetyFinding[];
  /** The stops that still need a reason. */
  missing: { rule: string; medication: string }[];
}

/** A removed diagnosis or medication the summary still mentions. */
export interface SummaryMention {
  kind: "medication" | "diagnosis";
  /** The item as it was in the AI draft. */
  item: string;
  /** The word or phrase found in the summary (the generic, the name or the diagnosis). */
  term: string;
  /** [start, end) offsets of each occurrence in the summary, for highlighting. */
  ranges: [number, number][];
}

/** 409 from sign when the summary still mentions removed items and was not confirmed. */
export interface SummaryMismatchBody {
  error: "summary_mismatch";
  mentions: SummaryMention[];
}

/** One row of the safety-override review list. */
export interface SafetyOverrideRow {
  id: string;
  createdAt: string;
  rule: string;
  severity: SafetySeverity;
  medication: string | null;
  message: string;
  reason: string;
  consultationId: string | null;
  doctor: ConsultationPerson;
  patient: { id: string; fullName: string | null };
}

export interface SafetyOverrideListResponse {
  overrides: SafetyOverrideRow[];
  total: number;
  page: number;
  pageSize: number;
  /** "all" for the clinic owner, "own" for a doctor. */
  scope: "all" | "own";
}

export interface ActiveMedication {
  id: string;
  name: string;
  dosage: string | null;
  frequency: string | null;
  startDate: string | null;
  visitId: string | null;
}

export interface PatientOption {
  id: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
}

export interface AppointmentOption {
  id: string;
  patientId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  reason: string | null;
}
