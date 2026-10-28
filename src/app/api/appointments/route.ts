import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import {
  AppointmentListQuery,
  createAppointment,
  listAppointments,
} from "@/modules/appointments/service";
import { appointmentErrorResponse } from "./_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/appointments?from&to&doctorId&status&kind&patientId` → `{ appointments }` (each with `notesCount`). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    const filter = AppointmentListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    return ok({ appointments: await listAppointments(ctx.tenantId, filter) });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * Book an appointment (`kind`, `room`, `reason`, `notes` optional). 201
 * `{ appointment, conflicts }`; 409 `{ error: "conflict", conflicts }` when the
 * doctor or the room is taken unless the body sets `allowWaitlist`; 409
 * `{ error: "patient_conflict", conflicts }` when the patient already holds an
 * overlapping live booking unless the body sets `allowPatientOverlap`. The
 * database's exclusion constraints back the check; a violation is answered the
 * same way. 422 `{ error: "in_the_past" | "outside_hours", message, overridable }`
 * for a start more than 15 minutes ago or a slot outside the opening hours,
 * unless an owner (users:manage) sets `allowPast` / `allowOutsideHours` (audited).
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:write");
    const result = await createAppointment(ctx.tenantId, await req.json(), {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
      role: ctx.role,
    });
    return ok(result, { status: 201 });
  } catch (err) {
    return appointmentErrorResponse(err) ?? handleApiError(err);
  }
}
