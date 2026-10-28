import { getActingContext } from "@/lib/auth/session";
import { assertCan, assertCanSignClinical, canSignClinical } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { signProcedure } from "@/modules/finance/procedures";
import { financeErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/procedures/[id]/sign` — a clinician signs a planned procedure
 * (`consultations:sign`). It becomes revenue, lands on the timeline and the
 * patient is enrolled in the treatment's concierge protocol.
 * → `{ procedure, enrolment }`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanSignClinical(ctx);
    const result = await signProcedure(ctx.tenantId, id, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok(result);
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
