import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createExpense, expenseKpis, listExpenses } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { boundedJson, expenseContext } from "./_lib/context";

export const dynamic = "force-dynamic";

/**
 * `GET /api/expenses` (`expenses:read`) `?view=due|month|voided&month=YYYY-MM&category=&supplierId=&q=&page=`
 * — what is still to pay (soonest due first), a month's expenses, or the voided ones, with the page's figures.
 * Salaries only for the owner. → `{ list, kpis }`.
 */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "expenses:read");
    if (!c) return unauthorized();
    const query = Object.fromEntries(new URL(req.url).searchParams);
    const [list, kpis] = await Promise.all([listExpenses(c.ctx.tenantId, query, { role: c.ctx.role }), expenseKpis(c.ctx.tenantId, { role: c.ctx.role })]);
    return ok({ list, kpis });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/expenses` (`expenses:write`) `{ category, description, amount, billedOn?, dueOn?, supplierId? | supplierName?,
 * clinicId?, reference?, note?, paid?: { method, fromDrawer, reference? }, files? }` — a bill to pay later, or money
 * spent now (paid in full; cash at the desk today out of the cashier's drawer). Salaries: the owner only. → 201 `{ expense }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "expenses:write");
    if (!c) return unauthorized();
    const read = await boundedJson(req);
    if ("response" in read) return read.response;
    return ok({ expense: await createExpense(c.ctx.tenantId, read.body, c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
