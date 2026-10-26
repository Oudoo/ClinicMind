import type { NotificationKind, NotificationLevel } from "@prisma/client";

/**
 * Notification vocabulary shared by the server (service, jobs, seed) and the
 * browser (bell, list, preferences form). This file imports nothing that
 * touches the database so client components can use it; service.ts re-exports
 * the constants so the module contract `KIND_LABELS` / `NOTIFICATION_KINDS` /
 * `EMAIL_DEFAULT_ON` from "@/modules/notifications/service" keeps working.
 */

export const NOTIFICATION_KINDS = [
  "BOOKING_CREATED",
  "BOOKING_CANCELLED",
  "BOOKING_CONFLICT",
  "NO_SHOW",
  "REVIEW_PENDING",
  "ESCALATION",
  "FOLLOW_UP_OVERDUE",
  "INTAKE_SUBMITTED",
  "LEAD_NEW",
  "MESSAGE_INBOUND",
  "CHECK_IN_ANSWERED",
  "PAYMENT_RECORDED",
  "ALERT_RULE",
  "WEEKLY_BRIEF",
  "SYSTEM",
] as const satisfies readonly NotificationKind[];

export const NOTIFICATION_LEVELS = ["INFO", "WARNING", "CRITICAL"] as const satisfies readonly NotificationLevel[];

export const KIND_LABELS: Record<NotificationKind, string> = {
  BOOKING_CREATED: "New booking",
  BOOKING_CANCELLED: "Cancellation",
  BOOKING_CONFLICT: "Double booking refused",
  NO_SHOW: "No-show",
  REVIEW_PENDING: "Consultation awaiting signature",
  ESCALATION: "Escalation (patient at risk)",
  FOLLOW_UP_OVERDUE: "Follow-up overdue",
  INTAKE_SUBMITTED: "Onboarding form submitted",
  LEAD_NEW: "New lead",
  MESSAGE_INBOUND: "New message from a patient",
  CHECK_IN_ANSWERED: "Check-in answered",
  PAYMENT_RECORDED: "Payment recorded",
  ALERT_RULE: "Metric alert",
  WEEKLY_BRIEF: "Weekly brief",
  SYSTEM: "System",
};

/** One line under each kind in the preferences matrix: what triggers it. */
export const KIND_HINTS: Record<NotificationKind, string> = {
  BOOKING_CREATED: "An appointment is booked by the desk, the website or the AI receptionist.",
  BOOKING_CANCELLED: "A patient or the desk cancels an appointment.",
  BOOKING_CONFLICT: "A booking was refused because the slot or the room was taken.",
  NO_SHOW: "A patient is marked as a no-show.",
  REVIEW_PENDING: "A consultation draft has waited more than 24 hours for your signature.",
  ESCALATION: "A concierge check-in or a lead follow-up needs a human now.",
  FOLLOW_UP_OVERDUE: "A lead follow-up passed its due time without being done.",
  INTAKE_SUBMITTED: "A patient submitted the onboarding form.",
  LEAD_NEW: "A new lead arrived from a campaign, a call or a message.",
  MESSAGE_INBOUND: "A patient wrote to the clinic inbox.",
  CHECK_IN_ANSWERED: "A patient answered a post-procedure check-in.",
  PAYMENT_RECORDED: "A deposit, payment or refund was recorded.",
  ALERT_RULE: "A metric crossed one of the thresholds in Reports.",
  WEEKLY_BRIEF: "The Monday summary of the week behind and ahead.",
  SYSTEM: "Account, digest and test notifications.",
};

/** Kinds that go to e-mail unless the recipient switched them off. */
export const EMAIL_DEFAULT_ON: readonly NotificationKind[] = ["ESCALATION", "ALERT_RULE"];

/** The shape of a notification once it crossed the API (dates as ISO strings). */
export interface NotificationDTO {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  body: string | null;
  href: string | null;
  entity: string | null;
  entityId: string | null;
  readAt: string | null;
  emailedAt: string | null;
  createdAt: string;
}

export interface NotificationRowLike {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  body: string | null;
  href: string | null;
  entity: string | null;
  entityId: string | null;
  readAt: Date | null;
  emailedAt: Date | null;
  createdAt: Date;
}

export function toNotificationDTO(row: NotificationRowLike): NotificationDTO {
  return {
    id: row.id,
    kind: row.kind,
    level: row.level,
    title: row.title,
    body: row.body,
    href: row.href,
    entity: row.entity,
    entityId: row.entityId,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    emailedAt: row.emailedAt ? row.emailedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Only dashboard-internal paths are followed from a notification (never an external URL). */
export function safeNotificationHref(href: string | null | undefined): string | null {
  if (!href || href.length > 512) return null;
  if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/\\")) return null;
  if (/[\r\n]/.test(href)) return null;
  return href;
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "5 d ago" or a short date. */
export function relativeTime(iso: string | Date, now: Date = new Date()): string {
  const then = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = now.getTime() - then.getTime();
  if (!Number.isFinite(diffMs)) return "";
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} d ago`;
  if (days < 30) return `${Math.round(days / 7)} wk ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(then);
}
