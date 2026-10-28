"use client";

import type { NotificationLevel } from "@prisma/client";
import { AlertTriangle, Info, Mail, OctagonAlert } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { addDays, dateKeyInTz, formatDateInTz, formatDateTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { KIND_LABELS, relativeTime, type NotificationDTO } from "@/modules/notifications/kinds";

/**
 * Pieces shared by the bell dropdown and the notifications page: level
 * colours, the compact notification body and the cross-component events that
 * keep the badge, the list and the preferences form in step without a store.
 */

/** Fired after a mutation (mark read, test notification) so other surfaces refetch. */
export const NOTIFICATIONS_CHANGED_EVENT = "clinicmind:notifications";
/** Fired after preferences are saved; detail: `{ browser: boolean }`. */
export const PREFERENCES_CHANGED_EVENT = "clinicmind:notification-preferences";

export type ChangeSource = "bell" | "list" | "preferences";

export function emitNotificationsChanged(source: ChangeSource): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail: { source } }));
}

export function emitPreferencesChanged(detail: { browser: boolean }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED_EVENT, { detail }));
}

export const LEVEL_TONE: Record<NotificationLevel, "accent" | "warning" | "danger"> = {
  INFO: "accent",
  WARNING: "warning",
  CRITICAL: "danger",
};

export const LEVEL_TEXT: Record<NotificationLevel, string> = {
  INFO: "text-accent",
  WARNING: "text-warning",
  CRITICAL: "text-danger",
};

export const LEVEL_LABEL: Record<NotificationLevel, string> = {
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical",
};

export function LevelIcon({ level, className }: { level: NotificationLevel; className?: string }) {
  const Icon = level === "CRITICAL" ? OctagonAlert : level === "WARNING" ? AlertTriangle : Info;
  return <Icon className={cn("h-4 w-4 shrink-0", LEVEL_TEXT[level], className)} aria-hidden="true" />;
}

export function LevelBadge({ level }: { level: NotificationLevel }) {
  return <Badge tone={LEVEL_TONE[level]}>{LEVEL_LABEL[level]}</Badge>;
}

/**
 * Icon, kind label, title, first body line and relative time. `compact` is the
 * dropdown (one body line); the page shows up to five lines.
 */
export function NotificationBody({
  n,
  now,
  compact = false,
  timezone,
}: {
  n: NotificationDTO;
  now: Date;
  compact?: boolean;
  timezone?: string;
}) {
  const unread = !n.readAt;
  const created = new Date(n.createdAt);
  return (
    <>
      <LevelIcon level={n.level} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="data-label truncate">{KIND_LABELS[n.kind]}</span>
          {!compact && n.level !== "INFO" ? <LevelBadge level={n.level} /> : null}
          {!compact && n.emailedAt ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title="A copy went to your e-mail">
              <Mail className="h-3 w-3" aria-hidden="true" /> e-mailed
            </span>
          ) : null}
        </div>
        <p className={cn("mt-0.5 text-sm leading-snug", unread ? "font-medium" : "text-foreground/90", compact && "line-clamp-2")}>{n.title}</p>
        {n.body ? (
          <p className={cn("mt-0.5 whitespace-pre-line text-xs text-muted-foreground", compact ? "line-clamp-1" : "line-clamp-5")}>{n.body}</p>
        ) : null}
        <p className="mt-1 font-mono text-[10px] text-muted-foreground" title={timezone ? formatDateTimeInTz(created, timezone) : created.toLocaleString()}>
          {relativeTime(created, now)}
        </p>
      </div>
      <span
        aria-label={unread ? "Unread" : undefined}
        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", unread ? "bg-accent" : "bg-transparent")}
      />
    </>
  );
}

export interface DayGroup {
  key: string;
  label: string;
  items: NotificationDTO[];
}

/** Group a newest-first list by clinic day: "Today", "Yesterday", then "Mon 20 Oct". */
export function groupByDay(items: readonly NotificationDTO[], timezone: string, now: Date): DayGroup[] {
  const todayKey = dateKeyInTz(now, timezone);
  // A calendar day back, not 24 hours (daylight saving makes some days 23 or 25 hours long).
  const yesterdayKey = dateKeyInTz(addDays(now, -1, timezone), timezone);
  const groups: DayGroup[] = [];
  for (const n of items) {
    const date = new Date(n.createdAt);
    const key = dateKeyInTz(date, timezone);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const label =
        key === todayKey
          ? "Today"
          : key === yesterdayKey
            ? "Yesterday"
            : formatDateInTz(date, timezone, { weekday: "short", day: "2-digit", month: "short" });
      group = { key, label, items: [] };
      groups.push(group);
    }
    group.items.push(n);
  }
  return groups;
}
