import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { cancelApproval } from "@/modules/insurance/covers";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `POST /api/approvals/[id]/cancel` (`insurance:write`) `{ reason }` — one no claim uses. → `{ insurance }`. */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:write");
    if (!c) return unauthorized();
    return ok({ insurance: await cancelApproval(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
