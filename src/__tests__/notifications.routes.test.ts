/**
 * Notification routes over the real handlers and the test database: the list
 * is scoped to the signed-in user (never another user's rows, even in the same
 * tenant), marking read, preference validation, the test endpoint and the
 * role-aware attention summary with a seeded escalation and an overdue
 * follow-up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mailer", () => ({ sendMail: vi.fn(async () => undefined) }));

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { sendMail } from "@/lib/mailer";
import { zonedParts, zonedTimeToUtc } from "@/lib/time";
import { GET as listRoute } from "@/app/api/notifications/route";
import { POST as readRoute } from "@/app/api/notifications/read/route";
import { GET as prefsGetRoute, PATCH as prefsPatchRoute } from "@/app/api/notifications/preferences/route";
import { POST as testRoute } from "@/app/api/notifications/test/route";
import { GET as attentionRoute } from "@/app/api/notifications/attention/route";
import { notify, TEST_NOTIFICATION_TITLE } from "@/modules/notifications/service";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const mail = vi.mocked(sendMail);
const HOUR = 3_600_000;
const TZ = "Africa/Cairo";

type U = { id: string; email: string };
type Item = { key: string; count: number; label: string; detail: string; href: string; tone: string; due?: { at: string; overdue: boolean } };

describe.skipIf(!dbTestsEnabled)("notifications routes", () => {
  const created: string[] = [];
  let a: string;
  let owner: U;
  let desk: U;
  let doctor: U;
  let ownerC: U;
  let ownerCookie: string;
  let deskCookie: string;
  let doctorCookie: string;
  let ownerCCookie: string;

  async function list(cookie: string, qs = "") {
    const res = await listRoute(request(`/api/notifications${qs}`, { cookie }));
    return { res, json: await res.json() };
  }

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `notif-rt-a-${Date.now().toString(36)}` });
    const tenantC = await createTenant({ slug: `notif-rt-c-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantC.id);
    a = tenantA.id;
    owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    desk = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr A" });
    ownerC = await createUser({ tenantId: tenantC.id, role: "CLINIC_OWNER", fullName: "Owner C" });
    ownerCookie = await sessionCookieFor(owner.id);
    deskCookie = await sessionCookieFor(desk.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    ownerCCookie = await sessionCookieFor(ownerC.id);
  });

  beforeEach(() => {
    mail.mockClear();
    mail.mockImplementation(async () => undefined);
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("GET /api/notifications", () => {
    it("requires a session", async () => {
      expect((await listRoute(request("/api/notifications"))).status).toBe(401);
    });

    it("returns only the signed-in user's rows, even inside the same tenant", async () => {
      await notify(a, { kind: "LEAD_NEW", title: "A1", userIds: [owner.id] });
      await notify(a, { kind: "LEAD_NEW", title: "A2", userIds: [owner.id] });
      await notify(a, { kind: "NO_SHOW", title: "A3", userIds: [owner.id] });
      await notify(a, { kind: "LEAD_NEW", title: "B1", userIds: [desk.id] });
      await notify(a, { kind: "INTAKE_SUBMITTED", title: "B2", userIds: [desk.id] });

      const mine = await list(ownerCookie);
      expect(mine.res.status).toBe(200);
      expect(mine.res.headers.get("cache-control")).toContain("no-store");
      expect(mine.json.notifications.map((n: { title: string }) => n.title).sort()).toEqual(["A1", "A2", "A3"]);
      expect(mine.json.unread).toBe(3);
      expect(typeof mine.json.now).toBe("string");
      expect(mine.json.notifications[0]).toMatchObject({ kind: expect.any(String), level: "INFO", readAt: null });
      expect(mine.json.notifications[0]).not.toHaveProperty("userId");

      const theirs = await list(deskCookie);
      expect(theirs.json.notifications.map((n: { title: string }) => n.title).sort()).toEqual(["B1", "B2"]);
      expect(theirs.json.unread).toBe(2);
      const bIds = new Set(theirs.json.notifications.map((n: { id: string }) => n.id));
      for (const n of mine.json.notifications as { id: string }[]) expect(bIds.has(n.id)).toBe(false);

      const foreign = await list(ownerCCookie);
      expect(foreign.json.notifications).toEqual([]);
      expect(foreign.json.unread).toBe(0);
    });

    it("filters by unread, kind, since and before, and bounds take", async () => {
      const base = Date.now();
      const mk = (title: string, minutesAgo: number) =>
        db.notification.create({ data: { tenantId: a, userId: doctor.id, kind: "BOOKING_CREATED", title, createdAt: new Date(base - minutesAgo * 60_000) } });
      await mk("P1", 30);
      await mk("P2", 20);
      await mk("P3", 10);
      const titles = (json: { notifications: { title: string }[] }) => json.notifications.map((n) => n.title);

      expect(titles((await list(doctorCookie)).json)).toEqual(["P3", "P2", "P1"]);
      expect(titles((await list(doctorCookie, `?since=${new Date(base - 15 * 60_000).toISOString()}`)).json)).toEqual(["P3"]);
      expect(titles((await list(doctorCookie, `?before=${new Date(base - 15 * 60_000).toISOString()}`)).json)).toEqual(["P2", "P1"]);
      expect(titles((await list(doctorCookie, "?take=1")).json)).toEqual(["P3"]);
      expect(titles((await list(doctorCookie, "?kind=NO_SHOW")).json)).toEqual([]);
      expect(titles((await list(doctorCookie, "?kind=BOOKING_CREATED&take=2")).json)).toEqual(["P3", "P2"]);

      const readRes = await readRoute(request("/api/notifications/read", { method: "POST", cookie: doctorCookie, body: { ids: [(await list(doctorCookie, "?take=1")).json.notifications[0].id] } }));
      expect(readRes.status).toBe(200);
      expect(titles((await list(doctorCookie, "?unread=1")).json)).toEqual(["P2", "P1"]);
      expect((await list(doctorCookie, "?unread=1")).json.unread).toBe(2);

      expect((await list(doctorCookie, "?take=0")).res.status).toBe(422);
      expect((await list(doctorCookie, "?take=abc")).res.status).toBe(422);
      expect((await list(doctorCookie, "?since=yesterday")).res.status).toBe(422);
      expect((await list(doctorCookie, "?kind=NOPE")).res.status).toBe(422);
    });
  });

  describe("POST /api/notifications/read", () => {
    it("marks the caller's rows only; other users' ids are ignored", async () => {
      const deskRow = await db.notification.findFirstOrThrow({ where: { tenantId: a, userId: desk.id, title: "B1" } });
      const ownRow = await db.notification.findFirstOrThrow({ where: { tenantId: a, userId: owner.id, title: "A1" } });

      const stolen = await readRoute(request("/api/notifications/read", { method: "POST", cookie: ownerCookie, body: { ids: [deskRow.id] } }));
      expect(stolen.status).toBe(200);
      expect(await stolen.json()).toMatchObject({ updated: 0, unread: 3 });
      expect((await db.notification.findUniqueOrThrow({ where: { id: deskRow.id } })).readAt).toBeNull();

      const own = await readRoute(request("/api/notifications/read", { method: "POST", cookie: ownerCookie, body: { ids: [ownRow.id, deskRow.id] } }));
      expect(await own.json()).toMatchObject({ updated: 1, unread: 2 });
      expect((await db.notification.findUniqueOrThrow({ where: { id: ownRow.id } })).readAt).toBeInstanceOf(Date);

      const all = await readRoute(request("/api/notifications/read", { method: "POST", cookie: ownerCookie, body: { all: true } }));
      expect(await all.json()).toEqual({ updated: 2, unread: 0 });
      expect((await list(ownerCookie, "?unread=1")).json.notifications).toEqual([]);
      // The desk's rows are untouched.
      expect((await list(deskCookie)).json.unread).toBe(2);
    });

    it("validates the body, the origin and the session", async () => {
      expect((await readRoute(request("/api/notifications/read", { method: "POST", cookie: ownerCookie, body: {} }))).status).toBe(422);
      expect((await readRoute(request("/api/notifications/read", { method: "POST", cookie: ownerCookie, body: { ids: [] } }))).status).toBe(422);
      expect((await readRoute(request("/api/notifications/read", { method: "POST", cookie: ownerCookie, body: { all: false } }))).status).toBe(422);
      expect((await readRoute(request("/api/notifications/read", { method: "POST", body: { all: true } }))).status).toBe(401);
      const cross = await readRoute(request("/api/notifications/read", { method: "POST", cookie: ownerCookie, body: { all: true }, headers: { origin: "https://evil.example" } }));
      expect(cross.status).toBe(403);
    });
  });

  describe("/api/notifications/preferences", () => {
    it("GET returns the defaults, PATCH merges, invalid input is 422", async () => {
      const initial = await prefsGetRoute(request("/api/notifications/preferences", { cookie: ownerCookie }));
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({
        preferences: { inApp: {}, email: {}, browser: false, digestHour: null },
        emailDefaultOn: ["ESCALATION", "ALERT_RULE", "SAFETY_OVERRIDE"],
      });

      const patched = await prefsPatchRoute(
        request("/api/notifications/preferences", { method: "PATCH", cookie: ownerCookie, body: { browser: true, digestHour: 8, email: { ESCALATION: false }, inApp: { BOOKING_CREATED: false } } }),
      );
      expect(patched.status).toBe(200);
      expect(await patched.json()).toEqual({ preferences: { inApp: { BOOKING_CREATED: false }, email: { ESCALATION: false }, browser: true, digestHour: 8 } });

      const again = await prefsPatchRoute(request("/api/notifications/preferences", { method: "PATCH", cookie: ownerCookie, body: { email: { SYSTEM: true } } }));
      expect(await again.json()).toEqual({ preferences: { inApp: { BOOKING_CREATED: false }, email: { ESCALATION: false, SYSTEM: true }, browser: true, digestHour: 8 } });

      for (const body of [{ digestHour: 24 }, { digestHour: -1 }, { digestHour: "8" }, { inApp: { NOPE: true } }, { email: { ESCALATION: "no" } }, { browser: "yes" }]) {
        const res = await prefsPatchRoute(request("/api/notifications/preferences", { method: "PATCH", cookie: ownerCookie, body }));
        expect(res.status, JSON.stringify(body)).toBe(422);
        expect((await res.json()).error).toBe("validation_error");
      }

      // Another user (same tenant) and another tenant are unaffected.
      expect((await (await prefsGetRoute(request("/api/notifications/preferences", { cookie: deskCookie }))).json()).preferences).toEqual({ inApp: {}, email: {}, browser: false, digestHour: null });
      expect((await (await prefsGetRoute(request("/api/notifications/preferences", { cookie: ownerCCookie }))).json()).preferences).toEqual({ inApp: {}, email: {}, browser: false, digestHour: null });

      expect((await prefsGetRoute(request("/api/notifications/preferences"))).status).toBe(401);
      expect((await prefsPatchRoute(request("/api/notifications/preferences", { method: "PATCH", body: { browser: true } }))).status).toBe(401);
      expect((await prefsPatchRoute(request("/api/notifications/preferences", { method: "PATCH", cookie: ownerCookie, body: { browser: true }, headers: { origin: "https://evil.example" } }))).status).toBe(403);
    });
  });

  describe("POST /api/notifications/test", () => {
    it("creates the SYSTEM notification and e-mails when SYSTEM e-mail is on", async () => {
      // The desk has e-mail off for SYSTEM (default).
      const quiet = await testRoute(request("/api/notifications/test", { method: "POST", cookie: deskCookie, body: {} }));
      expect(quiet.status).toBe(201);
      expect(await quiet.json()).toMatchObject({ inAppEnabled: true, emailEnabled: false, emailed: false, to: null, browser: false });
      expect(mail).not.toHaveBeenCalled();
      const rows = (await list(deskCookie, "?kind=SYSTEM")).json.notifications;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "SYSTEM", title: TEST_NOTIFICATION_TITLE, readAt: null, href: "/dashboard/settings" });

      // The owner switched SYSTEM e-mail on in the preferences test above.
      const loud = await testRoute(request("/api/notifications/test", { method: "POST", cookie: ownerCookie, body: {} }));
      expect(loud.status).toBe(201);
      expect(await loud.json()).toMatchObject({ emailEnabled: true, emailed: true, to: owner.email, browser: true });
      expect(mail).toHaveBeenCalledWith(expect.objectContaining({ to: owner.email, subject: `[System] ${TEST_NOTIFICATION_TITLE}` }));

      expect((await testRoute(request("/api/notifications/test", { method: "POST", body: {} }))).status).toBe(401);
      expect((await testRoute(request("/api/notifications/test", { method: "POST", cookie: ownerCookie, body: {}, headers: { origin: "https://evil.example" } }))).status).toBe(403);
    });
  });

  describe("GET /api/notifications/attention", () => {
    beforeAll(async () => {
      const now = new Date();
      const patient = await db.patient.create({ data: { tenantId: a, fullName: "Attention Patient" } });
      await db.escalation.create({ data: { tenantId: a, kind: "MANUAL", level: "HIGH_RISK", status: "OPEN", summary: "Pain 9/10 after FUE", dueAt: new Date(now.getTime() - HOUR), assignedToId: doctor.id, patientId: patient.id } });
      await db.escalation.create({ data: { tenantId: a, kind: "CONCIERGE", level: "WATCH", status: "ACKNOWLEDGED", summary: "Itching day 5", dueAt: new Date(now.getTime() + 2 * HOUR), acknowledgedAt: now, acknowledgedById: owner.id } });
      await db.escalation.create({ data: { tenantId: a, kind: "MANUAL", status: "RESOLVED", summary: "Resolved one", dueAt: new Date(now.getTime() - 5 * HOUR), resolvedAt: now } });

      const lead = await db.lead.create({ data: { tenantId: a, fullName: "Overdue Lead", stage: "CONTACTED", ownerId: desk.id } });
      await db.leadFollowUp.create({ data: { tenantId: a, leadId: lead.id, ownerId: desk.id, dueAt: new Date(now.getTime() - 3 * HOUR), note: "call back" } });
      await db.leadFollowUp.create({ data: { tenantId: a, leadId: lead.id, ownerId: desk.id, dueAt: new Date(now.getTime() - 6 * HOUR), doneAt: now } });
      await db.leadFollowUp.create({ data: { tenantId: a, leadId: lead.id, ownerId: desk.id, dueAt: new Date(now.getTime() + 6 * HOUR) } });

      await db.consultation.create({ data: { tenantId: a, patientId: patient.id, doctorId: doctor.id, status: "PENDING_REVIEW", createdAt: new Date(now.getTime() - 30 * HOUR) } });
      await db.consultation.create({ data: { tenantId: a, patientId: patient.id, doctorId: owner.id, status: "PENDING_REVIEW", createdAt: new Date(now.getTime() - 48 * HOUR) } });
      await db.consultation.create({ data: { tenantId: a, patientId: patient.id, doctorId: doctor.id, status: "PENDING_REVIEW", createdAt: new Date(now.getTime() - HOUR) } });

      const p = zonedParts(now, TZ);
      const noon = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 12 }, TZ);
      await db.appointment.create({ data: { tenantId: a, patientId: patient.id, doctorId: doctor.id, startsAt: noon, endsAt: new Date(noon.getTime() + 30 * 60_000), status: "NO_SHOW" } });
      await db.appointment.create({ data: { tenantId: a, patientId: patient.id, doctorId: doctor.id, startsAt: new Date(noon.getTime() - 3 * 24 * HOUR), endsAt: new Date(noon.getTime() - 3 * 24 * HOUR + 30 * 60_000), status: "NO_SHOW" } });

      const link = await db.intakeLink.create({ data: { tenantId: a, tokenHash: randomBytes(16).toString("hex"), tokenPrefix: "test", expiresAt: new Date(now.getTime() + 24 * HOUR) } });
      await db.intakeSubmission.create({ data: { tenantId: a, linkId: link.id, status: "PENDING", fullName: "New Face", data: {} } });
      await db.intakeSubmission.create({ data: { tenantId: a, linkId: link.id, status: "ACCEPTED", fullName: "Old Face", data: {} } });

      await notify(a, { kind: "ESCALATION", level: "CRITICAL", title: "Critical for owner", userIds: [owner.id] });
    });

    it("gives the owner the whole clinic, oldest escalation target flagged as overdue", async () => {
      const res = await attentionRoute(request("/api/notifications/attention", { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const json = await res.json();
      const by = Object.fromEntries((json.items as Item[]).map((i) => [i.key, i]));
      expect(Object.keys(by)).toEqual(["escalations", "followUps", "reviewPending", "noShows", "intake", "unread"]);
      expect(by.escalations).toMatchObject({ count: 2, tone: "danger", href: "/dashboard/concierge", due: { overdue: true } });
      expect(by.escalations!.detail).toContain("1 not yet acknowledged");
      expect(by.escalations!.detail).toContain("overdue");
      expect(by.followUps).toMatchObject({ count: 1, href: "/dashboard/leads?tab=follow-ups", tone: "warning" });
      expect(by.reviewPending).toMatchObject({ count: 2, href: "/dashboard/consultations" });
      expect(by.noShows).toMatchObject({ count: 1 });
      expect(by.noShows!.href).toMatch(/^\/dashboard\/appointments\?date=\d{4}-\d{2}-\d{2}$/);
      expect(by.intake).toMatchObject({ count: 1, href: "/dashboard/patients/intake" });
      const unread = await db.notification.count({ where: { tenantId: a, userId: owner.id, readAt: null } });
      expect(by.unread).toMatchObject({ count: unread, tone: "danger", href: "/dashboard/notifications" });
      expect(json.total).toBe(2 + 1 + 2 + 1 + 1 + unread);
      expect(json.timezone).toBe(TZ);
    });

    it("limits the desk to its queue and the doctor to their own escalations and drafts", async () => {
      const deskJson = await (await attentionRoute(request("/api/notifications/attention", { cookie: deskCookie }))).json();
      const deskKeys = (deskJson.items as Item[]).map((i) => i.key);
      expect(deskKeys).toEqual(["followUps", "noShows", "intake", "unread"]);
      expect((deskJson.items as Item[]).find((i) => i.key === "followUps")).toMatchObject({ count: 1 });

      const docJson = await (await attentionRoute(request("/api/notifications/attention", { cookie: doctorCookie }))).json();
      const by = Object.fromEntries((docJson.items as Item[]).map((i) => [i.key, i]));
      expect(by.escalations).toMatchObject({ count: 1, tone: "danger" });
      expect(by.escalations!.label).toContain("assigned to you");
      expect(by.reviewPending).toMatchObject({ count: 1 });
      expect(by.followUps).toBeUndefined();
      expect(by.noShows).toBeUndefined();
      expect(by.intake).toBeUndefined();
    });

    it("is calm for a clinic with nothing open, and unauthenticated calls get 401", async () => {
      const json = await (await attentionRoute(request("/api/notifications/attention", { cookie: ownerCCookie }))).json();
      expect(json).toMatchObject({ items: [], total: 0 });
      expect((await attentionRoute(request("/api/notifications/attention"))).status).toBe(401);
    });
  });
});
