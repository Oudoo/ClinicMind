import type { AppointmentStatus } from "./transitions";

/**
 * JSON-safe shapes of an appointment as the API returns it and as server pages
 * hand it to client components (dates as ISO strings). Kept free of server
 * imports so client code can import it.
 */

export interface PersonSummaryDTO {
  id: string;
  fullName: string;
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
  reason: string | null;
  notes: string | null;
  cancelReason: string | null;
  source: string;
  patient: PersonSummaryDTO;
  doctor: PersonSummaryDTO | null;
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

interface AppointmentRowLike {
  id: string;
  patientId: string;
  doctorId: string | null;
  clinicId: string | null;
  room: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  cancelReason: string | null;
  source: string;
  patient: PersonSummaryDTO;
  doctor: PersonSummaryDTO | null;
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
    reason: a.reason,
    notes: a.notes,
    cancelReason: a.cancelReason,
    source: a.source,
    patient: a.patient,
    doctor: a.doctor,
  };
}
