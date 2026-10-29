import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { markStatementPaid } from "@/modules/finance/doctor-pay";
import { financeErrorResponse } from "../../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ doctorId: string }> };

/** `POST /api/doctor-pay/statements/[doctorId]/paid` (`tenant:manage`) `{ month, method?, reference?, paidOn? }` — the clinic paid a closed statement. → `{ statement }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { doctorId } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const body = ((await req.json().catch(() => null)) ?? {}) as { month?: unknown };
    const { month, ...rest } = body;
    return ok({ statement: await markStatementPaid(ctx.tenantId, doctorId, typeof month === "string" ? month : "", rest, { id: ctx.userId, email: ctx.email, ip: clientIp(req) }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
