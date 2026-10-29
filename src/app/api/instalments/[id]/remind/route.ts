import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { remindNow } from "@/modules/finance/instalments";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/instalments/[id]/remind` (`payments:write`) — send the patient the reminder of the next
 * instalment owed now, on WhatsApp in their language (the overdue wording when its day has passed).
 * 409 when the patient said no to reminders, has no number, or nothing is owed. → `{ delivery, conversationId }`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    return ok(await remindNow(ctx.tenantId, id, { id: ctx.userId, email: ctx.email, ip: clientIp(req) }));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}
