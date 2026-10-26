import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { markConversationRead } from "@/modules/messaging/service";
import { actorOf, type Params } from "@/app/api/messaging/_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/conversations/[id]/read` → `{ marked }`: stamps `readAt` on the thread's unread inbound messages. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "conversations:read");
    return ok(await markConversationRead(ctx.tenantId, id, actorOf(ctx, req)));
  } catch (err) {
    return handleApiError(err);
  }
}
