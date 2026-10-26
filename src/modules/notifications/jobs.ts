import type { Job } from "@/modules/jobs/types";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendMail } from "@/lib/mailer";
import { formatDateTimeInTz, startOfDayInTz, zonedParts } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { buildDigestEmail, digestSentSince, notify, recordDigestSent } from "./service";

/**
 * Background jobs of the notifications module. Registered in modules/jobs/registry.ts;
 * each job is idempotent, iterates the active tenants and is safe to run every minute.
 *
 *  - notifications-digest (every 30 min): one e-mail per user whose digest hour is
 *    the current clinic hour, listing their unread notifications grouped by kind.
 *    "Already sent today" is a pre-read SYSTEM row titled "Daily digest"
 *    (entity "digest") created on the clinic day; see recordDigestSent().
 *  - notifications-review-pending (every 60 min): consultations PENDING_REVIEW for
 *    more than 24 h → one REVIEW_PENDING notification to the consultation's doctor.
 *    Once per consultation: an existing REVIEW_PENDING row with that entityId, or
 *    (when the doctor switched the kind off in-app and no row exists) the audit
 *    entry written when the reminder went out.
 *  - notifications-cleanup (daily): read notifications older than 90 days are deleted.
 */

export const REVIEW_PENDING_AFTER_HOURS = 24;
export const CLEANUP_AFTER_DAYS = 90;
export const REVIEW_REMINDER_AUDIT_ACTION = "notification.review_pending";

async function activeTenants() {
  return db.tenant.findMany({ where: { status: "ACTIVE", ...notDeleted }, select: { id: true, name: true } });
}

// ── Daily digest ─────────────────────────────────────────────────────────────

export async function runDailyDigest(now: Date = new Date()): Promise<string> {
  let sent = 0;
  let considered = 0;
  for (const tenant of await activeTenants()) {
    const timezone = await getTenantTimezone(tenant.id);
    const hour = zonedParts(now, timezone).hour;
    const due = await db.notificationPreference.findMany({
      where: { tenantId: tenant.id, digestHour: hour },
      select: { userId: true },
    });
    if (!due.length) continue;
    const dayStart = startOfDayInTz(now, timezone);
    for (const { userId } of due) {
      considered += 1;
      if (await digestSentSince(tenant.id, userId, dayStart)) continue;
      const user = await db.user.findFirst({
        where: { id: userId, tenantId: tenant.id, status: "ACTIVE", ...notDeleted },
        select: { id: true, email: true, fullName: true },
      });
      if (!user) continue;
      const unread = await db.notification.findMany({
        where: { tenantId: tenant.id, userId, readAt: null },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      if (!unread.length) continue;
      const mail = buildDigestEmail({ recipient: user, clinicName: tenant.name, unread, now });
      try {
        await sendMail({ to: user.email, ...mail });
      } catch (err) {
        console.error("[notifications] digest e-mail failed", err);
        continue;
      }
      const marker = await recordDigestSent(tenant.id, userId, { to: user.email, count: unread.length, now });
      await audit({
        tenantId: tenant.id,
        actorId: null,
        action: "notification.digest",
        entity: "Notification",
        entityId: marker.id,
        after: { userId, to: user.email, count: unread.length },
      });
      sent += 1;
    }
  }
  return `${sent} digest${sent === 1 ? "" : "s"} sent (${considered} due)`;
}

// ── Review-pending reminders ─────────────────────────────────────────────────

export async function runReviewPendingReminders(now: Date = new Date()): Promise<string> {
  const cutoff = new Date(now.getTime() - REVIEW_PENDING_AFTER_HOURS * 3_600_000);
  let reminded = 0;
  for (const tenant of await activeTenants()) {
    const stale = await db.consultation.findMany({
      where: { tenantId: tenant.id, status: "PENDING_REVIEW", createdAt: { lt: cutoff }, doctorId: { not: null } },
      select: { id: true, doctorId: true, createdAt: true, patient: { select: { fullName: true } } },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    if (!stale.length) continue;
    const ids = stale.map((c) => c.id);
    const [notified, audited] = await Promise.all([
      db.notification.findMany({
        where: { tenantId: tenant.id, kind: "REVIEW_PENDING", entityId: { in: ids } },
        select: { entityId: true },
        distinct: ["entityId"],
      }),
      db.auditLog.findMany({
        where: { tenantId: tenant.id, entity: "Consultation", action: REVIEW_REMINDER_AUDIT_ACTION, entityId: { in: ids } },
        select: { entityId: true },
      }),
    ]);
    const done = new Set([...notified, ...audited].map((r) => r.entityId));
    const timezone = await getTenantTimezone(tenant.id);
    for (const c of stale) {
      if (done.has(c.id) || !c.doctorId) continue;
      const hours = Math.floor((now.getTime() - c.createdAt.getTime()) / 3_600_000);
      const result = await notify(tenant.id, {
        kind: "REVIEW_PENDING",
        level: "WARNING",
        title: `Consultation of ${c.patient.fullName} awaits your signature`,
        body: `Drafted ${formatDateTimeInTz(c.createdAt, timezone)} · waiting ${hours} h. Review the extraction and sign it.`,
        href: `/dashboard/consultations?id=${c.id}`,
        entity: "Consultation",
        entityId: c.id,
        userIds: [c.doctorId],
      });
      await audit({
        tenantId: tenant.id,
        actorId: null,
        action: REVIEW_REMINDER_AUDIT_ACTION,
        entity: "Consultation",
        entityId: c.id,
        after: { doctorId: c.doctorId, created: result.created, emailed: result.emailed },
      });
      reminded += 1;
    }
  }
  return `${reminded} reminder${reminded === 1 ? "" : "s"} sent`;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export async function runCleanup(now: Date = new Date()): Promise<string> {
  const cutoff = new Date(now.getTime() - CLEANUP_AFTER_DAYS * 86_400_000);
  let deleted = 0;
  for (const tenant of await activeTenants()) {
    const result = await db.notification.deleteMany({
      where: { tenantId: tenant.id, readAt: { not: null }, createdAt: { lt: cutoff } },
    });
    if (result.count) {
      deleted += result.count;
      await audit({
        tenantId: tenant.id,
        actorId: null,
        action: "notification.cleanup",
        entity: "Notification",
        after: { deleted: result.count, olderThan: cutoff.toISOString() },
      });
    }
  }
  return `${deleted} read notification${deleted === 1 ? "" : "s"} older than ${CLEANUP_AFTER_DAYS} days deleted`;
}

export const jobs: Job[] = [
  { name: "notifications-digest", everyMinutes: 30, run: ({ now }) => runDailyDigest(now) },
  { name: "notifications-review-pending", everyMinutes: 60, run: ({ now }) => runReviewPendingReminders(now) },
  { name: "notifications-cleanup", everyMinutes: 24 * 60, run: ({ now }) => runCleanup(now) },
];
