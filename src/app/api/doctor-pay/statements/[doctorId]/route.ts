import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { statementFor } from "@/modules/finance/doctor-pay";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ doctorId: string }> };

/** `GET /api/doctor-pay/statements/[doctorId]?month=YYYY-MM` (`finance:read`, or the doctor's own) → `{ statement }`. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { doctorId } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    if (ctx.userId !== doctorId) assertCan(ctx.role, "finance:read");
    return ok({ statement: await statementFor(ctx.tenantId, doctorId, new URL(req.url).searchParams.get("month") ?? "") });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
