import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { withdrawScheduledPrice } from "@/modules/finance/prices";
import { financeErrorResponse } from "../../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/** Withdraw a price change that has not taken effect yet (owner). 409 `price_in_force` once it has. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; priceId: string }> }) {
  try {
    const { id, priceId } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "prices:manage");
    const item = await withdrawScheduledPrice(ctx.tenantId, id, priceId, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ item });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
