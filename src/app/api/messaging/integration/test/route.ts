import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { sendTestMessage } from "@/modules/messaging/integrations";
import { actorOf } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/messaging/integration/test` { patientId, body? } → 201 `{ conversationId, messageId, delivery, failedReason, externalId }`:
 * sends through whatever is connected and reports the delivery result (tenant:manage).
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const result = await sendTestMessage(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req));
    return ok(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
