import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getBatch } from "@/modules/insurance/batches";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/claim-batches/[id]` (`insurance:read`) — the batch with its claims and the payer's answers to it. → `{ batch }`. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "insurance:read");
    if (!c) return unauthorized();
    return ok({ batch: await getBatch(c.ctx.tenantId, id) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
