import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { cancelProcedure } from "@/modules/finance/procedures";
import { financeErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/procedures/[id]/cancel` `{ reason }` — cancel a procedure. A
 * planned one needs `patients:write`; a signed one additionally needs a
 * clinician (`consultations:sign`), otherwise 409 `invalid_state`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");
    const procedure = await cancelProcedure(
      ctx.tenantId,
      id,
      await req.json().catch(() => null),
      { id: ctx.userId, email: ctx.email, ip: clientIp(req) },
      { allowSigned: can(ctx.role, "consultations:sign") },
    );
    return ok({ procedure });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
