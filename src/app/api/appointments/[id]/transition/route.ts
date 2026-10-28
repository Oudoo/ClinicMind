import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { transitionAppointment } from "@/modules/appointments/service";
import { appointmentErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/appointments/[id]/transition` body `{ status, reason? }`.
 * 409 `invalid_transition` for a move the state machine forbids, 409 `conflict`
 * when a waitlisted booking cannot be promoted because its slot is still taken,
 * 409 `too_early` for a no-show or a completion before the start time, 409
 * `not_today` for a check-in on another day than the appointment's (or more
 * than two hours after it ended) or a consultation started on a future day,
 * 422 `in_the_past` for promoting a waitlisted slot that has passed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:write");
    const appointment = await transitionAppointment(ctx.tenantId, id, await req.json(), {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
      role: ctx.role,
    });
    return ok({ appointment });
  } catch (err) {
    return appointmentErrorResponse(err) ?? handleApiError(err);
  }
}
