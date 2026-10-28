/**
 * Notifications service, jobs and attention scopes against the test database:
 * recipients by role and id, excludeUserId, preference gating (in-app and
 * e-mail), forceEmail, markRead scoped to the user, unreadCount, preference
 * merging, the test notification, the digest e-mail, and the three jobs
 * (review-pending reminders fire once, digest once a day, cleanup).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mailer", () => ({ sendMail: vi.fn(async () => undefined) }));

import { ZodError } from "zod";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { sendMail } from "@/lib/mailer";
import { zonedParts } from "@/lib/time";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, runAsSystem } from "@/test/db";
import {
  buildDigestEmail,
  createTestNotification,
  DIGEST_TITLE,
  emailEnabled,
  getPreferences,
  inAppEnabled,
  KIND_LABELS,
  listNotifications,
  markRead,
  notify,
  TEST_NOTIFICATION_TITLE,
  unreadCount,
  updatePreferences,
} from "@/modules/notifications/service";
import { REVIEW_REMINDER_AUDIT_ACTION, runCleanup, runDailyDigest, runReviewPendingReminders } from "@/modules/notifications/jobs";
import { attentionIsPersonal, attentionKeysFor } from "@/modules/notifications/attention";
import { relativeTime, safeNotificationHref } from "@/modules/notifications/kinds";

// These tests call the services directly, outside any route.
runAsSystem();

const mail = vi.mocked(sendMail);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type U = { id: string; email: string };

describe("notifications · pure helpers", () => {
  it("relativeTime reads like a human", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    expect(relativeTime(new Date(now.getTime() - 10_000), now)).toBe("just now");
    expect(relativeTime(new Date(now.getTime() - 3 * 60_000), now)).toBe("3 min ago");
    expect(relativeTime(new Date(now.getTime() - 2 * HOUR), now)).toBe("2 h ago");
    expect(relativeTime(new Date(now.getTime() - DAY), now)).toBe("yesterday");
    expect(relativeTime(new Date(now.getTime() - 3 * DAY), now)).toBe("3 d ago");
  });

  it("safeNotificationHref only follows dashboard paths", () => {
    expect(safeNotificationHref("/dashboard/concierge")).toBe("/dashboard/concierge");
    expect(safeNotificationHref("https://evil.example/")).toBeNull();
    expect(safeNotificationHref("//evil.example")).toBeNull();
    expect(safeNotificationHref(null)).toBeNull();
  });

  it("attention scopes follow the role", () => {
    expect(attentionKeysFor("CLINIC_OWNER")).toEqual(["escalations", "followUps", "reviewPending", "noShows", "intake", "unread"]);
    expect(attentionKeysFor("DOCTOR")).toEqual(["escalations", "reviewPending", "unread"]);
    expect(attentionKeysFor("RECEPTIONIST")).toEqual(["followUps", "noShows", "intake", "unread"]);
    expect(attentionKeysFor("ASSISTANT")).toEqual(["unread"]);
    expect(attentionIsPersonal("DOCTOR")).toBe(true);
    expect(attentionIsPersonal("CLINIC_OWNER")).toBe(false);
  });

  it("buildDigestEmail groups unread titles by kind with links", () => {
    const base = { body: null, href: null, entity: null, entityId: null, readAt: null, emailedAt: null, createdAt: new Date() };
    const text = buildDigestEmail({
      recipient: { email: "o@x.test", fullName: "Owner" },
      clinicName: "Aura",
      unread: [
        { ...base, id: "1", kind: "ESCALATION", level: "CRITICAL", title: "Patient at risk", href: "/dashboard/concierge" },
        { ...base, id: "2", kind: "BOOKING_CREATED", level: "INFO", title: "Booking one", body: "first line\nsecond" },
        { ...base, id: "3", kind: "BOOKING_CREATED", level: "INFO", title: "Booking two" },
      ],
    });
    expect(text.subject).toBe("[Daily digest] 3 unread notifications at Aura");
    expect(text.text.indexOf("New booking (2)")).toBeGreaterThan(-1);
    expect(text.text.indexOf("New booking (2)")).toBeLessThan(text.text.indexOf("Escalation (patient at risk) (1)"));
    expect(text.text).toContain("Booking one — first line");
    expect(text.text).toContain("http://localhost:3000/dashboard/concierge");
    expect(text.text).toContain("/dashboard/notifications");
  });

  it("preference defaults: in-app on, e-mail off except escalations and alerts", () => {
    expect(inAppEnabled(null, "BOOKING_CREATED")).toBe(true);
    expect(emailEnabled(null, "BOOKING_CREATED")).toBe(false);
    expect(emailEnabled(null, "ESCALATION")).toBe(true);
    expect(emailEnabled(null, "ALERT_RULE")).toBe(true);
    const prefs = { inApp: { BOOKING_CREATED: false }, email: { ESCALATION: false, LEAD_NEW: true }, browser: false, digestHour: null };
    expect(inAppEnabled(prefs, "BOOKING_CREATED")).toBe(false);
    expect(emailEnabled(prefs, "ESCALATION")).toBe(false);
    expect(emailEnabled(prefs, "LEAD_NEW")).toBe(true);
  });
});

describe.skipIf(!dbTestsEnabled)("notifications · service and jobs", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let owner: U;
  let doctor1: U;
  let doctor2: U;
  let nurse: U;
  let receptionist: U;
  let ownerB: U;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `notif-svc-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `notif-svc-b-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA.id;
    b = tenantB.id;
    owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    doctor1 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr One" });
    doctor2 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr Two" });
    nurse = await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse" });
    receptionist = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk" });
    await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr Disabled", status: "DISABLED" });
    await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr Invited", status: "INVITED", password: null });
    ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
  });

  beforeEach(() => {
    mail.mockClear();
    mail.mockImplementation(async () => undefined);
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("notify()", () => {
    it("reaches every active user holding one of the roles, in this tenant only", async () => {
      const res = await notify(a, { kind: "LEAD_NEW", title: "roles-only", roles: ["RECEPTIONIST", "NURSE"] });
      expect(res.created).toBe(2);
      expect([...res.recipientIds].sort()).toEqual([nurse.id, receptionist.id].sort());
      const rows = await db.notification.findMany({ where: { tenantId: a, title: "roles-only" } });
      expect(rows.map((r) => r.userId).sort()).toEqual([nurse.id, receptionist.id].sort());
      expect(rows[0]).toMatchObject({ kind: "LEAD_NEW", level: "INFO", readAt: null, emailedAt: null });
      expect(await db.notification.count({ where: { tenantId: b } })).toBe(0);
    });

    it("unions ids and roles, skips disabled, invited and foreign users", async () => {
      const res = await notify(a, { kind: "SYSTEM", title: "ids-and-roles", userIds: [doctor1.id, ownerB.id], roles: ["DOCTOR"] });
      expect(res.created).toBe(2);
      expect([...res.recipientIds].sort()).toEqual([doctor1.id, doctor2.id].sort());
      expect(await db.notification.count({ where: { title: "ids-and-roles", userId: ownerB.id } })).toBe(0);
    });

    it("excludeUserId leaves the actor out", async () => {
      const res = await notify(a, { kind: "SYSTEM", title: "exclude", roles: ["DOCTOR"], excludeUserId: doctor1.id });
      expect(res.recipientIds).toEqual([doctor2.id]);
      expect(res.created).toBe(1);
    });

    it("does nothing without recipients", async () => {
      expect(await notify(a, { kind: "SYSTEM", title: "nobody" })).toEqual({ created: 0, emailed: 0, recipientIds: [] });
      expect(await notify(a, { kind: "SYSTEM", title: "nobody", roles: ["SUPER_ADMIN"] })).toEqual({ created: 0, emailed: 0, recipientIds: [] });
    });

    it("respects the in-app preference per kind", async () => {
      await updatePreferences(a, doctor1.id, { inApp: { BOOKING_CREATED: false } });
      const res = await notify(a, { kind: "BOOKING_CREATED", title: "inapp-gated", userIds: [doctor1.id, doctor2.id] });
      expect(res.created).toBe(1);
      expect([...res.recipientIds].sort()).toEqual([doctor1.id, doctor2.id].sort());
      const rows = await db.notification.findMany({ where: { tenantId: a, title: "inapp-gated" } });
      expect(rows.map((r) => r.userId)).toEqual([doctor2.id]);
      // Another kind still lands for doctor1.
      const other = await notify(a, { kind: "NO_SHOW", title: "inapp-other", userIds: [doctor1.id] });
      expect(other.created).toBe(1);
    });

    it("e-mails escalations and alerts by default, nothing else", async () => {
      const esc = await notify(a, { kind: "ESCALATION", level: "CRITICAL", title: "mail-default", body: "Pain 9/10", href: "/dashboard/concierge", userIds: [doctor2.id] });
      expect(esc.emailed).toBe(1);
      expect(mail).toHaveBeenCalledTimes(1);
      const message = mail.mock.calls[0]![0];
      expect(message.to).toBe(doctor2.email);
      expect(message.subject).toBe(`[${KIND_LABELS.ESCALATION}] mail-default`);
      expect(message.text).toContain("Pain 9/10");
      expect(message.text).toContain("http://localhost:3000/dashboard/concierge");
      const row = await db.notification.findFirst({ where: { tenantId: a, title: "mail-default" } });
      expect(row?.emailedAt).toBeInstanceOf(Date);

      mail.mockClear();
      const booking = await notify(a, { kind: "BOOKING_CREATED", title: "mail-off", userIds: [doctor2.id] });
      expect(booking.emailed).toBe(0);
      expect(mail).not.toHaveBeenCalled();
      const quiet = await db.notification.findFirst({ where: { tenantId: a, title: "mail-off" } });
      expect(quiet?.emailedAt).toBeNull();
    });

    it("the e-mail preference overrides the default in both directions", async () => {
      await updatePreferences(a, doctor2.id, { email: { BOOKING_CREATED: true, ESCALATION: false } });
      const booking = await notify(a, { kind: "BOOKING_CREATED", title: "mail-on", userIds: [doctor2.id] });
      expect(booking.emailed).toBe(1);
      mail.mockClear();
      const esc = await notify(a, { kind: "ESCALATION", title: "mail-muted", userIds: [doctor2.id] });
      expect(esc.created).toBe(1);
      expect(esc.emailed).toBe(0);
      expect(mail).not.toHaveBeenCalled();
    });

    it("forceEmail sends regardless of the preference", async () => {
      const res = await notify(a, { kind: "BOOKING_CREATED", title: "forced", userIds: [receptionist.id], forceEmail: true });
      expect(res.emailed).toBe(1);
      expect(mail).toHaveBeenCalledWith(expect.objectContaining({ to: receptionist.email }));
    });

    it("an e-mail failure never loses the in-app row", async () => {
      mail.mockRejectedValueOnce(new Error("smtp down"));
      const res = await notify(a, { kind: "ESCALATION", title: "smtp-down", userIds: [nurse.id] });
      expect(res).toMatchObject({ created: 1, emailed: 0 });
      const row = await db.notification.findFirst({ where: { tenantId: a, title: "smtp-down" } });
      expect(row).not.toBeNull();
      expect(row?.emailedAt).toBeNull();
    });
  });

  describe("reading and marking", () => {
    it("markRead only touches the caller's own rows; unreadCount is per user", async () => {
      await notify(a, { kind: "ALERT_RULE", title: "read-scope", userIds: [doctor1.id, doctor2.id] });
      const d1 = await db.notification.findFirstOrThrow({ where: { tenantId: a, title: "read-scope", userId: doctor1.id } });
      const d2 = await db.notification.findFirstOrThrow({ where: { tenantId: a, title: "read-scope", userId: doctor2.id } });
      const d2Before = await unreadCount(a, doctor2.id);

      expect(await markRead(a, doctor1.id, [d2.id])).toBe(0);
      expect(await markRead(b, ownerB.id, [d1.id, d2.id])).toBe(0);
      expect(await unreadCount(a, doctor2.id)).toBe(d2Before);

      expect(await markRead(a, doctor2.id, [d2.id])).toBe(1);
      expect(await unreadCount(a, doctor2.id)).toBe(d2Before - 1);
      expect(await markRead(a, doctor2.id, [d2.id])).toBe(0);

      const d1Unread = await unreadCount(a, doctor1.id);
      expect(d1Unread).toBeGreaterThan(0);
      expect(await markRead(a, doctor1.id, "all")).toBe(d1Unread);
      expect(await unreadCount(a, doctor1.id)).toBe(0);
      expect((await db.notification.findUniqueOrThrow({ where: { id: d1.id } })).readAt).toBeInstanceOf(Date);
      const audits = await db.auditLog.findMany({ where: { tenantId: a, action: "notification.read_all", actorId: doctor1.id } });
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    it("listNotifications filters by read state, kind and time window", async () => {
      const base = Date.now();
      const mk = (title: string, kind: "LEAD_NEW" | "NO_SHOW", minutesAgo: number, read = false) =>
        db.notification.create({
          data: { tenantId: a, userId: receptionist.id, kind, title, createdAt: new Date(base - minutesAgo * 60_000), readAt: read ? new Date() : null },
        });
      await Promise.all([mk("list-1", "LEAD_NEW", 30), mk("list-2", "NO_SHOW", 20, true), mk("list-3", "LEAD_NEW", 10)]);
      const mine = (rows: { title: string }[]) => rows.map((r) => r.title).filter((t) => t.startsWith("list-"));

      const all = await listNotifications(a, receptionist.id, { take: 100 });
      expect(mine(all)).toEqual(["list-3", "list-2", "list-1"]);
      expect(mine(await listNotifications(a, receptionist.id, { unreadOnly: true, take: 100 }))).toEqual(["list-3", "list-1"]);
      expect(mine(await listNotifications(a, receptionist.id, { kind: "NO_SHOW", take: 100 }))).toEqual(["list-2"]);
      expect(mine(await listNotifications(a, receptionist.id, { since: new Date(base - 15 * 60_000), take: 100 }))).toEqual(["list-3"]);
      expect(mine(await listNotifications(a, receptionist.id, { before: new Date(base - 25 * 60_000), take: 100 }).then((r) => r.filter((x) => x.title.startsWith("list-"))))).toEqual(["list-1"]);
      expect((await listNotifications(a, receptionist.id, { take: 1 })).length).toBe(1);
      expect((await listNotifications(a, receptionist.id, { take: 10_000 })).length).toBeLessThanOrEqual(100);
      expect(await listNotifications(b, receptionist.id)).toEqual([]);
    });
  });

  describe("preferences", () => {
    it("merges partial updates and keeps the rest", async () => {
      expect(await getPreferences(a, nurse.id)).toEqual({ inApp: {}, email: {}, browser: false, digestHour: null });
      await updatePreferences(a, nurse.id, { inApp: { NO_SHOW: false } });
      expect(await getPreferences(a, nurse.id)).toEqual({ inApp: { NO_SHOW: false }, email: {}, browser: false, digestHour: null });
      await updatePreferences(a, nurse.id, { email: { LEAD_NEW: true }, browser: true });
      expect(await getPreferences(a, nurse.id)).toEqual({ inApp: { NO_SHOW: false }, email: { LEAD_NEW: true }, browser: true, digestHour: null });
      await updatePreferences(a, nurse.id, { digestHour: 8, inApp: { LEAD_NEW: false } });
      expect(await getPreferences(a, nurse.id)).toEqual({ inApp: { NO_SHOW: false, LEAD_NEW: false }, email: { LEAD_NEW: true }, browser: true, digestHour: 8 });
      await updatePreferences(a, nurse.id, { digestHour: null });
      expect((await getPreferences(a, nurse.id)).digestHour).toBeNull();
      // Another tenant never sees it.
      expect(await getPreferences(b, nurse.id)).toEqual({ inApp: {}, email: {}, browser: false, digestHour: null });
      const audits = await db.auditLog.count({ where: { tenantId: a, action: "notification.preferences", entityId: nurse.id } });
      expect(audits).toBeGreaterThanOrEqual(4);
    });

    it("rejects invalid input", async () => {
      await expect(updatePreferences(a, nurse.id, { digestHour: 24 })).rejects.toBeInstanceOf(ZodError);
      await expect(updatePreferences(a, nurse.id, { inApp: { NOPE: true } })).rejects.toBeInstanceOf(ZodError);
      await expect(updatePreferences(a, nurse.id, { browser: "yes" })).rejects.toBeInstanceOf(ZodError);
    });
  });

  describe("test notification", () => {
    it("always lands in the bell and e-mails only when SYSTEM e-mail is on", async () => {
      const first = await createTestNotification(a, owner.id);
      expect(first).toMatchObject({ inAppEnabled: true, emailEnabled: false, emailed: false, to: null });
      expect(mail).not.toHaveBeenCalled();
      const row = await db.notification.findUniqueOrThrow({ where: { id: first.notificationId } });
      expect(row).toMatchObject({ userId: owner.id, kind: "SYSTEM", title: TEST_NOTIFICATION_TITLE, readAt: null, emailedAt: null });

      await updatePreferences(a, owner.id, { email: { SYSTEM: true } });
      const second = await createTestNotification(a, owner.id);
      expect(second).toMatchObject({ emailEnabled: true, emailed: true, to: owner.email });
      expect(mail).toHaveBeenCalledWith(expect.objectContaining({ to: owner.email, subject: `[System] ${TEST_NOTIFICATION_TITLE}` }));
      expect((await db.notification.findUniqueOrThrow({ where: { id: second.notificationId } })).emailedAt).toBeInstanceOf(Date);
    });
  });

  describe("jobs", () => {
    it("review-pending reminders fire once per consultation", async () => {
      const patient = await db.patient.create({ data: { tenantId: a, fullName: "Pending Patient" } });
      const common = { tenantId: a, patientId: patient.id, transcript: "…" };
      const stale = await db.consultation.create({ data: { ...common, doctorId: doctor1.id, status: "PENDING_REVIEW", createdAt: new Date(Date.now() - 30 * HOUR) } });
      await db.consultation.create({ data: { ...common, doctorId: doctor1.id, status: "PENDING_REVIEW", createdAt: new Date(Date.now() - 2 * HOUR) } });
      await db.consultation.create({ data: { ...common, doctorId: doctor1.id, status: "SIGNED", createdAt: new Date(Date.now() - 30 * HOUR) } });

      await runReviewPendingReminders();
      const rows = () => db.notification.findMany({ where: { tenantId: a, kind: "REVIEW_PENDING" } });
      const first = await rows();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ userId: doctor1.id, entityId: stale.id, entity: "Consultation", level: "WARNING", href: `/dashboard/consultations?id=${stale.id}` });
      expect(first[0]!.title).toContain("Pending Patient");

      await runReviewPendingReminders();
      await runReviewPendingReminders(new Date(Date.now() + HOUR));
      expect(await rows()).toHaveLength(1);

      // In-app switched off: nothing lands, and the reminder is still not repeated.
      await updatePreferences(a, doctor2.id, { inApp: { REVIEW_PENDING: false } });
      const quiet = await db.consultation.create({ data: { ...common, doctorId: doctor2.id, status: "PENDING_REVIEW", createdAt: new Date(Date.now() - 30 * HOUR) } });
      await runReviewPendingReminders();
      await runReviewPendingReminders();
      expect(await db.notification.count({ where: { tenantId: a, kind: "REVIEW_PENDING", entityId: quiet.id } })).toBe(0);
      expect(await db.auditLog.count({ where: { tenantId: a, action: REVIEW_REMINDER_AUDIT_ACTION, entityId: quiet.id } })).toBe(1);
    });

    it("the daily digest goes once per clinic day to users whose hour it is", async () => {
      const now = new Date();
      const hour = zonedParts(now, "Africa/Cairo").hour;
      await notify(a, { kind: "BOOKING_CREATED", title: "digest-booking", userIds: [owner.id, nurse.id] });
      await updatePreferences(a, owner.id, { digestHour: hour });
      await updatePreferences(a, nurse.id, { digestHour: (hour + 1) % 24 });
      const unreadBefore = await unreadCount(a, owner.id);
      expect(unreadBefore).toBeGreaterThan(0);
      mail.mockClear();

      await runDailyDigest(now);
      const toOwner = mail.mock.calls.filter(([m]) => m.to === owner.email);
      expect(toOwner).toHaveLength(1);
      expect(toOwner[0]![0].subject).toContain(DIGEST_TITLE);
      expect(toOwner[0]![0].text).toContain("digest-booking");
      expect(toOwner[0]![0].text).toContain(TEST_NOTIFICATION_TITLE);
      expect(mail.mock.calls.some(([m]) => m.to === nurse.email)).toBe(false);

      const marker = await db.notification.findFirst({ where: { tenantId: a, userId: owner.id, title: DIGEST_TITLE } });
      expect(marker).toMatchObject({ kind: "SYSTEM", entity: "digest" });
      expect(marker?.readAt).toBeInstanceOf(Date);
      expect(await unreadCount(a, owner.id)).toBe(unreadBefore);

      await runDailyDigest(now);
      await runDailyDigest(new Date(now.getTime() + 20 * 60_000));
      expect(mail.mock.calls.filter(([m]) => m.to === owner.email)).toHaveLength(1);
      expect(await db.notification.count({ where: { tenantId: a, userId: owner.id, title: DIGEST_TITLE } })).toBe(1);
    });

    it("cleanup deletes only read notifications older than 90 days", async () => {
      const old = new Date(Date.now() - 100 * DAY);
      const data = { tenantId: a, userId: nurse.id, kind: "SYSTEM" as const };
      const [oldRead, oldUnread, recentRead] = await Promise.all([
        db.notification.create({ data: { ...data, title: "old read", createdAt: old, readAt: old } }),
        db.notification.create({ data: { ...data, title: "old unread", createdAt: old } }),
        db.notification.create({ data: { ...data, title: "recent read", createdAt: new Date(Date.now() - 10 * DAY), readAt: new Date() } }),
      ]);
      await runCleanup();
      expect(await db.notification.findUnique({ where: { id: oldRead.id } })).toBeNull();
      expect(await db.notification.findUnique({ where: { id: oldUnread.id } })).not.toBeNull();
      expect(await db.notification.findUnique({ where: { id: recentRead.id } })).not.toBeNull();
    });
  });
});
