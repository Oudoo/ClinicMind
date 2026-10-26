import { getActingContext } from "@/lib/auth/session";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listNotifications, NotificationListQuery, toNotificationDTO, unreadCount } from "@/modules/notifications/service";
import { NO_STORE } from "./_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/notifications?unread=1&since=<iso>&before=<iso>&kind=<KIND>&take=<n>`
 * → `{ notifications, unread, now }` for the signed-in user only. `unread` is
 * the user's total unread count regardless of the filters, so one call feeds
 * both the badge and the list; `since` makes it a cheap poll, `before` pages
 * backwards ("load more"). Any role; never another user's rows.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx?.userId) return unauthorized();
    const q = NotificationListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    const [rows, unread] = await Promise.all([
      listNotifications(ctx.tenantId, ctx.userId, {
        unreadOnly: q.unread,
        since: q.since,
        before: q.before,
        kind: q.kind,
        take: q.take,
      }),
      unreadCount(ctx.tenantId, ctx.userId),
    ]);
    return ok({ notifications: rows.map(toNotificationDTO), unread, now: new Date().toISOString() }, NO_STORE);
  } catch (err) {
    return handleApiError(err);
  }
}
