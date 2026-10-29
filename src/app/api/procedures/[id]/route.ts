import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { getProcedure, updateProcedure } from "@/modules/finance/procedures";
import { financeErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/procedures/[id]` → `{ procedure }` with its payments and balance; a foreign tenant's id is a 404. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    const procedure = await getProcedure(ctx.tenantId, id);
    if (!procedure) return notFound("procedure");
    return ok({ procedure });
  } catch (err) {
    return handleApiError(err);
  }
}

/** `PATCH /api/procedures/[id]` — edit a PLANNED procedure (409 `invalid_state` once signed or cancelled). */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");
    const procedure = await updateProcedure(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req), role: ctx.role });
    return ok({ procedure });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
