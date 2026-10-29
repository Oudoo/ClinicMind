import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { updateRecurring } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/**
 * `PATCH /api/recurring-expenses/[id]` (`tenant:manage`) `{ category, description, amount, dueDays?, supplierId? | supplierName?, note? }`
 * — what its bills are from now on (those made stay). 409 once stopped. → `{ recurring }`.
 */
export async function PATCH(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "tenant:manage");
    if (!c) return unauthorized();
    return ok({ recurring: await updateRecurring(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
