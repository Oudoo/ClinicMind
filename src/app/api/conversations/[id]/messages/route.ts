import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { replyToConversation } from "@/modules/messaging/service";
import { actorOf, messagingErrorResponse, type Params } from "@/app/api/messaging/_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/conversations/[id]/messages` { body, templateKey? } → 201 `{ message, delivery, failedReason }`.
 * Stored as a HUMAN message by the acting user and delivered through `sendPatientMessage`
 * (LOGGED when no channel is connected).
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "conversations:write");
    const result = await replyToConversation(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok(result, { status: 201 });
  } catch (err) {
    return messagingErrorResponse(err) ?? handleApiError(err);
  }
}
