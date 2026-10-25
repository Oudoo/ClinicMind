import type { NotificationKind, NotificationLevel, UserRole } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { env } from "@/lib/env";
import { sendMail } from "@/lib/mailer";

/**
 * Notifications: one row per recipient, read in the bell and on
 * /dashboard/notifications, copied to e-mail when the recipient's preference
 * says so. Modules call `notify()`; nothing else writes the table.
 *
 * Preferences: `inApp[kind]` defaults to on; `email[kind]` defaults to off
 * except escalations and alert rules, which reach a named human by every
 * channel unless switched off.
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

/** Kinds that go to e-mail unless the recipient switched them off. */
export const EMAIL_DEFAULT_ON: readonly NotificationKind[] = ["ESCALATION", "ALERT_RULE"];

export interface NotifyInput {
  kind: NotificationKind;
  level?: NotificationLevel;
  title: string;
  body?: string | null;
  /** Where the notification takes the reader (dashboard path). */
  href?: string | null;
  entity?: string | null;
  entityId?: string | null;
  /** Explicit recipients and/or every active user holding one of these roles. */
  userIds?: readonly string[];
  roles?: readonly UserRole[];
  /** Usually the actor, who does not need to be told what they just did. */
  excludeUserId?: string | null;
  /** Send e-mail regardless of preference (escalation targets). */
  forceEmail?: boolean;
}

export interface NotifyResult {
  created: number;
  emailed: number;
  recipientIds: string[];
}

type PreferenceMap = Record<string, boolean>;

interface EffectivePreferences {
  inApp: PreferenceMap;
  email: PreferenceMap;
  browser: boolean;
  digestHour: number | null;
}

const prefMap = (v: unknown): PreferenceMap =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, b]) => typeof b === "boolean")) as PreferenceMap
    : {};

export function inAppEnabled(prefs: EffectivePreferences | null, kind: NotificationKind): boolean {
  return prefs?.inApp[kind] !== false;
}

export function emailEnabled(prefs: EffectivePreferences | null, kind: NotificationKind): boolean {
  const explicit = prefs?.email[kind];
  if (typeof explicit === "boolean") return explicit;
  return EMAIL_DEFAULT_ON.includes(kind);
}

function publicUrl(): string {
  return (env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, "");
}

/**
 * Create the notification for every recipient and e-mail the ones whose
 * preference asks for it. Never throws for a delivery problem: e-mail failures
 * are logged and the in-app row still lands.
 */
