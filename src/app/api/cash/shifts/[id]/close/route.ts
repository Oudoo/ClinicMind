import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { closeShift } from "@/modules/finance/cash";
import { financeErrorResponse } from "../../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/cash/shifts/[id]/close` `{ counts: [{ method, counted, reason? }], note? }`
 * — close a shift with what was counted per method; any difference needs
 * its reason (422). The cashier closes their own, the owner anyone's.
 * → `{ shift }`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    if (!ctx.userId) return unauthorized();
    const shift = await closeShift(ctx.tenantId, id, { userId: ctx.userId, isOwner: can(ctx.role, "tenant:manage") }, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ shift });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
