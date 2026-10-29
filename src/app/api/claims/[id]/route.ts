import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getClaim } from "@/modules/insurance/batches";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/claims/[id]` (`insurance:read`) — a claim with its lines and the payer's answers. → `{ claim }`. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "insurance:read");
    if (!c) return unauthorized();
    return ok({ claim: await getClaim(c.ctx.tenantId, id) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
