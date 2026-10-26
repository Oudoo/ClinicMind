import { getActingContext } from "@/lib/auth/session";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getAttentionSummary } from "@/modules/notifications/attention";
import { NO_STORE } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/notifications/attention` → the "Needs attention now" summary the
 * overview card shows: `{ items: [{ key, count, label, detail, href, tone }],
 * total, timezone, generatedAt }`, scoped by the caller's role (a doctor sees
 * their own escalations and drafts, the desk its queue).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    return ok(await getAttentionSummary(ctx.tenantId, ctx.userId, ctx.role), NO_STORE);
  } catch (err) {
    return handleApiError(err);
  }
}
