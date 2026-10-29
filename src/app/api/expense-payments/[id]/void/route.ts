import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { voidExpensePayment } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/**
 * `POST /api/expense-payments/[id]/void` (`tenant:manage`) `{ reason }` — void a payment entered by mistake: what it paid is
 * owed again (409 when it is a drawer's cash on a day signed off). → `{ expense }`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "tenant:manage");
    if (!c) return unauthorized();
    return ok({ expense: await voidExpensePayment(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
