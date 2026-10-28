import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { schedulePrice } from "@/modules/finance/prices";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/**
 * A new price from a day (owner). Body: `{ amount, effectiveFrom: YYYY-MM-DD,
 * clinicId? }`: today or later, clinic-wide or for one branch. 201 `{ item }`;
 * 422 `price_in_the_past`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "prices:manage");
    const item = await schedulePrice(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ item }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
