import { NextResponse } from "next/server";
import {
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentNotReschedulableError,
  AppointmentTimeError,
  BookingTimeError,
  DoctorNotBookableError,
  InvalidTransitionError,
  PatientConflictError,
} from "@/modules/appointments/service";
import { AppointmentNoteForbiddenError, AppointmentNoteNotFoundError } from "@/modules/appointments/notes";

/**
 * HTTP mapping for the appointment service's domain errors. Returns null for
 * anything else so handlers fall through to the shared `handleApiError`.
 */
export function appointmentErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AppointmentConflictError) {
    return NextResponse.json({ error: "conflict", conflicts: err.conflicts }, { status: 409 });
  }
  if (err instanceof PatientConflictError) {
    return NextResponse.json({ error: "patient_conflict", conflicts: err.conflicts }, { status: 409 });
  }
  if (err instanceof InvalidTransitionError) {
    return NextResponse.json({ error: "invalid_transition", from: err.from, to: err.to }, { status: 409 });
  }
  if (err instanceof AppointmentNotReschedulableError) {
    return NextResponse.json({ error: "not_reschedulable", status: err.appointmentStatus }, { status: 409 });
  }
  if (err instanceof AppointmentTimeError) {
    // 409 too_early (no-show or completion before the start) / not_today (check-in on another day).
    return NextResponse.json({ error: err.code, message: err.message, from: err.from, to: err.to }, { status: 409 });
  }
  if (err instanceof BookingTimeError) {
    // 422 in_the_past / outside_hours; `overridable` when an owner may resend it with allowPast / allowOutsideHours.
    return NextResponse.json(
      { error: err.code, message: err.message, overridable: err.overridable, ...(err.hours ? { hours: err.hours } : {}) },
      { status: 422 },
    );
  }
  if (err instanceof DoctorNotBookableError) {
    return NextResponse.json({ error: "doctor_not_bookable", message: err.message }, { status: 422 });
  }
  if (err instanceof AppointmentNotFoundError) {
    return NextResponse.json({ error: "not_found", entity: "appointment" }, { status: 404 });
  }
  if (err instanceof AppointmentNoteNotFoundError) {
    return NextResponse.json({ error: "not_found", entity: "note" }, { status: 404 });
  }
  if (err instanceof AppointmentNoteForbiddenError) {
    return NextResponse.json({ error: "forbidden", message: err.message }, { status: 403 });
  }
  return null;
}
