import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createFollowUp, listLeadFollowUps } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/leads/[id]/follow-ups` → `{ followUps }` (open first, then done). */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:read");
    return ok({ followUps: await listLeadFollowUps(ctx.tenantId, id) });
  } catch (err) {
    return handleApiError(err);
  }
}

/** `POST /api/leads/[id]/follow-ups` { dueAt, note?, channel?, ownerId? } → 201 `{ followUp }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const followUp = await createFollowUp(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ followUp }, { status: 201 });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}
