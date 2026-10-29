import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { discountLimitOf, discountLimits, setDiscountLimits } from "@/modules/finance/discounts";
import { financeErrorResponse } from "../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/finance/settings` → `{ discountLimits, myDiscountLimit }`: the limits by role, and the caller's own. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    const [limits, mine] = await Promise.all([discountLimits(ctx.tenantId), discountLimitOf(ctx.tenantId, ctx.role)]);
    return ok({ discountLimits: limits, myDiscountLimit: mine });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `PUT /api/finance/settings` `{ discountLimits: { RECEPTIONIST, NURSE, DOCTOR } }` (whole percentages) — the owner's. */
export async function PUT(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const body = (await req.json().catch(() => null)) as { discountLimits?: unknown } | null;
    const limits = await setDiscountLimits(ctx.tenantId, body?.discountLimits, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ discountLimits: limits });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
