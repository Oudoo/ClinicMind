import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getLabOrder, updateLabOrder } from "@/modules/lab/orders";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/lab-orders/[id]` (`lab:read`) — the order (its result and report for the clinicians). → `{ order }`. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "lab:read");
    if (!c) return unauthorized();
    return ok({ order: await getLabOrder(c.ctx.tenantId, id, { role: c.ctx.role }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `PATCH /api/lab-orders/[id]` (`lab:write`) `{ tests, dueOn, site?, reference?, procedureId?, note? }` — while at the lab. → `{ order }`. */
export async function PATCH(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "lab:write");
    if (!c) return unauthorized();
    return ok({ order: await updateLabOrder(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
