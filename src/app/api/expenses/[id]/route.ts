import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getExpense, updateExpense } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/expenses/[id]` (`expenses:read`) — the expense with its payments and files. → `{ expense }`. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "expenses:read");
    if (!c) return unauthorized();
    return ok({ expense: await getExpense(c.ctx.tenantId, id, { role: c.ctx.role }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `PATCH /api/expenses/[id]` (`expenses:write`) `{ category, description, amount, billedOn, dueOn?, supplierId? | supplierName?,
 * reference?, note? }` — correct an expense (its amount never below what is paid). 409 once voided. → `{ expense }`.
 */
export async function PATCH(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "expenses:write");
    if (!c) return unauthorized();
    return ok({ expense: await updateExpense(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
