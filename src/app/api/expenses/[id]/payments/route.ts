import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { payExpense } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../_lib/context";

export const dynamic = "force-dynamic";

/**
 * `POST /api/expenses/[id]/payments` (`expenses:write`) `{ amount, method, paidOn?, fromDrawer?, reference?, note? }` — pay
 * towards an expense, never past what is owed; cash out of the drawer is today's, from the payer's open shift. → 201 `{ expense }`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "expenses:write");
    if (!c) return unauthorized();
    return ok({ expense: await payExpense(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
