import { NextResponse } from "next/server";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getAppointment, rescheduleAppointment } from "@/modules/appointments/service";
import { appointmentErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/appointments/[id]` → `{ appointment }`; a foreign tenant's id is a 404. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    const appointment = await getAppointment(ctx.tenantId, id);
    if (!appointment) {
      return NextResponse.json({ error: "not_found", entity: "appointment" }, { status: 404 });
    }
    return ok({ appointment });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `PATCH /api/appointments/[id]` — reschedule (startsAt/endsAt, doctorId, room)
 * and/or edit reason/notes. 409 `conflict` when the new slot is taken unless
 * `allowWaitlist` is set; 409 `not_reschedulable` once the visit has started.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:write");
    const result = await rescheduleAppointment(ctx.tenantId, id, await req.json(), {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok(result);
  } catch (err) {
    return appointmentErrorResponse(err) ?? handleApiError(err);
  }
}
