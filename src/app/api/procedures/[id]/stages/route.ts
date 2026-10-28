import { getActingContext } from "@/lib/auth/session";
import { assertCanSignClinical } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { completeStage } from "@/modules/finance/procedures";
import { financeErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/procedures/[id]/stages` `{ performedAt, doctorId?, appointmentId? }`
 * — a clinician (`consultations:sign`) marks the next session of started work
 * done: it is charged its share on that day. The last session signs the
 * procedure. → `{ procedure, stage, of, amount, enrolment }`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanSignClinical(ctx);
    const result = await completeStage(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok(result);
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
