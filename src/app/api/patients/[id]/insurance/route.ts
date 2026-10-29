import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { can } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { addCover, patientInsurance } from "@/modules/insurance/covers";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/patients/[id]/insurance` (`patients:read`) — the patient's covers and approvals, and (`insurance:read`) claims. → `{ insurance }`. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "patients:read");
    if (!c) return unauthorized();
    return ok({ insurance: await patientInsurance(c.ctx.tenantId, id, { claims: can(c.ctx.role, "insurance:read") }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `POST /api/patients/[id]/insurance` (`insurance:write`) `{ payerId, memberNumber, plan?, employer?, relation?, validFrom, validTo?, note? }` — a cover. → 201 `{ insurance }`. */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:write");
    if (!c) return unauthorized();
    return ok({ insurance: await addCover(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
