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
 * when a waitlisted booking cannot be promoted because its slot is still taken.
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
    });
    return ok({ appointment });
  } catch (err) {
    return appointmentErrorResponse(err) ?? handleApiError(err);
  }
}
