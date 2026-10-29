import { handleApiError, ok, unauthorized } from "@/lib/api";
import { insuranceKpis, owedByPayer } from "@/modules/insurance/payers";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/insurance` (`insurance:read`) — what payers owe by age, what is to send and the approvals waiting. → `{ kpis, aging }`. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "insurance:read");
    if (!c) return unauthorized();
    const [kpis, aging] = await Promise.all([insuranceKpis(c.ctx.tenantId), owedByPayer(c.ctx.tenantId)]);
    return ok({ kpis, aging });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
