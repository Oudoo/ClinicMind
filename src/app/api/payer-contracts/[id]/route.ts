import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { updateContract } from "@/modules/insurance/payers";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `PATCH /api/payer-contracts/[id]` (`insurance:manage`) — the contract's terms and rules, for the claims to come. → `{ payer }`. */
export async function PATCH(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:manage");
    if (!c) return unauthorized();
    return ok({ payer: await updateContract(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
