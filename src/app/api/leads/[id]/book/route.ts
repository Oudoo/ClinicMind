import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { bookConsultation } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/leads/[id]/book` { doctorId, startsAt, endsAt, room?, reason?, allowWaitlist? }
 * → 201 `{ lead, appointment }`. Books through the appointments service (409
 * `conflict` with the slots in the way) and moves the lead to CONSULTATION_BOOKED.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    assertCan(ctx.role, "appointments:write");
    const result = await bookConsultation(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok(result, { status: 201 });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}
