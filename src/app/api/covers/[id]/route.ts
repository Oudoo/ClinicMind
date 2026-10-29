import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { updateCover } from "@/modules/insurance/covers";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `PATCH /api/covers/[id]` (`insurance:write`) `{ memberNumber, plan?, employer?, relation, validFrom, validTo?, note? }` — its days keep its claims' work. → `{ insurance }`. */
export async function PATCH(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:write");
    if (!c) return unauthorized();
    return ok({ insurance: await updateCover(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
