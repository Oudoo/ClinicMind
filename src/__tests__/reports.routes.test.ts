/**
 * Reports over the real route handlers and the test database: a small clinic
 * with known activity in March 2026 (leads, consultations, a signed transplant
 * with its money, a conversation, a campaign with its cost, an overdue
 * follow-up and escalation) so every one of the thirteen metrics can be
 * asserted for a period; revenue redaction for roles without finance:read;
 * the per-metric CSV export; targets; alert rules with the at-most-once-a-day
 * firing; review snapshots and the weekly brief. RBAC, validation and tenant
 * isolation on every endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { evaluateAlertRules, FIRE_INTERVAL_MS } from "@/modules/reporting/alerts";
import { METRIC_IDS } from "@/modules/reporting/definitions";
import { GET as reportRoute } from "@/app/api/reports/route";
import { GET as exportRoute } from "@/app/api/reports/export/route";
import { GET as briefRoute } from "@/app/api/reports/brief/route";
import { GET as targetsRoute, PUT as putTargetRoute } from "@/app/api/reports/targets/route";
import { GET as rulesRoute, POST as createRuleRoute } from "@/app/api/alert-rules/route";
import { PATCH as patchRuleRoute } from "@/app/api/alert-rules/[id]/route";
import { POST as evaluateRoute } from "@/app/api/alert-rules/evaluate/route";
import { GET as snapshotsRoute, POST as snapshotRoute } from "@/app/api/reviews/snapshots/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

// Setup and checks call the services directly; the routes enter their own request scope.
runAsSystem();

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MARCH = "period=custom&from=2026-03-01&to=2026-03-31";
const at = (iso: string) => new Date(iso);

describe.skipIf(!dbTestsEnabled)("reports routes", () => {
  const created: string[] = [];
  let r: string;
  let other: string;
  let owner: { id: string };
  let doctor: { id: string };
  let ownerCookie: string;
  let doctorCookie: string;
  let receptionCookie: string;
  let otherCookie: string;
  let otherRule: string;

  beforeAll(async () => {
    const tenant = await createTenant({ slug: `rep-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `rep-b-${Date.now().toString(36)}` });
    r = tenant.id;
    other = tenantB.id;
    created.push(r, other);
    owner = await createUser({ tenantId: r, role: "CLINIC_OWNER", fullName: "Owner R" });
    doctor = await createUser({ tenantId: r, role: "DOCTOR", fullName: "Dr. Salma" });
    const reception = await createUser({ tenantId: r, role: "RECEPTIONIST", fullName: "Desk R" });
    const otherOwner = await createUser({ tenantId: other, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    receptionCookie = await sessionCookieFor(reception.id);
    otherCookie = await sessionCookieFor(otherOwner.id);
    await ensureDefaultTreatments(r);
    const hair = await db.treatment.findFirstOrThrow({ where: { tenantId: r, key: "hair-transplant" } });

    const [p1, p2] = await Promise.all([
      db.patient.create({ data: { tenantId: r, fullName: "Karim Adel", source: "CLICK_TO_WHATSAPP_AD" } }),
      db.patient.create({ data: { tenantId: r, fullName: "Sara Nabil", source: "REFERRAL" } }),
    ]);
    const campaign = await db.campaign.create({ data: { tenantId: r, externalId: "meta-ht", name: "Meta · Hair transplant", platform: "META", treatmentId: hair.id } });
    await db.campaignCost.create({ data: { tenantId: r, campaignId: campaign.id, periodStart: at("2026-03-01T00:00:00Z"), periodEnd: at("2026-03-31T00:00:00Z"), amount: 3_100 } });

    const appt = (id: string, patientId: string, kind: "CONSULTATION" | "PROCEDURE", status: "COMPLETED" | "NO_SHOW", startsAt: string, extra: Record<string, unknown> = {}) =>
      db.appointment.create({ data: { id: `${id}-${r}`, tenantId: r, patientId, doctorId: doctor.id, kind, status, startsAt: at(startsAt), endsAt: new Date(at(startsAt).getTime() + HOUR), ...extra } });
    const c1 = await appt("c1", p1.id, "CONSULTATION", "COMPLETED", "2026-03-05T10:00:00Z", { treatmentId: hair.id });
    await appt("a2", p2.id, "CONSULTATION", "NO_SHOW", "2026-03-06T10:00:00Z");
    const a3 = await appt("a3", p1.id, "PROCEDURE", "COMPLETED", "2026-03-12T10:00:00Z");

    const l1 = await db.lead.create({
      data: { tenantId: r, fullName: "Karim Adel", source: "CLICK_TO_WHATSAPP_AD", campaignId: campaign.id, interests: ["hair-transplant", "prp-hair"], patientId: p1.id, consultationAppointmentId: c1.id, stage: "WON", wonAt: at("2026-03-12T12:00:00Z"), createdAt: at("2026-03-02T09:00:00Z") },
    });
    await db.appointment.update({ where: { id: c1.id }, data: { leadId: l1.id } });
    await db.lead.create({
      data: { tenantId: r, fullName: "Nour Ali", source: "WEBSITE", interests: ["acne"], stage: "LOST", lostReason: "PRICE", lostAtStage: "CONTACTED", lostAt: at("2026-03-10T12:00:00Z"), objections: ["PRICE"], createdAt: at("2026-03-03T09:00:00Z") },
    });
    const l3 = await db.lead.create({ data: { tenantId: r, fullName: "Hany Fouad", source: "REFERRAL", interests: [], createdAt: at("2026-03-04T09:00:00Z") } });

    const procedure = await db.procedure.create({
      data: { tenantId: r, patientId: p1.id, treatmentId: hair.id, doctorId: doctor.id, appointmentId: a3.id, performedAt: a3.startsAt, price: 60_000, status: "SIGNED", signedAt: a3.endsAt, signedById: doctor.id },
    });
    await db.payment.createMany({
      data: [
        { tenantId: r, patientId: p1.id, procedureId: procedure.id, appointmentId: a3.id, kind: "DEPOSIT", method: "BANK_TRANSFER", amount: 5_000, paidAt: at("2026-03-08T10:00:00Z") },
        { tenantId: r, patientId: p1.id, procedureId: procedure.id, kind: "PAYMENT", method: "CARD", amount: 55_000, paidAt: at("2026-03-12T12:00:00Z") },
        { tenantId: r, patientId: p1.id, appointmentId: c1.id, kind: "CONSULTATION_FEE", method: "CASH", amount: 500, paidAt: at("2026-03-05T09:55:00Z") },
      ],
    });
    await db.conversation.create({
      data: {
        tenantId: r,
        patientId: p1.id,
        leadId: l1.id,
        channel: "WHATSAPP",
        objections: ["PRICE"],
        createdAt: at("2026-03-02T09:00:00Z"),
        messages: {
          create: [
            { tenantId: r, direction: "INBOUND", author: "PATIENT", body: "How much is a transplant?", createdAt: at("2026-03-02T09:00:00Z") },
            { tenantId: r, direction: "INBOUND", author: "PATIENT", body: "And do you do PRP?", createdAt: at("2026-03-02T09:00:20Z") },
            { tenantId: r, direction: "OUTBOUND", author: "AI", body: "Hello! A transplant is 45,000–90,000 EGP…", createdAt: at("2026-03-02T09:00:40Z") },
          ],
        },
      },
    });
    const now = Date.now();
    await db.leadFollowUp.create({ data: { tenantId: r, leadId: l3.id, ownerId: reception.id, dueAt: new Date(now - DAY), note: "Call back" } });
    await db.escalation.create({ data: { tenantId: r, kind: "CONCIERGE", level: "HIGH_RISK", status: "OPEN", patientId: p1.id, summary: "Fever on day 3", assignedToId: doctor.id, dueAt: new Date(now - 2 * HOUR) } });
    // An escalation raised for the overdue follow-up is the same item: not counted twice.
    await db.escalation.create({ data: { tenantId: r, kind: "LEAD_FOLLOW_UP", status: "OPEN", leadId: l3.id, summary: "Follow-up overdue", dueAt: new Date(now - HOUR) } });
    await db.reviewSnapshot.create({ data: { tenantId: r, source: "MANUAL", weekStart: at("2026-02-28T00:00:00Z"), count: 120, rating: 4.7 } });

    otherRule = (await db.alertRule.create({ data: { tenantId: other, name: "B's rule", metric: "NO_SHOW_RATE", comparator: "ABOVE", threshold: 10 } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  const report = async (query: string, cookie = ownerCookie) => {
    const res = await reportRoute(request(`/api/reports?${query}`, { cookie }));
    return { res, json: await res.json() };
  };

  describe("GET /api/reports", () => {
    it("returns all thirteen metrics for the period and the period before", async () => {
      const { res, json } = await report(MARCH);
      expect(res.status).toBe(200);
      const rep = json.report;
      expect(rep.period).toMatchObject({ preset: "custom", fromKey: "2026-03-01", toKey: "2026-03-31", days: 31 });
      expect(rep.previous).toMatchObject({ fromKey: "2026-01-29", toKey: "2026-02-28" });
      for (const id of METRIC_IDS) {
        const m = rep[id.toLowerCase()];
        expect(m, id).toBeTruthy();
        if (id !== "M12") expect(Object.keys(m), id).toEqual(expect.arrayContaining(["current", "previous"]));
      }
      const { m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13 } = rep;
      expect(m1.current).toMatchObject({ leads: 3, multiInterest: 1 });
      expect(m1.current.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: "hair-transplant", count: 1 }), expect.objectContaining({ key: "unspecified", count: 1 })]));
      expect(m1.previous.leads).toBe(0);
      expect(m2.current).toMatchObject({ leads: 3, converted: 1 });
      expect(m2.current.rate).toBeCloseTo(1 / 3);
      expect(m2.current.consultationAt).toBeUndefined();
      expect(m3.current).toMatchObject({ consultations: 1, converted: 1, rate: 1 });
      expect(m3.current.byTreatment).toEqual([expect.objectContaining({ key: "hair-transplant", total: 1, converted: 1 })]);
      expect(m4.current).toMatchObject({ revenue: 60_000, procedures: 1, deposits: 5_000, refunds: 0, consultationFees: 500 });
      expect(m4.current.byDoctor[0]).toMatchObject({ key: doctor.id, label: "Dr. Salma", revenue: 60_000 });
      expect(m5.current).toMatchObject({ n: 1, p50: 40, p90: 40, unanswered: 0, ai: { n: 1, p50: 40 }, human: { n: 0 } });
      expect(m6.current).toMatchObject({ booked: 3, noShows: 1 });
      expect(m6.current.byDeposit).toEqual([
        expect.objectContaining({ key: "deposit", total: 1, converted: 0 }),
        expect.objectContaining({ key: "none", total: 2, converted: 1 }),
      ]);
      expect(m7.current.lost).toBe(1);
      expect(m7.current.byReason.find((x: { key: string }) => x.key === "PRICE").count).toBe(1);
      expect(m8.current).toMatchObject({ conversations: 1, taggedConversations: 1, closedLeads: 2 });
      expect(m8.current.items[0]).toMatchObject({ key: "PRICE", aiCount: 1, aiShare: 1, staffCount: 1, staffShare: 0.5 });
      expect(m9.current).toMatchObject({ leads: 1, bySource: [{ key: "CLICK_TO_WHATSAPP_AD", label: "Click-to-WhatsApp ad", count: 1 }] });
      expect(m10.current).toMatchObject({ cohort: 0, returned: 0, rate: null });
      expect(m11.current.overall).toEqual({ avg: null, n: 0 });
      expect(m11.reviews.latest).toMatchObject({ count: 120, rating: 4.7 });
      expect(m12).toMatchObject({ followUps: 1, escalations: 1 });
      expect(m12.byOwner.map((o: { label: string }) => o.label).sort()).toEqual(["Desk R", "Dr. Salma"]);
      expect(m13.current.items).toEqual([
        expect.objectContaining({ label: "Meta · Hair transplant", leads: 1, consultations: 1, procedures: 1, revenue: 60_000, cost: 3_100, costPerLead: 3_100, costPerProcedure: 3_100 }),
      ]);
      expect(rep.redacted).toBe(false);
    });

    it("applies the doctor, treatment and source filters from the query", async () => {
      expect((await report(`${MARCH}&source=WEBSITE`)).json.report.m1.current.leads).toBe(1);
      expect((await report(`${MARCH}&treatment=hair-transplant`)).json.report.m1.current).toMatchObject({ leads: 1, items: [{ key: "hair-transplant", count: 1 }] });
      const other = await report(`${MARCH}&doctorId=${owner.id}`);
      expect(other.json.report.m3.current.consultations).toBe(0);
      expect(other.json.report.m4.current.revenue).toBe(0);
      // An unknown value is dropped instead of failing the page.
      const tolerant = await report(`${MARCH}&source=SOMEWHERE&period=forever`);
      expect(tolerant.res.status).toBe(200);
    });

    it("strips revenue for roles without finance:read and refuses roles without reports:read", async () => {
      const { res, json } = await report(MARCH, doctorCookie);
      expect(res.status).toBe(200);
      expect(json.report.redacted).toBe(true);
      expect(json.report.m4).toBeNull();
      expect(json.report.m13.current.items[0]).toMatchObject({ procedures: 1, revenue: 0, cost: 0, costPerProcedure: null });
      expect((await report(MARCH, receptionCookie)).res.status).toBe(403);
      expect((await reportRoute(request(`/api/reports?${MARCH}`))).status).toBe(401);
    });

    it("never shows another clinic's activity", async () => {
      const { json } = await report(MARCH, otherCookie);
      expect(json.report.m1.current.leads).toBe(0);
      expect(json.report.m4.current.revenue).toBe(0);
      expect(json.report.m12).toMatchObject({ followUps: 0, escalations: 0 });
      expect(json.report.m13.current.items).toEqual([]);
    });
  });

  describe("CSV export", () => {
    it("exports one metric table exactly as shown, with units in the headers", async () => {
      const res = await exportRoute(request(`/api/reports/export?metric=M2&part=source&${MARCH}`, { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="M2-source-2026-03-01-to-2026-03-31.csv"');
      const lines = (await res.text()).trim().split("\r\n");
      expect(lines[0]).toBe("Source,Leads,Attended,Rate (%),Previous (%)");
      expect(lines).toContain("Click-to-WhatsApp ad,1,1,100,");
      expect(lines).toContain("Website,1,0,0,");
      const m13 = await (await exportRoute(request(`/api/reports/export?metric=M13&${MARCH}`, { cookie: ownerCookie }))).text();
      expect(m13).toContain("Meta · Hair transplant,META,1,1,1,60000,3100,3100,3100");
    });

    it("keeps revenue tables owner only and validates the metric and part", async () => {
      expect((await exportRoute(request(`/api/reports/export?metric=M4&part=doctor&${MARCH}`, { cookie: doctorCookie }))).status).toBe(403);
      expect((await exportRoute(request(`/api/reports/export?metric=M4&part=doctor&${MARCH}`, { cookie: ownerCookie }))).status).toBe(200);
      expect((await exportRoute(request(`/api/reports/export?metric=M99&${MARCH}`, { cookie: ownerCookie }))).status).toBe(422);
      expect((await exportRoute(request(`/api/reports/export?metric=M2&part=nothing&${MARCH}`, { cookie: ownerCookie }))).status).toBe(404);
      expect((await exportRoute(request(`/api/reports/export?metric=M2&${MARCH}`, { cookie: receptionCookie }))).status).toBe(403);
      // A doctor's M13 export carries no money.
      const doctorM13 = await (await exportRoute(request(`/api/reports/export?metric=M13&${MARCH}`, { cookie: doctorCookie }))).text();
      expect(doctorM13).toContain("Meta · Hair transplant,META,1,1,1,,,,");
    });
  });

  describe("targets", () => {
    it("lists the thirteen metrics with the current value and lets the owner set a target", async () => {
      const put = await putTargetRoute(request("/api/reports/targets", { method: "PUT", cookie: ownerCookie, body: { metric: "M6", baseline: 12, target: 8, unit: "%", dueAt: "2026-12-31" } }));
      expect(put.status).toBe(200);
      expect((await put.json()).target).toMatchObject({ metric: "M6", baseline: 12, target: 8, unit: "%" });
      expect(await db.auditLog.count({ where: { tenantId: r, action: "metric_target.upsert" } })).toBe(1);
      const res = await targetsRoute(request(`/api/reports/targets?${MARCH}`, { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      const { targets } = await res.json();
      expect(targets.map((t: { metric: string }) => t.metric)).toEqual([...METRIC_IDS]);
      expect(targets.find((t: { metric: string }) => t.metric === "M6")).toMatchObject({ target: 8, current: 33.3, goodWhen: "down", onTrack: false });
    });

    it("refuses other roles (403) and bad input (422); a doctor does not see revenue targets", async () => {
      expect((await putTargetRoute(request("/api/reports/targets", { method: "PUT", cookie: doctorCookie, body: { metric: "M6", baseline: 1, target: 1, unit: null, dueAt: null } }))).status).toBe(403);
      expect((await putTargetRoute(request("/api/reports/targets", { method: "PUT", cookie: ownerCookie, body: { metric: "M99", baseline: 1, target: 1, unit: null, dueAt: null } }))).status).toBe(422);
      await putTargetRoute(request("/api/reports/targets", { method: "PUT", cookie: ownerCookie, body: { metric: "M4", baseline: 100_000, target: 150_000, unit: "EGP", dueAt: null } }));
      const { targets } = await (await targetsRoute(request(`/api/reports/targets?${MARCH}`, { cookie: doctorCookie }))).json();
      expect(targets.find((t: { metric: string }) => t.metric === "M4")).toMatchObject({ baseline: null, target: null, current: null });
    });
  });

  describe("alert rules", () => {
    let rule: string;

    it("lets the owner add, edit and disable rules; others read them", async () => {
      const res = await createRuleRoute(request("/api/alert-rules", { method: "POST", cookie: ownerCookie, body: { name: "Overdue piling up", metric: "FOLLOW_UPS_OVERDUE", comparator: "ABOVE", threshold: 1, windowDays: 1 } }));
      expect(res.status).toBe(201);
      rule = (await res.json()).rule.id;
      expect((await createRuleRoute(request("/api/alert-rules", { method: "POST", cookie: doctorCookie, body: { name: "x", metric: "NO_SHOW_RATE", comparator: "ABOVE", threshold: 1 } }))).status).toBe(403);
      expect((await createRuleRoute(request("/api/alert-rules", { method: "POST", cookie: ownerCookie, body: { name: "", metric: "NOPE", comparator: "ABOVE", threshold: 1 } }))).status).toBe(422);
      expect((await patchRuleRoute(request(`/api/alert-rules/${rule}`, { method: "PATCH", cookie: ownerCookie, body: { comparator: "SIDEWAYS" } }), params(rule))).status).toBe(422);
      expect((await patchRuleRoute(request(`/api/alert-rules/${otherRule}`, { method: "PATCH", cookie: ownerCookie, body: { enabled: false } }), params(otherRule))).status).toBe(404);
      const list = await rulesRoute(request("/api/alert-rules", { cookie: doctorCookie }));
      expect(list.status).toBe(200);
      expect((await list.json()).rules.map((x: { id: string }) => x.id)).toEqual([rule]);
    });

    it("fires a rule at most once in 24 hours, and stores every evaluation", async () => {
      const t0 = new Date();
      const first = await evaluateAlertRules(r, t0);
      expect(first).toEqual([expect.objectContaining({ id: rule, value: 2, fired: true, notified: true })]);
      const notes = () => db.notification.count({ where: { tenantId: r, kind: "ALERT_RULE", userId: owner.id } });
      expect(await notes()).toBe(1);
      const second = await evaluateAlertRules(r, new Date(t0.getTime() + HOUR));
      expect(second[0]).toMatchObject({ fired: true, notified: false });
      expect(await notes()).toBe(1);
      const stored = await db.alertRule.findUniqueOrThrow({ where: { id: rule } });
      expect(stored).toMatchObject({ lastValue: 2, lastFiredAt: t0, lastEvaluatedAt: new Date(t0.getTime() + HOUR) });
      const third = await evaluateAlertRules(r, new Date(t0.getTime() + FIRE_INTERVAL_MS + HOUR));
      expect(third[0]).toMatchObject({ fired: true, notified: true });
      expect(await notes()).toBe(2);
    });

    it("does not fire under the threshold, skips disabled rules, and runs on demand for the owner", async () => {
      await patchRuleRoute(request(`/api/alert-rules/${rule}`, { method: "PATCH", cookie: ownerCookie, body: { threshold: 5 } }), params(rule));
      const res = await evaluateRoute(request("/api/alert-rules/evaluate", { method: "POST", cookie: ownerCookie }));
      expect(res.status).toBe(200);
      expect((await res.json()).results).toEqual([expect.objectContaining({ id: rule, value: 2, fired: false, notified: false })]);
      await patchRuleRoute(request(`/api/alert-rules/${rule}`, { method: "PATCH", cookie: ownerCookie, body: { enabled: false } }), params(rule));
      expect(await evaluateAlertRules(r, new Date())).toEqual([]);
      expect((await evaluateRoute(request("/api/alert-rules/evaluate", { method: "POST", cookie: doctorCookie }))).status).toBe(403);
    });
  });

  describe("reviews and the weekly brief", () => {
    it("records a week's review count by hand, replacing the same week (owner only)", async () => {
      const first = await snapshotRoute(request("/api/reviews/snapshots", { method: "POST", cookie: ownerCookie, body: { weekStart: "2026-03-07", count: 124, rating: 4.7 } }));
      expect(first.status).toBe(201);
      const again = await snapshotRoute(request("/api/reviews/snapshots", { method: "POST", cookie: ownerCookie, body: { weekStart: "2026-03-08", count: 125, rating: 4.8 } }));
      expect(again.status).toBe(201);
      const rows = await db.reviewSnapshot.findMany({ where: { tenantId: r, weekStart: at("2026-03-07T00:00:00Z") } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ count: 125, rating: 4.8, source: "MANUAL" });
      expect((await snapshotRoute(request("/api/reviews/snapshots", { method: "POST", cookie: ownerCookie, body: { weekStart: "2026-03-07", count: 1, rating: 6 } }))).status).toBe(422);
      expect((await snapshotRoute(request("/api/reviews/snapshots", { method: "POST", cookie: doctorCookie, body: { weekStart: "2026-03-07", count: 1, rating: 4 } }))).status).toBe(403);
      const list = await (await snapshotsRoute(request("/api/reviews/snapshots", { cookie: doctorCookie }))).json();
      expect(list.snapshots.map((s: { count: number }) => s.count)).toEqual([125, 120]);
    });

    it("builds the weekly brief for readers of the reports", async () => {
      const res = await briefRoute(request("/api/reports/brief", { cookie: doctorCookie }));
      expect(res.status).toBe(200);
      const { brief, state } = await res.json();
      expect(brief.weekKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(brief.text.split("\n")[0]).toMatch(/^Week \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} against/);
      expect(brief.lines.every((l: { finance: boolean }) => !l.finance)).toBe(true);
      expect(state).toEqual({ sentWeek: null, sentAt: null });
      expect((await briefRoute(request("/api/reports/brief", { cookie: receptionCookie }))).status).toBe(403);
    });
  });
});
