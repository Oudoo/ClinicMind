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
