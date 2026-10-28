import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { startProcedure } from "@/modules/finance/procedures";
import { financeErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/procedures/[id]/start` `{ startedAt: "YYYY-MM-DD" }` — start
 * work done in stages (the sessions of a course), on the day it started
 * (`patients:write`). Nothing is charged yet: each session is, as it is done.
 * 409 `not_staged` for work done at once (sign it instead). → `{ procedure }`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");
    const procedure = await startProcedure(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ procedure });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
