import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { voidExpense } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../_lib/context";

export const dynamic = "force-dynamic";

/**
 * `POST /api/expenses/[id]/void` (`tenant:manage`) `{ reason }` — void an expense entered by mistake, its payments with it
 * (409 when cash it paid out of a drawer is on a day signed off). → `{ expense }`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "tenant:manage");
    if (!c) return unauthorized();
    return ok({ expense: await voidExpense(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
