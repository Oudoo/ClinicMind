import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { getConversation, patchConversation } from "@/modules/messaging/service";
import { actorOf, messagingErrorResponse, type Params } from "@/app/api/messaging/_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/conversations/[id]` → `{ conversation }` with its messages and template context; foreign ids are 404. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "conversations:read");
    const conversation = await getConversation(ctx.tenantId, id);
    if (!conversation) return notFound("conversation");
    return ok({ conversation });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `PATCH /api/conversations/[id]` { status?, assignedToId?, patientId?, leadId?, objections?, contactName? }
 * → `{ conversation }`. Confirming objections stamps `objectionsConfirmedAt` and copies them to the linked lead.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "conversations:write");
    const conversation = await patchConversation(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ conversation });
  } catch (err) {
    return messagingErrorResponse(err) ?? handleApiError(err);
  }
}
