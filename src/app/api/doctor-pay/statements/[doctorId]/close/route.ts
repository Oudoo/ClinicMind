import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { closeStatement } from "@/modules/finance/doctor-pay";
import { financeErrorResponse } from "../../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ doctorId: string }> };

/** `POST /api/doctor-pay/statements/[doctorId]/close` (`tenant:manage`) `{ month }` — close a month that is over: its statement never changes again but to be marked paid. → `{ statement }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { doctorId } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const body = (await req.json().catch(() => null)) as { month?: unknown } | null;
    return ok({ statement: await closeStatement(ctx.tenantId, doctorId, typeof body?.month === "string" ? body.month : "", { id: ctx.userId, email: ctx.email, ip: clientIp(req) }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
