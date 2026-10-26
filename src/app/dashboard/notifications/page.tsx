import type { NotificationKind } from "@prisma/client";
import { getActingContext } from "@/lib/auth/session";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { NotificationList, type ListFilter } from "@/components/clinicmind/notification-list";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listNotifications, NOTIFICATION_KINDS, toNotificationDTO, unreadCount } from "@/modules/notifications/service";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Every notification of the signed-in user: unread first, by day, with filters by kind. */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  const filter: ListFilter = first(sp.filter) === "all" ? "all" : "unread";
  const rawKind = first(sp.kind);
  const kind = rawKind && (NOTIFICATION_KINDS as readonly string[]).includes(rawKind) ? (rawKind as NotificationKind) : null;

  if (!ctx.userId) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Notifications" description="Everything the clinic wanted you to know, newest first." />
        <Card>
          <p className="text-sm text-muted-foreground">Notifications are not available for this session.</p>
        </Card>
      </div>
    );
  }

  const [rows, unread, timezone] = await Promise.all([
    listNotifications(ctx.tenantId, ctx.userId, { unreadOnly: filter === "unread", kind: kind ?? undefined, take: PAGE_SIZE }),
    unreadCount(ctx.tenantId, ctx.userId),
    getTenantTimezone(ctx.tenantId),
  ]);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Notifications"
        description="Everything the clinic wanted you to know, newest first. Open one to go where it points; e-mail and browser copies follow your preferences in Settings."
        action={<Badge tone={unread ? "accent" : "default"}>{unread} unread</Badge>}
      />
      <NotificationList
        key={`${filter}:${kind ?? ""}`}
        initial={rows.map(toNotificationDTO)}
        filter={filter}
        kind={kind}
        take={PAGE_SIZE}
        timezone={timezone}
        unread={unread}
      />
    </div>
  );
}
