import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { ConversationListQuery, listConversations } from "@/modules/messaging/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/conversations?status=open|waiting_clinic|waiting_patient|closed|all&channel&mine=1&q&page&pageSize`
 * → `{ conversations, total, page, pageSize, counts }` (conversations:read).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "conversations:read");
    const filter = ConversationListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    return ok(await listConversations(ctx.tenantId, filter, ctx.userId));
  } catch (err) {
    return handleApiError(err);
  }
}
