import { db } from "@/lib/db";

/**
 * One-off clean-up of the alerts the old rules left unread (scripts/notifications-tidy.ts):
 *  - escalation alerts for a case someone already acknowledged or resolved,
 *  - every escalation alert but the newest per person and case (one per 30-minute reminder),
 *  - "Double booking refused" alerts, which told the person who had just seen the refusal.
 * They are marked read, never deleted, so they stay listed under "All". Safe to re-run.
 */
export interface TidyResult {
  /** Unread alerts for escalations that are acknowledged or resolved. */
  settled: number;
  /** Older unread reminders for a case that still has a newer unread one for the same person. */
  collapsed: number;
  /** Unread "Double booking refused" alerts. */
  refusals: number;
}

export async function tidyNotifications(tenantId: string, opts: { apply?: boolean; now?: Date } = {}): Promise<TidyResult> {
  const now = opts.now ?? new Date();
  const alerts = await db.notification.findMany({
    where: { tenantId, kind: "ESCALATION", entity: "Escalation", entityId: { not: null }, readAt: null },
    select: { id: true, userId: true, entityId: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const caseIds = [...new Set(alerts.map((n) => n.entityId!))];
  const handled = new Set(
    (await db.escalation.findMany({ where: { tenantId, id: { in: caseIds }, status: { in: ["ACKNOWLEDGED", "RESOLVED"] } }, select: { id: true } })).map((e) => e.id),
  );

  const settled: string[] = [];
  const collapsed: string[] = [];
  const newest = new Set<string>();
  for (const n of alerts) {
    if (handled.has(n.entityId!)) {
      settled.push(n.id);
      continue;
    }
    // Newest first: the first one per person and case stays unread.
    const key = `${n.userId}:${n.entityId}`;
    if (newest.has(key)) collapsed.push(n.id);
    else newest.add(key);
  }
  const refusalWhere = { tenantId, kind: "BOOKING_CONFLICT" as const, readAt: null };
  const refusals = await db.notification.count({ where: refusalWhere });

  if (opts.apply) {
    const ids = [...settled, ...collapsed];
    await db.$transaction([
      ...(ids.length ? [db.notification.updateMany({ where: { tenantId, id: { in: ids }, readAt: null }, data: { readAt: now } })] : []),
      db.notification.updateMany({ where: refusalWhere, data: { readAt: now } }),
    ]);
  }
  return { settled: settled.length, collapsed: collapsed.length, refusals };
}
