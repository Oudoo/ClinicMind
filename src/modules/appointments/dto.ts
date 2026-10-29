import type { VisitRecallDTO } from "@/modules/recalls/dto";
import type { AppointmentKind, AppointmentNoteKind, AppointmentStatus, WorkingHours } from "./transitions";

/**
 * JSON-safe shapes of an appointment as the API returns it and as server pages
 * hand it to client components (dates as ISO strings). Kept free of server
 * imports so client code can import it.
 */

export interface PersonSummaryDTO {
  id: string;
  fullName: string;
}

export interface AppointmentNoteDTO {
  id: string;
  appointmentId: string;
  patientId: string;
  kind: AppointmentNoteKind;
  body: string;
  language: string | null;
  durationSeconds: number | null;
  createdAt: string;
  author: PersonSummaryDTO | null;
}

export interface AppointmentDTO {
  id: string;
  patientId: string;
  doctorId: string | null;
  clinicId: string | null;
  room: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  kind: AppointmentKind;
  reason: string | null;
  notes: string | null;
  cancelReason: string | null;
  source: string;
  confirmedAt: string | null;
  /** The patient was asked to confirm a moved time and has not answered yet (status stays SCHEDULED). */
  confirmationRequestedAt: string | null;
  checkedInAt: string | null;
  /** Live (not removed) dictated or typed notes on the booking. */
  notesCount: number;
  patient: PersonSummaryDTO;
  doctor: PersonSummaryDTO | null;
  /** What the patient owes now (negative: credit); only for the roles that take payments. */
  patientBalance?: number;
  /** Present when one appointment is read (`GET /api/appointments/[id]`). */
  dictatedNotes?: AppointmentNoteDTO[];
}

/** What happened to the request that the patient confirm a moved time (PATCH /api/appointments/[id]). */
export interface ConfirmationRequestDTO {
  requested: boolean;
  /** SENT, LOGGED (no channel connected: on the conversation for the desk to send), FAILED or null (nothing sent). */
  delivery: "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "LOGGED" | null;
  /** `no_phone`, `error`, or the channel's failure reason. */
  reason: string | null;
  conversationId: string | null;
}

export interface AppointmentConflictDTO {
  id: string;
  startsAt: string;
  endsAt: string;
  doctorId: string | null;
  room: string | null;
  status: AppointmentStatus;
  patient: PersonSummaryDTO;
  doctor: PersonSummaryDTO | null;
}

/** `GET /api/appointments/next`. */
export interface NextAppointmentDTO {
  appointment: AppointmentDTO | null;
  /** The rest of today's queue (or the patient's following bookings), next three. */
  queue: AppointmentDTO[];
  scope: "mine" | "clinic" | "patient";
  /** The viewer has no booking of their own, so the clinic's next one is shown. */
  fallback: boolean;
  timezone: string;
  /** The clinic's opening hours (for the booking form's default time and closed-day hint). */
  hours: WorkingHours;
  /** Server clock at the time of the answer, for the client's countdown. */
  now: string;
  /** The patient's recalls for `appointment`: what it is booked for, then what is due by then (recalls/service.ts). */
  recalls?: VisitRecallDTO[];
}

/** One cell of the free-slot grid (`GET /api/appointments/free-slots`). */
export interface SlotCellDTO {
  startsAt: string;
  endsAt: string;
  free: boolean;
  past: boolean;
  takenBy: {
    id: string;
    startsAt: string;
    endsAt: string;
    status: AppointmentStatus;
    doctorId: string | null;
    room: string | null;
    patientInitials: string;
    patientName: string;
  }[];
}

export interface SlotSuggestionDTO {
  startsAt: string;
  endsAt: string;
  /** `YYYY-MM-DD` on the clinic clock. */
  date: string;
}

export interface FreeSlotsDTO {
  date: string;
  timezone: string;
  hours: WorkingHours;
  closed: boolean;
  stepMinutes: number;
  durationMinutes: number;
  slots: SlotCellDTO[];
  /** ISO start times of the free cells. */
  free: string[];
  /** The next three free starts after `after` (or after now), looking ahead a week when the day is full. */
  suggestions: SlotSuggestionDTO[];
}

interface NoteRowLike {
  id: string;
  appointmentId: string;
  patientId: string;
  kind: AppointmentNoteKind;
  body: string;
  language: string | null;
  durationSeconds: number | null;
  createdAt: Date;
  author: PersonSummaryDTO | null;
}

interface AppointmentRowLike {
  id: string;
  patientId: string;
  doctorId: string | null;
  clinicId: string | null;
  room: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  kind: AppointmentKind;
  reason: string | null;
  notes: string | null;
  cancelReason: string | null;
  source: string;
  confirmedAt?: Date | null;
  confirmationRequestedAt?: Date | null;
  checkedInAt?: Date | null;
  notesCount?: number;
  patient: PersonSummaryDTO;
  doctor: PersonSummaryDTO | null;
  dictatedNotes?: NoteRowLike[];
}

export function toAppointmentNoteDTO(n: NoteRowLike): AppointmentNoteDTO {
  return {
    id: n.id,
    appointmentId: n.appointmentId,
    patientId: n.patientId,
    kind: n.kind,
    body: n.body,
    language: n.language,
    durationSeconds: n.durationSeconds,
    createdAt: n.createdAt.toISOString(),
    author: n.author,
  };
}

export function toAppointmentDTO(a: AppointmentRowLike): AppointmentDTO {
  return {
    id: a.id,
    patientId: a.patientId,
    doctorId: a.doctorId,
    clinicId: a.clinicId,
    room: a.room,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    status: a.status,
    kind: a.kind,
    reason: a.reason,
    notes: a.notes,
    cancelReason: a.cancelReason,
    source: a.source,
    confirmedAt: a.confirmedAt ? a.confirmedAt.toISOString() : null,
    confirmationRequestedAt: a.status === "SCHEDULED" && a.confirmationRequestedAt ? a.confirmationRequestedAt.toISOString() : null,
    checkedInAt: a.checkedInAt ? a.checkedInAt.toISOString() : null,
    notesCount: a.notesCount ?? a.dictatedNotes?.length ?? 0,
    patient: a.patient,
    doctor: a.doctor,
    ...(a.dictatedNotes ? { dictatedNotes: a.dictatedNotes.map(toAppointmentNoteDTO) } : {}),
  };
}
