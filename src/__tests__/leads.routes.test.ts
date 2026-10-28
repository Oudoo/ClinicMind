/**
 * CRM over the real route handlers and the test database: lead CRUD and
 * search, the pipeline's stage rules, losing and reopening, conversion,
 * consultation booking through the appointments service, follow-ups with the
 * overdue sweep (notification + escalation, idempotent), campaigns with costs
 * and the CSV import, RBAC and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { GET as listRoute, POST as createRoute } from "@/app/api/leads/route";
import { GET as getRoute, PATCH as patchRoute } from "@/app/api/leads/[id]/route";
import { POST as stageRoute } from "@/app/api/leads/[id]/stage/route";
import { POST as lostRoute } from "@/app/api/leads/[id]/lost/route";
import { POST as reopenRoute } from "@/app/api/leads/[id]/reopen/route";
import { POST as convertRoute } from "@/app/api/leads/[id]/convert/route";
import { POST as bookRoute } from "@/app/api/leads/[id]/book/route";
import { GET as leadFollowUpsRoute, POST as createFollowUpRoute } from "@/app/api/leads/[id]/follow-ups/route";
import { GET as followUpsRoute } from "@/app/api/leads/follow-ups/route";
import { POST as completeRoute } from "@/app/api/leads/follow-ups/[id]/complete/route";
import { GET as campaignsRoute, POST as createCampaignRoute } from "@/app/api/campaigns/route";
import { PATCH as patchCampaignRoute } from "@/app/api/campaigns/[id]/route";
import { POST as costRoute } from "@/app/api/campaigns/[id]/costs/route";
import { POST as importRoute } from "@/app/api/campaigns/[id]/costs/import/route";
import { parseCostCsv, sweepTenantFollowUps } from "@/modules/crm/service";
import { canMoveStage, normalisePhone } from "@/modules/crm/shared";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("pipeline rules (pure)", () => {
  it("allows forward moves of any distance and one step back, never into or out of LOST or WON", () => {
    expect(canMoveStage("NEW", "QUALIFIED").ok).toBe(true);
    expect(canMoveStage("NEW", "WON").ok).toBe(true);
    expect(canMoveStage("QUALIFIED", "CONTACTED").ok).toBe(true);
    expect(canMoveStage("QUALIFIED", "NEW").ok).toBe(false);
    expect(canMoveStage("NEW", "LOST").ok).toBe(false);
    expect(canMoveStage("LOST", "NEW").ok).toBe(false);
    expect(canMoveStage("WON", "PROCEDURE_BOOKED").ok).toBe(false);
    expect(canMoveStage("NEW", "NEW").ok).toBe(false);
  });

  it("normalises Egyptian phone numbers to E.164", () => {
    expect(normalisePhone("0100 123 4567")).toBe("+201001234567");
    expect(normalisePhone("01001234567")).toBe("+201001234567");
    expect(normalisePhone("201001234567")).toBe("+201001234567");
    expect(normalisePhone("+20 (100) 123-4567")).toBe("+201001234567");
    expect(normalisePhone("00201001234567")).toBe("+201001234567");
    expect(normalisePhone("+966501234567")).toBe("+966501234567");
  });

  it("parses the costs CSV with a header and reports bad lines", () => {
    const { rows, errors } = parseCostCsv("periodStart,periodEnd,amount\n2026-09-01,2026-09-30,12000\n2026-10-01,2026-10-31,abc\n2026-11-01,2026-10-01,10\n");
    expect(rows).toEqual([{ line: 2, periodStart: "2026-09-01", periodEnd: "2026-09-30", amount: 12000 }]);
    expect(errors.map((e) => e.line)).toEqual([3, 4]);
  });
});

describe.skipIf(!dbTestsEnabled)("leads", () => {
  const created: string[] = [];
  let a: { id: string };
  let b: { id: string };
  let ownerA: { id: string };
  let receptionA: { id: string };
  let doctorA: { id: string };
  let ownerCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let nurseCookie: string;
  let doctorCookie: string;
  let ownerBCookie: string;
  let patientA: string;
  let patientB: string;
  let campaignA: string;
  let campaignB: string;

  async function post(path: string, route: (req: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>, id: string, body: unknown, cookie = ownerCookie) {
    const res = await route(request(path, { method: "POST", cookie, body }), params(id));
    return { res, json: await res.json() };
  }

  async function createLead(body: Record<string, unknown>, cookie = ownerCookie) {
    const res = await createRoute(request("/api/leads", { method: "POST", cookie, body }));
    return { res, json: await res.json() };
  }

  async function lead(body: Record<string, unknown> = {}) {
    const { res, json } = await createLead({ fullName: "Test Lead", phone: "01000000001", source: "WEBSITE", ...body });
    expect(res.status).toBe(201);
    return json.lead as { id: string; stage: string; phone: string };
  }

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `crm-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `crm-b-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA;
    b = tenantB;
    ownerA = await createUser({ tenantId: a.id, role: "CLINIC_OWNER", fullName: "Owner A" });
    receptionA = await createUser({ tenantId: a.id, role: "RECEPTIONIST", fullName: "Desk A" });
    doctorA = await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr. Amina" });
    const assistant = await createUser({ tenantId: a.id, role: "ASSISTANT", fullName: "Assistant A" });
    const nurse = await createUser({ tenantId: a.id, role: "NURSE", fullName: "Nurse A" });
    const ownerB = await createUser({ tenantId: b.id, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(ownerA.id);
    receptionCookie = await sessionCookieFor(receptionA.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    nurseCookie = await sessionCookieFor(nurse.id);
    doctorCookie = await sessionCookieFor(doctorA.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    patientA = (await db.patient.create({ data: { tenantId: a.id, fullName: "Existing Patient", phone: "+201055555555" } })).id;
    patientB = (await db.patient.create({ data: { tenantId: b.id, fullName: "Patient Of B" } })).id;
    campaignA = (await db.campaign.create({ data: { tenantId: a.id, externalId: "camp-a-1", name: "Meta · Hair", platform: "META" } })).id;
    campaignB = (await db.campaign.create({ data: { tenantId: b.id, externalId: "camp-b-1", name: "Meta · B", platform: "META" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("create, read, update", () => {
    it("creates a lead with a normalised phone, interests, campaign and owner, audits it and tells the receptionist", async () => {
      const { res, json } = await createLead({
        fullName: "Mona Adel",
        phone: "0100 123 4567",
        email: "MONA@example.com",
        source: "CLICK_TO_WHATSAPP_AD",
        campaignId: campaignA,
        interests: ["hair-transplant", "prp-hair"],
        ownerId: receptionA.id,
        notes: "Asked about FUE",
      });
      expect(res.status).toBe(201);
      expect(json.lead).toMatchObject({
        fullName: "Mona Adel",
        phone: "+201001234567",
        whatsapp: "+201001234567",
        email: "mona@example.com",
        stage: "NEW",
        source: "CLICK_TO_WHATSAPP_AD",
        interests: ["hair-transplant", "prp-hair"],
        campaign: { id: campaignA, name: "Meta · Hair" },
        owner: { id: receptionA.id, fullName: "Desk A" },
      });
      const audits = await db.auditLog.findMany({ where: { tenantId: a.id, entity: "Lead", entityId: json.lead.id } });
      expect(audits.map((x) => x.action)).toEqual(["lead.create"]);
      const notes = await db.notification.findMany({ where: { tenantId: a.id, kind: "LEAD_NEW", entityId: json.lead.id } });
      expect(notes.map((n) => n.userId).sort()).toEqual([receptionA.id]);
    });

    it("rejects an unknown interest with 422 and foreign campaign / owner ids with 404", async () => {
      const bad = await createLead({ fullName: "X", interests: ["unicorn-therapy"] });
      expect(bad.res.status).toBe(422);
      expect(bad.json.issues.fieldErrors.interests[0]).toMatch(/unicorn-therapy/);
      const foreignCampaign = await createLead({ fullName: "X", campaignId: campaignB });
      expect(foreignCampaign.res.status).toBe(404);
      const foreignOwner = await createLead({ fullName: "X", ownerId: (await db.user.findFirst({ where: { tenantId: b.id } }))!.id });
      expect(foreignOwner.res.status).toBe(404);
      const noName = await createLead({ fullName: "" });
      expect(noName.res.status).toBe(422);
    });

    it("lists with search, stage, source, interest and campaign filters, paged and sorted", async () => {
      await lead({ fullName: "Zeinab Search", phone: "01099988877", source: "REFERRAL", interests: ["acne"] });
      const byName = await listRoute(request("/api/leads?q=zeinab", { cookie: ownerCookie }));
      const byNameJson = await byName.json();
      expect(byName.status).toBe(200);
      expect(byNameJson.leads.map((l: { fullName: string }) => l.fullName)).toContain("Zeinab Search");
      const byPhone = await (await listRoute(request("/api/leads?q=0109998", { cookie: ownerCookie }))).json();
      expect(byPhone.leads.map((l: { fullName: string }) => l.fullName)).toEqual(["Zeinab Search"]);
      const bySource = await (await listRoute(request("/api/leads?source=REFERRAL&interest=acne", { cookie: ownerCookie }))).json();
      expect(bySource.leads.every((l: { source: string }) => l.source === "REFERRAL")).toBe(true);
      expect(bySource.total).toBeGreaterThanOrEqual(1);
      const paged = await (await listRoute(request("/api/leads?page=1&pageSize=1&sort=oldest", { cookie: ownerCookie }))).json();
      expect(paged.leads).toHaveLength(1);
      expect(paged.pageSize).toBe(1);
      expect(paged.total).toBeGreaterThanOrEqual(2);
      const badStage = await listRoute(request("/api/leads?stage=NOPE", { cookie: ownerCookie }));
      expect(badStage.status).toBe(422);
    });

    it("returns the lead with follow-ups, conversations and patient; updates and clears fields; foreign ids are 404", async () => {
      const l = await lead({ fullName: "Detail Lead", email: "d@example.com" });
      const got = await getRoute(request(`/api/leads/${l.id}`, { cookie: assistantCookie }), params(l.id));
      expect(got.status).toBe(200);
      const body = await got.json();
      expect(body.lead).toMatchObject({ id: l.id, followUps: [], conversations: [], patient: null, interestNames: [] });
      const patched = await patchRoute(request(`/api/leads/${l.id}`, { method: "PATCH", cookie: receptionCookie, body: { email: "", notes: "updated", ownerId: receptionA.id } }), params(l.id));
      expect(patched.status).toBe(200);
      expect((await patched.json()).lead).toMatchObject({ email: null, owner: { id: receptionA.id } });
      const foreign = await getRoute(request(`/api/leads/${l.id}`, { cookie: ownerBCookie }), params(l.id));
      expect(foreign.status).toBe(404);
      const foreignPatch = await patchRoute(request(`/api/leads/${l.id}`, { method: "PATCH", cookie: ownerBCookie, body: { notes: "x" } }), params(l.id));
      expect(foreignPatch.status).toBe(404);
    });
  });

  describe("stages", () => {
    it("moves forward (stamping lastContactAt and wonAt), steps back one, and refuses the other moves with 409", async () => {
      const l = await lead();
      const q = await post("/api/leads/x/stage", stageRoute, l.id, { stage: "QUALIFIED" });
      expect(q.res.status).toBe(200);
      expect(q.json.lead.stage).toBe("QUALIFIED");
      expect(q.json.lead.lastContactAt).toBeTruthy();
      const back = await post("/api/leads/x/stage", stageRoute, l.id, { stage: "CONTACTED" });
      expect(back.res.status).toBe(200);
      const twoBack = await post("/api/leads/x/stage", stageRoute, l.id, { stage: "QUALIFIED" });
      expect(twoBack.res.status).toBe(200);
      const tooFar = await post("/api/leads/x/stage", stageRoute, l.id, { stage: "NEW" });
      expect(tooFar.res.status).toBe(409);
      expect(tooFar.json.error).toBe("invalid_stage");
      const viaStage = await post("/api/leads/x/stage", stageRoute, l.id, { stage: "LOST" });
      expect(viaStage.res.status).toBe(409);
      const won = await post("/api/leads/x/stage", stageRoute, l.id, { stage: "WON" });
      expect(won.res.status).toBe(200);
      expect(won.json.lead.wonAt).toBeTruthy();
      const afterWon = await post("/api/leads/x/stage", stageRoute, l.id, { stage: "PROCEDURE_BOOKED" });
      expect(afterWon.res.status).toBe(409);
      const invalid = await post("/api/leads/x/stage", stageRoute, l.id, { stage: "MAYBE" });
      expect(invalid.res.status).toBe(422);
    });

    it("marks lost with a reason, the stage it was in and objections, closes open follow-ups; reopen restores the stage", async () => {
      const l = await lead();
      await post("/api/leads/x/stage", stageRoute, l.id, { stage: "QUALIFIED" });
      const fu = await post("/api/leads/x/follow-ups", createFollowUpRoute, l.id, { dueAt: new Date(Date.now() + DAY).toISOString(), note: "call back" });
      expect(fu.res.status).toBe(201);
      const lost = await post("/api/leads/x/lost", lostRoute, l.id, { reason: "PRICE", note: "Too expensive for now", objections: ["PRICE", "TIMING"] });
      expect(lost.res.status).toBe(200);
      expect(lost.json.lead).toMatchObject({ stage: "LOST", lostReason: "PRICE", objections: ["PRICE", "TIMING"] });
      const row = await db.lead.findUniqueOrThrow({ where: { id: l.id } });
      expect(row.lostAtStage).toBe("QUALIFIED");
      expect(row.lostAt).toBeTruthy();
      expect(row.lostNote).toBe("Too expensive for now");
      const closedFu = await db.leadFollowUp.findUniqueOrThrow({ where: { id: fu.json.followUp.id } });
      expect(closedFu.doneAt).toBeTruthy();
      expect(closedFu.outcome).toBe("Lead marked lost");
      const again = await post("/api/leads/x/lost", lostRoute, l.id, { reason: "OTHER" });
      expect(again.res.status).toBe(409);
      expect(again.json.error).toBe("already_lost");
      const noReason = await post("/api/leads/x/lost", lostRoute, (await lead()).id, { note: "x" });
      expect(noReason.res.status).toBe(422);
      const reopened = await post("/api/leads/x/reopen", reopenRoute, l.id, {});
      expect(reopened.res.status).toBe(200);
      expect(reopened.json.lead).toMatchObject({ stage: "QUALIFIED", lostReason: null });
      const notLost = await post("/api/leads/x/reopen", reopenRoute, l.id, {});
      expect(notLost.res.status).toBe(409);
      expect(notLost.json.error).toBe("not_lost");
    });
  });

  describe("conversion and booking", () => {
    it("converts a lead into a new patient with source, tags, referredBy and a LEAD timeline event; a second convert is 409", async () => {
      const l = await lead({ fullName: "Convert Me", phone: "01011122233", source: "REFERRAL", interests: ["acne"], email: "c@example.com" });
      const { res, json } = await post("/api/leads/x/convert", convertRoute, l.id, { referredBy: "Dr. Karim" });
      expect(res.status).toBe(201);
      expect(json.created).toBe(true);
      const patient = await db.patient.findUniqueOrThrow({ where: { id: json.patient.id } });
      expect(patient).toMatchObject({ tenantId: a.id, fullName: "Convert Me", phone: "+201011122233", whatsapp: "+201011122233", email: "c@example.com", source: "REFERRAL", referredBy: "Dr. Karim", tags: ["acne"] });
      expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).patientId).toBe(patient.id);
      const events = await db.timelineEvent.findMany({ where: { tenantId: a.id, patientId: patient.id, kind: "LEAD" } });
      expect(events).toHaveLength(1);
      expect(events[0]!.title).toBe("Came in as a lead (Referral)");
      const again = await post("/api/leads/x/convert", convertRoute, l.id, {});
      expect(again.res.status).toBe(409);
      expect(again.json.error).toBe("already_converted");
    });

    it("links an existing patient instead when a patientId is given, stamping the patient's source once; foreign patients are 404", async () => {
      const l = await lead({ fullName: "Link Me", source: "WALK_IN" });
      const foreign = await post("/api/leads/x/convert", convertRoute, l.id, { patientId: patientB });
      expect(foreign.res.status).toBe(404);
      const { res, json } = await post("/api/leads/x/convert", convertRoute, l.id, { patientId: patientA });
      expect(res.status).toBe(201);
      expect(json).toMatchObject({ created: false, patient: { id: patientA } });
      expect((await db.patient.findUniqueOrThrow({ where: { id: patientA } })).source).toBe("WALK_IN");
      expect(await db.timelineEvent.count({ where: { patientId: patientA, kind: "LEAD", refId: l.id } })).toBe(1);
    });

    it("books a consultation through the appointments service with kind CONSULTATION and leadId, moving the lead to CONSULTATION_BOOKED", async () => {
      const l = await lead({ fullName: "Book Me", phone: "01022233344", interests: ["pigmentation"] });
      // About a month ahead at 09:00 UTC (11:00–12:00 in Cairo, inside opening hours), never a Friday.
      const startsAt = new Date(Date.now() + 30 * 86_400_000);
      startsAt.setUTCHours(9, 0, 0, 0);
      while (startsAt.getUTCDay() === 5) startsAt.setUTCDate(startsAt.getUTCDate() + 1);
      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
      const { res, json } = await post("/api/leads/x/book", bookRoute, l.id, { doctorId: doctorA.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), room: "Room 1" }, receptionCookie);
      expect(res.status).toBe(201);
      expect(json.lead).toMatchObject({ stage: "CONSULTATION_BOOKED" });
      expect(json.lead.patientId).toBeTruthy();
      const appt = await db.appointment.findUniqueOrThrow({ where: { id: json.appointment.id } });
      expect(appt).toMatchObject({ tenantId: a.id, patientId: json.lead.patientId, doctorId: doctorA.id, kind: "CONSULTATION", leadId: l.id, status: "SCHEDULED", source: "WEB_CHAT" });
      expect(appt.treatmentId).toBeTruthy();
      expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).consultationAppointmentId).toBe(appt.id);

      // Same doctor, same slot: the appointments service's conflict detection answers.
      const other = await lead({ fullName: "Clash", phone: "01022233355" });
      const clash = await post("/api/leads/x/book", bookRoute, other.id, { doctorId: doctorA.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
      expect(clash.res.status).toBe(409);
      expect(clash.json.error).toBe("conflict");
      const foreignDoctor = await post("/api/leads/x/book", bookRoute, other.id, { doctorId: (await db.user.findFirst({ where: { tenantId: b.id } }))!.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
      expect(foreignDoctor.res.status).toBe(404);
      const backwards = await post("/api/leads/x/book", bookRoute, other.id, { doctorId: doctorA.id, startsAt: endsAt.toISOString(), endsAt: startsAt.toISOString() });
      expect(backwards.res.status).toBe(422);
    });

    it("refuses a time in the past before converting, so no patient is left behind", async () => {
      const l = await lead({ fullName: "Too Late", phone: "01022233366" });
      const startsAt = new Date(Date.now() - 3 * 86_400_000);
      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
      const { res, json } = await post("/api/leads/x/book", bookRoute, l.id, { doctorId: doctorA.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, receptionCookie);
      expect(res.status).toBe(422);
      expect(json.error).toBe("in_the_past");
      const after = await db.lead.findUniqueOrThrow({ where: { id: l.id } });
      expect(after.patientId).toBeNull();
      expect(await db.patient.count({ where: { tenantId: a.id, fullName: "Too Late" } })).toBe(0);
    });
  });

  describe("follow-ups", () => {
    it("creates (owner defaults to the lead owner), lists by scope, completes with an outcome and stamps the lead", async () => {
      const l = await lead({ fullName: "Follow Up", ownerId: receptionA.id });
      const soon = new Date(Date.now() + 5 * 60_000);
      const createdFu = await post("/api/leads/x/follow-ups", createFollowUpRoute, l.id, { dueAt: soon.toISOString(), note: "Send prices", channel: "WHATSAPP" });
      expect(createdFu.res.status).toBe(201);
      expect(createdFu.json.followUp).toMatchObject({ leadId: l.id, owner: { id: receptionA.id }, note: "Send prices", channel: "WHATSAPP", doneAt: null });
      const invalid = await post("/api/leads/x/follow-ups", createFollowUpRoute, l.id, { dueAt: "not a date" });
      expect(invalid.res.status).toBe(422);

      const perLead = await (await leadFollowUpsRoute(request(`/api/leads/${l.id}/follow-ups`, { cookie: ownerCookie }), params(l.id))).json();
      expect(perLead.followUps.map((f: { id: string }) => f.id)).toContain(createdFu.json.followUp.id);
      const mine = await (await followUpsRoute(request("/api/leads/follow-ups?scope=mine", { cookie: receptionCookie }))).json();
      expect(mine.scope).toBe("mine");
      expect(mine.followUps.map((f: { id: string }) => f.id)).toContain(createdFu.json.followUp.id);
      expect(mine.counts.mine).toBeGreaterThanOrEqual(1);
      const due = await (await followUpsRoute(request("/api/leads/follow-ups?scope=due", { cookie: ownerCookie }))).json();
      expect(due.followUps.map((f: { id: string }) => f.id)).toContain(createdFu.json.followUp.id);
      const badScope = await followUpsRoute(request("/api/leads/follow-ups?scope=later", { cookie: ownerCookie }));
      expect(badScope.status).toBe(422);

      const done = await post("/api/leads/follow-ups/x/complete", completeRoute, createdFu.json.followUp.id, { outcome: "Sent the price list" }, receptionCookie);
      expect(done.res.status).toBe(200);
      expect(done.json.followUp).toMatchObject({ outcome: "Sent the price list" });
      expect(done.json.followUp.doneAt).toBeTruthy();
      expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).lastContactAt).toBeTruthy();
      const twice = await post("/api/leads/follow-ups/x/complete", completeRoute, createdFu.json.followUp.id, { outcome: "again" });
      expect(twice.res.status).toBe(409);
      expect(twice.json.error).toBe("follow_up_done");
      const foreign = await post("/api/leads/follow-ups/x/complete", completeRoute, createdFu.json.followUp.id, { outcome: "x" }, ownerBCookie);
      expect(foreign.res.status).toBe(404);
    });

    it("the overdue sweep notifies the owner once per follow-up and opens one escalation per lead after 24 hours; idempotent; completing resolves it", async () => {
      const l = await lead({ fullName: "Overdue Lead", ownerId: receptionA.id });
      const now = new Date();
      const old = await db.leadFollowUp.create({ data: { tenantId: a.id, leadId: l.id, ownerId: receptionA.id, dueAt: new Date(now.getTime() - 2 * DAY), note: "Two days late" } });
      const recent = await db.leadFollowUp.create({ data: { tenantId: a.id, leadId: l.id, ownerId: receptionA.id, dueAt: new Date(now.getTime() - HOUR), note: "An hour late" } });

      const first = await sweepTenantFollowUps(a.id, now);
      expect(first).toEqual({ notified: 2, escalated: 1 });
      const second = await sweepTenantFollowUps(a.id, now);
      expect(second).toEqual({ notified: 0, escalated: 0 });

      const forOld = await db.notification.findMany({ where: { tenantId: a.id, kind: "FOLLOW_UP_OVERDUE", entityId: old.id } });
      expect(forOld.map((n) => n.userId).sort()).toEqual([ownerA.id, receptionA.id].sort());
      expect(forOld[0]!.href).toBe(`/dashboard/leads/${l.id}`);
      expect(await db.notification.count({ where: { tenantId: a.id, kind: "FOLLOW_UP_OVERDUE", entityId: recent.id } })).toBe(2);

      const escalations = await db.escalation.findMany({ where: { tenantId: a.id, leadId: l.id } });
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toMatchObject({ kind: "LEAD_FOLLOW_UP", level: "WATCH", status: "OPEN", assignedToId: receptionA.id });
      expect(escalations[0]!.summary).toMatch(/^Lead Overdue Lead waiting since /);
      expect(escalations[0]!.dueAt.getTime() - now.getTime()).toBe(4 * HOUR);

      const done = await post("/api/leads/follow-ups/x/complete", completeRoute, old.id, { outcome: "Reached them" }, receptionCookie);
      expect(done.res.status).toBe(200);
      const resolved = await db.escalation.findUniqueOrThrow({ where: { id: escalations[0]!.id } });
      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.resolution).toBe("Reached them");
    });
  });

  describe("campaigns", () => {
    it("creates, refuses a duplicate platform id, edits, counts leads / consultations / won and totals the costs", async () => {
      const createdC = await createCampaignRoute(request("/api/campaigns", { method: "POST", cookie: ownerCookie, body: { externalId: "120210000000099", name: "Meta · Test", platform: "META", source: "CLICK_TO_WHATSAPP_AD", startedAt: "2026-09-01" } }));
      expect(createdC.status).toBe(201);
      const campaign = (await createdC.json()).campaign as { id: string };
      const dup = await createCampaignRoute(request("/api/campaigns", { method: "POST", cookie: ownerCookie, body: { externalId: "120210000000099", name: "Again", platform: "META" } }));
      expect(dup.status).toBe(409);
      expect((await dup.json()).error).toBe("duplicate_external_id");
      const invalid = await createCampaignRoute(request("/api/campaigns", { method: "POST", cookie: ownerCookie, body: { name: "No id", platform: "META" } }));
      expect(invalid.status).toBe(422);

      const patched = await patchCampaignRoute(request(`/api/campaigns/${campaign.id}`, { method: "PATCH", cookie: ownerCookie, body: { name: "Meta · Renamed", active: false, endedAt: "2026-10-01" } }), params(campaign.id));
      expect(patched.status).toBe(200);
      expect((await patched.json()).campaign).toMatchObject({ name: "Meta · Renamed", active: false });
      const foreignPatch = await patchCampaignRoute(request(`/api/campaigns/${campaign.id}`, { method: "PATCH", cookie: ownerBCookie, body: { name: "x" } }), params(campaign.id));
      expect(foreignPatch.status).toBe(404);

      const l1 = await lead({ fullName: "Camp One", phone: "01033344455", campaignId: campaign.id });
      await lead({ fullName: "Camp Two", phone: "01033344466", campaignId: campaign.id });
      await post("/api/leads/x/stage", stageRoute, l1.id, { stage: "WON" });

      const cost = await post("/api/campaigns/x/costs", costRoute, campaign.id, { periodStart: "2026-09-01", periodEnd: "2026-09-30", amount: 15000 });
      expect(cost.res.status).toBe(201);
      const badCost = await post("/api/campaigns/x/costs", costRoute, campaign.id, { periodStart: "2026-09-30", periodEnd: "2026-09-01", amount: 10 });
      expect(badCost.res.status).toBe(422);

      const list = await (await campaignsRoute(request("/api/campaigns", { cookie: assistantCookie }))).json();
      const row = list.campaigns.find((c: { id: string }) => c.id === campaign.id);
      expect(row).toMatchObject({ leads: 2, consultations: 1, won: 1, totalCost: 15000, name: "Meta · Renamed" });
    });

    it("previews a costs CSV, imports it on commit and refuses a file with bad lines", async () => {
      const csv = "periodStart,periodEnd,amount\n2026-08-01,2026-08-31,9000\n2026-09-01,2026-09-30,11000\n";
      const preview = await post("/api/campaigns/x/costs/import", importRoute, campaignA, { csv });
      expect(preview.res.status).toBe(200);
      expect(preview.json).toMatchObject({ imported: 0, errors: [] });
      expect(preview.json.rows).toHaveLength(2);
      expect(await db.campaignCost.count({ where: { campaignId: campaignA } })).toBe(0);

      const committed = await post("/api/campaigns/x/costs/import", importRoute, campaignA, { csv, commit: true });
      expect(committed.res.status).toBe(201);
      expect(committed.json.imported).toBe(2);
      const rows = await db.campaignCost.findMany({ where: { campaignId: campaignA } });
      expect(rows.map((r) => r.amount).sort((x, y) => x - y)).toEqual([9000, 11000]);
      expect(rows.every((r) => r.source === "csv")).toBe(true);

      const bad = await post("/api/campaigns/x/costs/import", importRoute, campaignA, { csv: "2026-08-01,2026-08-31,oops\n", commit: true });
      expect(bad.res.status).toBe(422);
      expect(bad.json.issues.fieldErrors.csv[0]).toMatch(/Line 1/);
      const foreign = await post("/api/campaigns/x/costs/import", importRoute, campaignB, { csv });
      expect(foreign.res.status).toBe(404);
    });
  });

  describe("permissions and isolation", () => {
    it("ASSISTANT and DOCTOR read but cannot write; NURSE and RECEPTIONIST write; anonymous is 401; cross-origin is 403", async () => {
      const l = await lead();
      expect((await listRoute(request("/api/leads", { cookie: assistantCookie }))).status).toBe(200);
      expect((await listRoute(request("/api/leads", { cookie: doctorCookie }))).status).toBe(200);
      expect((await createLead({ fullName: "Nope" }, assistantCookie)).res.status).toBe(403);
      expect((await createLead({ fullName: "Nope" }, doctorCookie)).res.status).toBe(403);
      expect((await post("/api/leads/x/stage", stageRoute, l.id, { stage: "CONTACTED" }, assistantCookie)).res.status).toBe(403);
      expect((await createLead({ fullName: "Nurse made", phone: "01044455566" }, nurseCookie)).res.status).toBe(201);
      expect((await createLead({ fullName: "Desk made", phone: "01044455577" }, receptionCookie)).res.status).toBe(201);
      expect((await listRoute(request("/api/leads"))).status).toBe(401);
      const cross = await createRoute(request("/api/leads", { method: "POST", cookie: ownerCookie, body: { fullName: "X" }, headers: { origin: "https://evil.example" } }));
      expect(cross.status).toBe(403);
      expect((await createCampaignRoute(request("/api/campaigns", { method: "POST", cookie: assistantCookie, body: { externalId: "z", name: "z", platform: "META" } }))).status).toBe(403);
    });

    it("every lead endpoint answers 404 for another tenant's id", async () => {
      const l = await lead({ fullName: "Isolated", phone: "01066677788" });
      const foreignCookie = ownerBCookie;
      expect((await post("/api/leads/x/stage", stageRoute, l.id, { stage: "CONTACTED" }, foreignCookie)).res.status).toBe(404);
      expect((await post("/api/leads/x/lost", lostRoute, l.id, { reason: "OTHER" }, foreignCookie)).res.status).toBe(404);
      expect((await post("/api/leads/x/reopen", reopenRoute, l.id, {}, foreignCookie)).res.status).toBe(404);
      expect((await post("/api/leads/x/convert", convertRoute, l.id, {}, foreignCookie)).res.status).toBe(404);
      expect((await post("/api/leads/x/follow-ups", createFollowUpRoute, l.id, { dueAt: new Date().toISOString() }, foreignCookie)).res.status).toBe(404);
      expect((await leadFollowUpsRoute(request(`/api/leads/${l.id}/follow-ups`, { cookie: foreignCookie }), params(l.id))).status).toBe(404);
      const listB = await (await listRoute(request("/api/leads", { cookie: foreignCookie }))).json();
      expect(listB.leads.map((x: { id: string }) => x.id)).not.toContain(l.id);
      expect((await db.lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("NEW");
    });
  });
});
