import { NextResponse } from "next/server";
import {
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentNotReschedulableError,
  InvalidTransitionError,
} from "@/modules/appointments/service";

/**
 * HTTP mapping for the appointment service's domain errors. Returns null for
 * anything else so handlers fall through to the shared `handleApiError`.
 */
export function appointmentErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AppointmentConflictError) {
    return NextResponse.json({ error: "conflict", conflicts: err.conflicts }, { status: 409 });
  }
  if (err instanceof InvalidTransitionError) {
    return NextResponse.json({ error: "invalid_transition", from: err.from, to: err.to }, { status: 409 });
  }
  if (err instanceof AppointmentNotReschedulableError) {
    return NextResponse.json({ error: "not_reschedulable", status: err.appointmentStatus }, { status: 409 });
  }
  if (err instanceof AppointmentNotFoundError) {
    return NextResponse.json({ error: "not_found", entity: "appointment" }, { status: 404 });
  }
  return null;
}
