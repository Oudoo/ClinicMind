import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { updateTemplate } from "@/modules/messaging/templates";
import { actorOf, messagingErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/** `PATCH /api/messaging/templates/[id]` { name?, language?, body?, category?, channel?, active? } → `{ template }` (tenant:manage). */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const template = await updateTemplate(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ template });
  } catch (err) {
    return messagingErrorResponse(err) ?? handleApiError(err);
  }
}
