import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { billLabOrder } from "@/modules/lab/orders";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/**
 * `POST /api/lab-orders/[id]/bill` (`expenses:write`) `{ amount, reference?, billedOn?, dueOn?, paid?: { method, fromDrawer, reference? } }`
 * — the lab's bill: an expense under Lab fees, and a cost on the order's procedure. 409 when billed already. → 201 `{ order }`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "expenses:write");
    if (!c) return unauthorized();
    return ok({ order: await billLabOrder(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
