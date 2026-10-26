import { getActingContext } from "@/lib/auth/session";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createTestNotification } from "@/modules/notifications/service";
import { notificationErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/notifications/test` → 201 with what was done: a SYSTEM
 * notification "This is how notifications reach you" for the caller, and the
 * e-mail when the caller has e-mail on for SYSTEM
 * (`{ notificationId, inAppEnabled, emailEnabled, emailed, to, browser }`).
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx?.userId) return unauthorized();
    const result = await createTestNotification(ctx.tenantId, ctx.userId, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok(result, { status: 201 });
  } catch (err) {
    return notificationErrorResponse(err) ?? handleApiError(err);
  }
}
