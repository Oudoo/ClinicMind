import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { approvalOptions, requestApproval } from "@/modules/insurance/covers";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/patients/[id]/approvals` (`insurance:write`) — the work an approval may be asked for. → `{ procedures }`. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "insurance:write");
    if (!c) return unauthorized();
    return ok({ procedures: await approvalOptions(c.ctx.tenantId, id) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `POST /api/patients/[id]/approvals` (`insurance:write`) `{ coverageId, procedureId?, description, amount, requestedOn?, note? }`. → 201 `{ insurance }`. */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:write");
    if (!c) return unauthorized();
    return ok({ insurance: await requestApproval(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
