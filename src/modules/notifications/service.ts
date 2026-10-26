import type { NotificationKind, NotificationLevel, UserRole } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { sendMail } from "@/lib/mailer";
import { zDateTime } from "@/lib/validation";
import {
  EMAIL_DEFAULT_ON,
  KIND_LABELS,
  NOTIFICATION_KINDS,
  relativeTime,
  type NotificationRowLike,
} from "./kinds";

export { EMAIL_DEFAULT_ON, KIND_LABELS, NOTIFICATION_KINDS };
export { KIND_HINTS, NOTIFICATION_LEVELS, toNotificationDTO, type NotificationDTO } from "./kinds";

/**
 * Notifications: one row per recipient, read in the bell and on
 * /dashboard/notifications, copied to e-mail when the recipient's preference
 * says so. Modules call `notify()`; nothing else writes the table except the
 * jobs of this module (digest marker, review reminders, cleanup).
 *
 * Preferences: `inApp[kind]` defaults to on; `email[kind]` defaults to off
 * except escalations and alert rules, which reach a named human by every
 * channel unless switched off.
 */

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

/** Who performed a mutation, for the audit trail. */
export interface NotificationActor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

type PreferenceMap = Record<string, boolean>;

export interface EffectivePreferences {
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

/** Base URL for the links inside notification e-mails. */
export function notificationBaseUrl(): string {
  return (env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, "");
}

interface MailRecipient {
  email: string;
  fullName: string | null;
}

/** One notification as an e-mail: subject from the kind label, the body and a deep link. */
export function notificationMail(
  recipient: MailRecipient,
  input: Pick<NotifyInput, "kind" | "title" | "body" | "href">,
): { to: string; subject: string; text: string } {
  const base = notificationBaseUrl();
  const link = input.href ? `${base}${input.href}` : base;
  return {
    to: recipient.email,
    subject: `[${KIND_LABELS[input.kind]}] ${input.title}`,
    text: `${recipient.fullName ?? recipient.email},\n\n${input.title}\n${input.body ? `\n${input.body}\n` : ""}\n${link}\n`,
  };
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
  const created = rows.length
    ? await db.$transaction(
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
      )
    : [];

  let emailed = 0;
  for (const r of recipients) {
    if (!(input.forceEmail || emailEnabled(prefs.get(r.id) ?? null, input.kind))) continue;
    try {
      await sendMail(notificationMail(r, input));
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
  /** Only rows created before this instant ("load more" paging). */
  before?: Date;
  kind?: NotificationKind;
  take?: number;
}

export const MAX_LIST_TAKE = 100;

const zFlag = z.preprocess(
  (v) => (typeof v === "string" ? ["1", "true", "yes"].includes(v.toLowerCase()) : v),
  z.boolean().optional(),
);

/** `GET /api/notifications?unread=1&since=<iso>&before=<iso>&kind=<KIND>&take=<n>` */
export const NotificationListQuery = z.object({
  unread: zFlag,
  since: zDateTime.optional(),
  before: zDateTime.optional(),
  kind: z.enum(NOTIFICATION_KINDS).optional(),
  take: z.coerce.number().int().min(1).max(MAX_LIST_TAKE).optional(),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuery>;

export async function listNotifications(tenantId: string, userId: string, opts: ListOptions = {}) {
  return db.notification.findMany({
    where: {
      tenantId,
      userId,
      ...(opts.unreadOnly ? { readAt: null } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.since || opts.before
        ? { createdAt: { ...(opts.since ? { gt: opts.since } : {}), ...(opts.before ? { lt: opts.before } : {}) } }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(opts.take ?? 30, 1), MAX_LIST_TAKE),
  });
}

export async function unreadCount(tenantId: string, userId: string): Promise<number> {
  return db.notification.count({ where: { tenantId, userId, readAt: null } });
}

/** `POST /api/notifications/read` body: `{ ids: [...] }` or `{ all: true }`. */
export const MarkReadInput = z.union([
  z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkReadInput = z.infer<typeof MarkReadInput>;

/** Mark the given ids (or every unread one) as read; returns how many changed. */
export async function markRead(
  tenantId: string,
  userId: string,
  ids: readonly string[] | "all",
  actor?: NotificationActor,
): Promise<number> {
  const result = await db.notification.updateMany({
    where: { tenantId, userId, readAt: null, ...(ids === "all" ? {} : { id: { in: [...ids] } }) },
    data: { readAt: new Date() },
  });
  if (result.count > 0) {
    await audit({
      tenantId,
      actorId: actor?.id ?? userId,
      actorEmail: actor?.email ?? null,
      ip: actor?.ip ?? null,
      action: ids === "all" ? "notification.read_all" : "notification.read",
      entity: "Notification",
      entityId: ids === "all" ? null : (ids[0] ?? null),
      after: { count: result.count, ...(ids === "all" ? {} : { ids: [...ids] }) },
    });
  }
  return result.count;
}

// ── Preferences ──────────────────────────────────────────────────────────────

/** `{ [kind]: boolean }` with any subset of kinds (zod 4's `record` over an enum is exhaustive). */
const zKindMap = z.partialRecord(z.enum(NOTIFICATION_KINDS), z.boolean());

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
export async function updatePreferences(
  tenantId: string,
  userId: string,
  rawInput: unknown,
  actor?: NotificationActor,
): Promise<EffectivePreferences> {
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
  await audit({
    tenantId,
    actorId: actor?.id ?? userId,
    actorEmail: actor?.email ?? null,
    ip: actor?.ip ?? null,
    action: "notification.preferences",
    entity: "NotificationPreference",
    entityId: userId,
    before: current,
    after: next,
  });
  return next;
}

// ── Test notification ────────────────────────────────────────────────────────

export const TEST_NOTIFICATION_TITLE = "This is how notifications reach you";

export interface TestNotificationResult {
  notificationId: string;
  /** Whether the caller has in-app SYSTEM notifications on (the test lands in the bell regardless). */
  inAppEnabled: boolean;
  emailEnabled: boolean;
  emailed: boolean;
  /** The address the e-mail went to, when it did. */
  to: string | null;
  browser: boolean;
}

/**
 * "Send me a test notification": a SYSTEM row for the caller, always created so
 * the bell shows something, plus the e-mail when the caller's preference has
 * SYSTEM e-mail on. Returns what was done so the form can say so.
 */
export async function createTestNotification(
  tenantId: string,
  userId: string,
  actor?: NotificationActor,
): Promise<TestNotificationResult> {
  const user = await db.user.findFirst({
    where: { id: userId, tenantId, ...notDeleted },
    select: { id: true, email: true, fullName: true },
  });
  if (!user) throw new NotificationUserNotFoundError(userId);
  const prefs = await getPreferences(tenantId, userId);
  const mailOn = emailEnabled(prefs, "SYSTEM");
  const input = {
    kind: "SYSTEM" as const,
    title: TEST_NOTIFICATION_TITLE,
    body: `Sent to ${user.email} on request. In-app notifications appear in the bell; e-mail copies follow your preferences; browser notifications need the switch and the browser's permission.`,
    href: "/dashboard/settings",
  };
  let emailed = false;
  if (mailOn) {
    try {
      await sendMail(notificationMail(user, input));
      emailed = true;
    } catch (err) {
      console.error("[notifications] test e-mail failed", err);
    }
  }
  const row = await db.notification.create({
    data: {
      tenantId,
      userId,
      kind: input.kind,
      level: "INFO",
      title: input.title,
      body: input.body,
      href: input.href,
      entity: "test",
      emailedAt: emailed ? new Date() : null,
    },
    select: { id: true },
  });
  await audit({
    tenantId,
    actorId: actor?.id ?? userId,
    actorEmail: actor?.email ?? user.email,
    ip: actor?.ip ?? null,
    action: "notification.test",
    entity: "Notification",
    entityId: row.id,
    after: { emailed, emailEnabled: mailOn, inAppEnabled: inAppEnabled(prefs, "SYSTEM") },
  });
  return {
    notificationId: row.id,
    inAppEnabled: inAppEnabled(prefs, "SYSTEM"),
    emailEnabled: mailOn,
    emailed,
    to: emailed ? user.email : null,
    browser: prefs.browser,
  };
}

export class NotificationUserNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
  constructor(readonly userId: string) {
    super(`user ${userId} not found in tenant`);
    this.name = "NotificationUserNotFoundError";
  }
}

// ── Daily digest ─────────────────────────────────────────────────────────────

/** `entity` of the pre-read SYSTEM row that records "digest sent today" for a user. */
export const DIGEST_ENTITY = "digest";
export const DIGEST_TITLE = "Daily digest";

export interface DigestEmail {
  subject: string;
  text: string;
}

/**
 * The digest e-mail: unread titles grouped by kind (in the order of
 * NOTIFICATION_KINDS), each with its deep link. Pure, so tests can check it
 * without a mailbox.
 */
export function buildDigestEmail(opts: {
  recipient: MailRecipient;
  clinicName: string;
  unread: readonly NotificationRowLike[];
  now?: Date;
}): DigestEmail {
  const now = opts.now ?? new Date();
  const base = notificationBaseUrl();
  const byKind = new Map<NotificationKind, NotificationRowLike[]>();
  for (const n of opts.unread) {
    const bucket = byKind.get(n.kind) ?? [];
    bucket.push(n);
    byKind.set(n.kind, bucket);
  }
  const sections: string[] = [];
  for (const kind of NOTIFICATION_KINDS) {
    const rows = byKind.get(kind);
    if (!rows?.length) continue;
    const lines = rows.map((n) => {
      const firstLine = n.body?.split("\n").find((l) => l.trim())?.trim();
      const when = relativeTime(n.createdAt, now);
      return `  • ${n.title}${firstLine ? ` — ${firstLine}` : ""} (${when})\n    ${base}${n.href ?? "/dashboard/notifications"}`;
    });
    sections.push(`${KIND_LABELS[kind]} (${rows.length})\n${lines.join("\n")}`);
  }
  const count = opts.unread.length;
  const name = opts.recipient.fullName ?? opts.recipient.email;
  return {
    subject: `[${DIGEST_TITLE}] ${count} unread notification${count === 1 ? "" : "s"} at ${opts.clinicName}`,
    text:
      `${name},\n\nYou have ${count} unread notification${count === 1 ? "" : "s"} at ${opts.clinicName}.\n\n` +
      `${sections.join("\n\n")}\n\n` +
      `Open them all: ${base}/dashboard/notifications\n` +
      `Change when this digest arrives: ${base}/dashboard/settings\n`,
  };
}

/** True when a digest marker for this user exists since `dayStart` (clinic midnight). */
export async function digestSentSince(tenantId: string, userId: string, dayStart: Date): Promise<boolean> {
  const marker = await db.notification.findFirst({
    where: { tenantId, userId, kind: "SYSTEM", entity: DIGEST_ENTITY, createdAt: { gte: dayStart } },
    select: { id: true },
  });
  return Boolean(marker);
}

/**
 * Record that today's digest went out: a SYSTEM row titled "Daily digest",
 * created already read so it never inflates the unread count, visible under
 * "All" on the notifications page as a receipt.
 */
export async function recordDigestSent(tenantId: string, userId: string, opts: { to: string; count: number; now?: Date }) {
  const now = opts.now ?? new Date();
  return db.notification.create({
    data: {
      tenantId,
      userId,
      kind: "SYSTEM",
      level: "INFO",
      title: DIGEST_TITLE,
      body: `${opts.count} unread notification${opts.count === 1 ? "" : "s"} e-mailed to ${opts.to}.`,
      href: "/dashboard/notifications",
      entity: DIGEST_ENTITY,
      readAt: now,
      emailedAt: now,
      createdAt: now,
    },
    select: { id: true },
  });
}
