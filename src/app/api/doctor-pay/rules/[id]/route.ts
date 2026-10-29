import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { deletePayRule } from "@/modules/finance/doctor-pay";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `DELETE /api/doctor-pay/rules/[id]` (`tenant:manage`) — remove a rule: the doctor's rule for everything else covers the category from now on. */
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    await deletePayRule(ctx.tenantId, id, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ deleted: true });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