export async function notify(tenantId: string, input: NotifyInput): Promise<NotifyResult> {
  const userIds = [...new Set(input.userIds ?? [])];
  const roles = [...new Set(input.roles ?? [])];
  if (!userIds.length && !roles.length) return { created: 0, emailed: 0, recipientIds: [] };

  const recipients = await db.user.findMany({
    where: {
      tenantId,
      ...notDeleted,
      status: "ACTIVE",
      ...(input.excludeUserId ? { id: { not: input.excludeUserId } } : {}),
      OR: [...(userIds.length ? [{ id: { in: userIds } }] : []), ...(roles.length ? [{ role: { in: roles } }] : [])],
    },
    select: { id: true, email: true, fullName: true },
  });
  if (!recipients.length) return { created: 0, emailed: 0, recipientIds: [] };

  const prefRows = await db.notificationPreference.findMany({ where: { tenantId, userId: { in: recipients.map((r) => r.id) } } });
  const prefs = new Map(prefRows.map((p) => [p.userId, { inApp: prefMap(p.inApp), email: prefMap(p.email), browser: p.browser, digestHour: p.digestHour }]));

  const level = input.level ?? "INFO";
  const rows = recipients.filter((r) => inAppEnabled(prefs.get(r.id) ?? null, input.kind));
  const created = await db.$transaction(
    rows.map((r) =>
      db.notification.create({
        data: {
          tenantId,
          userId: r.id,
          kind: input.kind,
          level,
          title: input.title,
          body: input.body ?? null,
          href: input.href ?? null,
          entity: input.entity ?? null,
          entityId: input.entityId ?? null,
        },
        select: { id: true, userId: true },
      }),
    ),
  );

  let emailed = 0;
  for (const r of recipients) {
    if (!(input.forceEmail || emailEnabled(prefs.get(r.id) ?? null, input.kind))) continue;
    const link = input.href ? `${publicUrl()}${input.href}` : publicUrl();
    try {
      await sendMail({
        to: r.email,
        subject: `[${KIND_LABELS[input.kind]}] ${input.title}`,
        text: `${r.fullName ?? r.email},\n\n${input.title}\n${input.body ? `\n${input.body}\n` : ""}\n${link}\n`,
      });
      emailed += 1;
      const row = created.find((c) => c.userId === r.id);
      if (row) await db.notification.update({ where: { id: row.id }, data: { emailedAt: new Date() } }).catch(() => undefined);
    } catch (err) {
      console.error("[notifications] e-mail failed", err);
    }
  }
  return { created: created.length, emailed, recipientIds: recipients.map((r) => r.id) };
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface ListOptions {
  unreadOnly?: boolean;
  /** Only rows created after this instant (polling). */
  since?: Date;
  take?: number;
}

export async function listNotifications(tenantId: string, userId: string, opts: ListOptions = {}) {
  return db.notification.findMany({
    where: {
      tenantId,
      userId,
      ...(opts.unreadOnly ? { readAt: null } : {}),
      ...(opts.since ? { createdAt: { gt: opts.since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.take ?? 30, 1), 100),
  });
}

export async function unreadCount(tenantId: string, userId: string): Promise<number> {
  return db.notification.count({ where: { tenantId, userId, readAt: null } });
}

/** Mark the given ids (or every unread one) as read; returns how many changed. */
export async function markRead(tenantId: string, userId: string, ids: readonly string[] | "all"): Promise<number> {
  const result = await db.notification.updateMany({
    where: { tenantId, userId, readAt: null, ...(ids === "all" ? {} : { id: { in: [...ids] } }) },
    data: { readAt: new Date() },
  });
  return result.count;
}

// ── Preferences ──────────────────────────────────────────────────────────────

const zKindMap = z.record(z.enum(NOTIFICATION_KINDS), z.boolean());

export const PreferencesInput = z.object({
  inApp: zKindMap.optional(),
  email: zKindMap.optional(),
  browser: z.boolean().optional(),
  digestHour: z.number().int().min(0).max(23).nullable().optional(),
});
export type PreferencesInput = z.infer<typeof PreferencesInput>;

export async function getPreferences(tenantId: string, userId: string): Promise<EffectivePreferences> {
  const row = await db.notificationPreference.findUnique({ where: { userId } });
  if (!row || row.tenantId !== tenantId) return { inApp: {}, email: {}, browser: false, digestHour: null };
  return { inApp: prefMap(row.inApp), email: prefMap(row.email), browser: row.browser, digestHour: row.digestHour };
}

/** Merge a partial preference change; kinds not mentioned keep their value. */
export async function updatePreferences(tenantId: string, userId: string, rawInput: unknown): Promise<EffectivePreferences> {
  const input = PreferencesInput.parse(rawInput);
  const current = await getPreferences(tenantId, userId);
  const next = {
    inApp: { ...current.inApp, ...(input.inApp ?? {}) },
    email: { ...current.email, ...(input.email ?? {}) },
    browser: input.browser ?? current.browser,
    digestHour: input.digestHour === undefined ? current.digestHour : input.digestHour,
  };
  await db.notificationPreference.upsert({
    where: { userId },
    create: { tenantId, userId, inApp: next.inApp, email: next.email, browser: next.browser, digestHour: next.digestHour },
    update: { inApp: next.inApp, email: next.email, browser: next.browser, digestHour: next.digestHour },
  });
  return next;
}
