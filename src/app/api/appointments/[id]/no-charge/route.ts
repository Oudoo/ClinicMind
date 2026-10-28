import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { chargeVisitNothing } from "@/modules/finance/unbilled";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/appointments/[id]/no-charge` `{ reason }` — a visit that took
 * place and is free on purpose is charged nothing, with the reason
 * (`payments:write`). 409 `not_done` before the visit is completed,
 * `already_billed` when it has a procedure, fee or charge. → `{ charge }`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const result = await chargeVisitNothing(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok(result, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
