import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { myShift, openShift } from "@/modules/finance/cash";
import { financeErrorResponse } from "../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/cash/shift` → `{ shift }`: the caller's open shift, or null. For whoever takes payments. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    return ok({ shift: ctx.userId ? await myShift(ctx.tenantId, ctx.userId) : null });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/cash/shift` `{ openingFloat, clinicId? }` — open the caller's
 * shift with the cash in the drawer (at the first branch unless one is
 * given). 409 `shift_open` when one is open, `day_closed` when today is
 * signed off. → `{ shift }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    if (!ctx.userId) return unauthorized();
    const shift = await openShift(ctx.tenantId, ctx.userId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ shift }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
