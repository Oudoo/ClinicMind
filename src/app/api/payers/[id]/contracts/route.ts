import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createContract } from "@/modules/insurance/payers";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/**
 * `POST /api/payers/[id]/contracts` (`insurance:manage`) `{ validFrom, validTo?, reference?, discountPct, copayPct,
 * annualLimit?, approvalAbove?, coveredByDefault, note?, rules: [{ category | priceItemId, covered, copayPct?,
 * needsApproval }] }` — a contract that overlaps no other (an open one before it ends the day before). → 201 `{ payer }`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:manage");
    if (!c) return unauthorized();
    return ok({ payer: await createContract(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
