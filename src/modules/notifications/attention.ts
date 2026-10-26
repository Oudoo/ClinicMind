import type { Prisma, UserRole } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { dateKeyInTz, endOfDayInTz, formatDateInTz, formatDateTimeInTz, formatTimeInTz, isSameDayInTz, startOfDayInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";

/**
 * "Needs attention now": the handful of counts a person should act on before
 * anything else, with a link each. Rendered by the overview card and returned
 * by GET /api/notifications/attention. Role-aware: an owner sees the clinic,
 * a doctor their own escalations and drafts, the desk the queue it works.
 */
export type AttentionKey = "escalations" | "followUps" | "reviewPending" | "noShows" | "intake" | "unread";
export type AttentionTone = "default" | "warning" | "danger";

export interface AttentionItem {
  key: AttentionKey;
  count: number;
  /** e.g. "2 open escalations" */
  label: string;
  /** One line of explanation, e.g. "1 not yet acknowledged · oldest target 14:30" */
  detail: string;
  href: string;
  tone: AttentionTone;
  /** Set for escalations: the oldest target time and whether it already passed. */
  due?: { at: string; overdue: boolean };
}

export interface AttentionSummary {
  items: AttentionItem[];
  /** Sum of the counts shown. 0 means "Nothing waiting". */
  total: number;
  timezone: string;
  generatedAt: string;
}

export const REVIEW_PENDING_AFTER_HOURS = 24;

const ALL_KEYS: readonly AttentionKey[] = ["escalations", "followUps", "reviewPending", "noShows", "intake", "unread"];

const SCOPES: Record<UserRole, readonly AttentionKey[]> = {
  SUPER_ADMIN: ALL_KEYS,
  CLINIC_OWNER: ALL_KEYS,
  // Clinicians: what blocks their own patients and their own signatures.
  DOCTOR: ["escalations", "reviewPending", "unread"],
  NURSE: ["escalations", "followUps", "intake", "unread"],
  // The desk works the follow-up queue, rebooks no-shows and accepts onboarding forms.
  RECEPTIONIST: ["followUps", "noShows", "intake", "unread"],
  ASSISTANT: ["unread"],
};

/** Which lines a role sees, in display order. */
export function attentionKeysFor(role: UserRole): readonly AttentionKey[] {
  return SCOPES[role] ?? ["unread"];
}

/** Roles whose escalation and draft counts are limited to rows assigned to them. */
export function attentionIsPersonal(role: UserRole): boolean {
  return role === "DOCTOR";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function getAttentionSummary(
  tenantId: string,
  userId: string | null,
  role: UserRole,
  now: Date = new Date(),
): Promise<AttentionSummary> {
  const keys = attentionKeysFor(role);
  const personal = attentionIsPersonal(role);
  const timezone = await getTenantTimezone(tenantId);
  const dayStart = startOfDayInTz(now, timezone);
  const dayEnd = endOfDayInTz(now, timezone);
  const reviewCutoff = new Date(now.getTime() - REVIEW_PENDING_AFTER_HOURS * 3_600_000);
  const want = (k: AttentionKey) => keys.includes(k);

  const escalationWhere: Prisma.EscalationWhereInput = {
    tenantId,
    status: { in: ["OPEN", "ACKNOWLEDGED"] },
    ...(personal && userId ? { assignedToId: userId } : {}),
  };
  const followUpWhere: Prisma.LeadFollowUpWhereInput = { tenantId, doneAt: null, dueAt: { lt: now }, lead: { ...notDeleted } };
  const reviewWhere: Prisma.ConsultationWhereInput = {
    tenantId,
    status: "PENDING_REVIEW",
    createdAt: { lt: reviewCutoff },
    ...(personal && userId ? { doctorId: userId } : {}),
  };
  const noShowWhere: Prisma.AppointmentWhereInput = { tenantId, ...notDeleted, status: "NO_SHOW", startsAt: { gte: dayStart, lte: dayEnd } };

  const [escalations, unacknowledged, oldestEscalation, followUps, oldestFollowUp, reviewPending, noShows, intake, unread, critical] =
    await Promise.all([
      want("escalations") ? db.escalation.count({ where: escalationWhere }) : 0,
      want("escalations") ? db.escalation.count({ where: { ...escalationWhere, status: "OPEN" } }) : 0,
      want("escalations")
        ? db.escalation.findFirst({ where: escalationWhere, orderBy: { dueAt: "asc" }, select: { dueAt: true } })
        : null,
      want("followUps") ? db.leadFollowUp.count({ where: followUpWhere }) : 0,
      want("followUps")
        ? db.leadFollowUp.findFirst({ where: followUpWhere, orderBy: { dueAt: "asc" }, select: { dueAt: true } })
        : null,
      want("reviewPending") ? db.consultation.count({ where: reviewWhere }) : 0,
      want("noShows") ? db.appointment.count({ where: noShowWhere }) : 0,
      want("intake") ? db.intakeSubmission.count({ where: { tenantId, status: "PENDING" } }) : 0,
      want("unread") && userId ? db.notification.count({ where: { tenantId, userId, readAt: null } }) : 0,
      want("unread") && userId ? db.notification.count({ where: { tenantId, userId, readAt: null, level: "CRITICAL" } }) : 0,
    ]);

  const items: AttentionItem[] = [];
  for (const key of keys) {
    switch (key) {
      case "escalations": {
        if (!escalations) break;
        const due = oldestEscalation?.dueAt ?? null;
        const overdue = Boolean(due && due.getTime() < now.getTime());
        const when = due ? (isSameDayInTz(due, now, timezone) ? formatTimeInTz(due, timezone) : formatDateTimeInTz(due, timezone)) : null;
        items.push({
          key,
          count: escalations,
          label: plural(escalations, personal ? "escalation assigned to you" : "open escalation"),
          detail: `${unacknowledged} not yet acknowledged${when ? ` · oldest target ${when}${overdue ? " (overdue)" : ""}` : ""}`,
          href: "/dashboard/concierge",
          tone: overdue ? "danger" : "warning",
          ...(due ? { due: { at: due.toISOString(), overdue } } : {}),
        });
        break;
      }
      case "followUps": {
        if (!followUps) break;
        const oldest = oldestFollowUp?.dueAt ?? null;
        items.push({
          key,
          count: followUps,
          label: plural(followUps, "follow-up overdue", "follow-ups overdue"),
          detail: oldest ? `due and not done · oldest was due ${formatDateInTz(oldest, timezone)}` : "due and not done",
          href: "/dashboard/leads?tab=follow-ups",
          tone: "warning",
        });
        break;
      }
      case "reviewPending": {
        if (!reviewPending) break;
        items.push({
          key,
          count: reviewPending,
          label: plural(reviewPending, personal ? "draft of yours awaiting signature" : "consultation awaiting signature", personal ? "drafts of yours awaiting signature" : "consultations awaiting signature"),
          detail: `waiting more than ${REVIEW_PENDING_AFTER_HOURS} h to be signed`,
          href: "/dashboard/consultations",
          tone: "warning",
        });
        break;
      }
      case "noShows": {
        if (!noShows) break;
        items.push({
          key,
          count: noShows,
          label: plural(noShows, "no-show today", "no-shows today"),
          detail: "patients to call back and rebook",
          href: `/dashboard/appointments?date=${dateKeyInTz(now, timezone)}`,
          tone: "warning",
        });
        break;
      }
      case "intake": {
        if (!intake) break;
        items.push({
          key,
          count: intake,
          label: plural(intake, "onboarding submission pending", "onboarding submissions pending"),
          detail: "forms to accept into the registry or reject",
          href: "/dashboard/patients/intake",
          tone: "default",
        });
        break;
      }
      case "unread": {
        if (!unread) break;
        items.push({
          key,
          count: unread,
          label: plural(unread, "unread notification"),
          detail: critical ? `${plural(critical, "critical alert")} among them` : "waiting in your bell",
          href: "/dashboard/notifications",
          tone: critical ? "danger" : "default",
        });
        break;
      }
    }
  }

  return {
    items: items.slice(0, 6),
    total: items.reduce((sum, i) => sum + i.count, 0),
    timezone,
    generatedAt: now.toISOString(),
  };
}
