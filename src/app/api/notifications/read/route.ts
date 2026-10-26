import { getActingContext } from "@/lib/auth/session";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { markRead, MarkReadInput, unreadCount } from "@/modules/notifications/service";
import { NO_STORE } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/notifications/read` with `{ ids: [...] }` or `{ all: true }` →
 * `{ updated, unread }`. Only the caller's own rows can change; ids of other
 * users (or tenants) are silently ignored.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx?.userId) return unauthorized();
    const body = MarkReadInput.parse(await req.json().catch(() => ({})));
    const updated = await markRead(ctx.tenantId, ctx.userId, "ids" in body ? body.ids : "all", {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok({ updated, unread: await unreadCount(ctx.tenantId, ctx.userId) }, NO_STORE);
  } catch (err) {
    return handleApiError(err);
  }
}
