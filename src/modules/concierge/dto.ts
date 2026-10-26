import type { ProtocolQuestion, StepKind } from "./protocols";
import type { TriageFlag, TriageLevel } from "./triage";

/**
 * JSON-safe shapes the API returns and server pages hand to client components
 * (dates as ISO strings). No server imports, so client code can import it.
 */
export type TaskStatus = "PENDING" | "SENT" | "ANSWERED" | "MISSED" | "SKIPPED";
export type EnrolmentStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "STOPPED";
export type EscalationStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export type ProtocolStatus = "DRAFT" | "ACTIVE" | "RETIRED";
export type CheckInSource = "link" | "staff" | "whatsapp";

export interface PersonDTO {
  id: string;
  fullName: string;
}

export interface CheckInDTO {
  id: string;
  answers: Record<string, unknown>;
  satisfaction: number | null;
  freeText: string | null;
  photoIds: string[];
  triage: TriageLevel;
  flags: TriageFlag[];
  source: string;
  submittedAt: string;
}

export interface TaskDTO {
  id: string;
  stepIndex: number;
  kind: StepKind;
  title: string;
  /** "Day 7" */
  dayLabel: string;
  dueAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  missedAt: string | null;
  status: TaskStatus;
  attempts: number;
  lastError: string | null;
  hasHighRisk: boolean;
  questions: ProtocolQuestion[];
  satisfaction: boolean;
  photos: string[];
  body: { ar: string; en: string } | null;
  checkIn: CheckInDTO | null;
}

export interface EscalationDTO {
  id: string;
  kind: string;
  level: TriageLevel;
  status: EscalationStatus;
  summary: string;
  details: Record<string, unknown> | null;
  flags: TriageFlag[];
  patientId: string | null;
  patientName: string | null;
  enrolmentId: string | null;
  checkInId: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  outOfHours: boolean;
  createdAt: string;
  dueAt: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolution: string | null;
}

export interface EnrolmentSummaryDTO {
  id: string;
  status: EnrolmentStatus;
  language: string;
  channel: string;
  startedAt: string;
  completedAt: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  patient: PersonDTO & { phone: string | null; language: string };
  treatment: { id: string; key: string; name: string };
  protocol: { id: string; name: string; version: number; lengthDays: number };
  procedure: { id: string; performedAt: string; doctorName: string | null };
  progress: {
    /** Tasks no longer waiting (answered, missed, skipped or an instruction that went out). */
    done: number;
    total: number;
    /** Day N since the procedure on the clinic clock. */
    day: number;
    nextDueAt: string | null;
    nextTitle: string | null;
    lastTriage: TriageLevel | null;
    lastCheckInAt: string | null;
    openEscalations: number;
  };
}

export interface EnrolmentDetailDTO extends EnrolmentSummaryDTO {
  tasks: TaskDTO[];
  escalations: EscalationDTO[];
}

export interface BoardTaskDTO {
  id: string;
  enrolmentId: string;
  patient: PersonDTO;
  title: string;
  dayLabel: string;
  kind: StepKind;
  status: TaskStatus;
  dueAt: string;
  sentAt: string | null;
  attempts: number;
  hasHighRisk: boolean;
}

export interface BoardCheckInDTO {
  id: string;
  enrolmentId: string;
  patient: PersonDTO;
  title: string;
  triage: TriageLevel;
  satisfaction: number | null;
  submittedAt: string;
  source: string;
  flags: TriageFlag[];
}

export interface BoardDTO {
  timezone: string;
  now: string;
  kpis: {
    answerRate: { answered: number; sent: number; pct: number | null };
    highRiskAck: { within: number; counted: number; pct: number | null; medianMinutes: number | null };
    openEscalations: number;
    overdueEscalations: number;
    activeEnrolments: number;
  };
  escalations: EscalationDTO[];
  dueToday: BoardTaskDTO[];
  awaiting: BoardTaskDTO[];
  answeredToday: BoardCheckInDTO[];
}

export interface ProtocolDTO {
  id: string;
  treatmentId: string;
  name: string;
  version: number;
  status: ProtocolStatus;
  steps: import("./protocols").ProtocolStep[];
  notes: string | null;
  approvedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  enrolments: number;
}

export interface TreatmentProtocolsDTO {
  treatment: { id: string; key: string; name: string; active: boolean };
  active: ProtocolDTO | null;
  drafts: ProtocolDTO[];
  retired: ProtocolDTO[];
}

/** What the public check-in page needs; nothing that identifies the clinic's other patients. */
export interface PublicCheckInDTO {
  clinicName: string;
  clinicPhone: string | null;
  language: "ar" | "en";
  patientFirstName: string;
  status: TaskStatus;
  step: {
    index: number;
    kind: StepKind;
    title: string;
    dayLabel: { ar: string; en: string };
    heading: { ar: string; en: string };
    body: { ar: string; en: string };
    questions: ProtocolQuestion[];
    satisfaction: boolean;
    photos: string[];
  };
}

export interface PublicCheckInResult {
  ok: true;
  triage: TriageLevel;
  clinicPhone: string | null;
  /** Minutes within which a human calls back (high-risk only). */
  callbackMinutes: number | null;
}
