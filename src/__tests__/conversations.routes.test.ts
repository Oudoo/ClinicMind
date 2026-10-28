/**
 * The reception inbox over the real route handlers and the test database:
 * listing with filters, search and counts, a thread with its messages and
 * template context, staff replies (stored LOGGED with lastOutboundAt when no
 * channel is connected), status / assignee / patient and lead links /
 * confirmed objections, read receipts, "create lead from this thread", reply
 * templates (tenant:manage), RBAC and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { GET as listRoute } from "@/app/api/conversations/route";
import { GET as getRoute, PATCH as patchRoute } from "@/app/api/conversations/[id]/route";
import { POST as replyRoute } from "@/app/api/conversations/[id]/messages/route";
import { POST as readRoute } from "@/app/api/conversations/[id]/read/route";
import { GET as templatesRoute, POST as createTemplateRoute } from "@/app/api/messaging/templates/route";
import { PATCH as patchTemplateRoute } from "@/app/api/messaging/templates/[id]/route";
import { POST as createLeadRoute } from "@/app/api/leads/route";
import { renderTemplate, unfilledPlaceholders } from "@/modules/messaging/placeholders";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("reply templates (pure)", () => {
  it("fills known placeholders and leaves unknown or empty ones visible", () => {
    const body = "Hi {{name}}, see you at {{ clinic }} with {{doctor}} on {{date}} — {{link}} {{phone}}";
    expect(renderTemplate(body, { name: "Salma", clinic: "Aura", doctor: "", date: "27 Oct 2026, 10:00", link: "https://x.test" })).toBe(
      "Hi Salma, see you at Aura with {{doctor}} on 27 Oct 2026, 10:00 — https://x.test {{phone}}",
    );
  });

  it("lists the known placeholders still in a reply, once each", () => {
    expect(unfilledPlaceholders("{{date}} and {{ DATE }} and {{doctor}} and {{unknown}}")).toEqual(["date", "doctor"]);
    expect(unfilledPlaceholders("All filled in.")).toEqual([]);
  });
});

describe.skipIf(!dbTestsEnabled)("reception inbox", () => {
  const created: string[] = [];
  let a: { id: string; name: string };
  let ownerA: { id: string };
  let receptionA: { id: string };
  let doctorA: { id: string };
  let ownerCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let userB: { id: string };
  let patientA: { id: string };
  let patientB: { id: string };
  let leadA: { id: string };
  let leadB: { id: string };
  let convPatient: { id: string };
  let convLead: { id: string };
  let convClosed: { id: string };
  let convB: { id: string };

  async function json(res: Response) {
    return { res, body: await res.json() };
  }
  const list = (query: string, cookie = ownerCookie) => listRoute(request(`/api/conversations${query}`, { cookie })).then(json);
  const thread = (id: string, cookie = ownerCookie) => getRoute(request(`/api/conversations/${id}`, { cookie }), params(id)).then(json);
  const reply = (id: string, body: unknown, cookie = receptionCookie, headers?: Record<string, string>) =>
    replyRoute(request(`/api/conversations/${id}/messages`, { method: "POST", cookie, body, headers }), params(id)).then(json);
  const patch = (id: string, body: unknown, cookie = receptionCookie) =>
    patchRoute(request(`/api/conversations/${id}`, { method: "PATCH", cookie, body }), params(id)).then(json);
  const markRead = (id: string, cookie = receptionCookie) => readRoute(request(`/api/conversations/${id}/read`, { method: "POST", cookie }), params(id)).then(json);

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `inbox-a-${Date.now().toString(36)}`, name: "Aura Test Clinic" });
    const tenantB = await createTenant({ slug: `inbox-b-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA;
    ownerA = await createUser({ tenantId: a.id, role: "CLINIC_OWNER", fullName: "Owner A" });
    receptionA = await createUser({ tenantId: a.id, role: "RECEPTIONIST", fullName: "Desk A" });
    doctorA = await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr. Amina" });
    const assistant = await createUser({ tenantId: a.id, role: "ASSISTANT", fullName: "Assistant A" });
    userB = await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(ownerA.id);
    receptionCookie = await sessionCookieFor(receptionA.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(userB.id);

    patientA = await db.patient.create({ data: { tenantId: a.id, fullName: "Salma Fathy", phone: "+201055501234", whatsapp: "+201055501234" } });
    patientB = await db.patient.create({ data: { tenantId: tenantB.id, fullName: "Patient Of B" } });
    leadA = await db.lead.create({ data: { tenantId: a.id, fullName: "Karim Lead", phone: "+201066601234", source: "CLICK_TO_WHATSAPP_AD" } });
    leadB = await db.lead.create({ data: { tenantId: tenantB.id, fullName: "Lead Of B" } });
    // The patient's next appointment feeds {{doctor}} and {{date}}.
    await db.appointment.create({
      data: { tenantId: a.id, patientId: patientA.id, doctorId: doctorA.id, startsAt: new Date(Date.now() + 3 * 24 * HOUR), endsAt: new Date(Date.now() + 3 * 24 * HOUR + 30 * MIN), status: "CONFIRMED" },
    });

    const now = Date.now();
    convPatient = await db.conversation.create({
      data: {
        tenantId: a.id,
        channel: "WHATSAPP",
        patientId: patientA.id,
        contactName: "Salma",
        contactPhone: "+201055501234",
        status: "WAITING_ON_CLINIC",
        lastInboundAt: new Date(now - 5 * MIN),
        updatedAt: new Date(now - 5 * MIN),
        messages: {
          create: [
            { tenantId: a.id, direction: "INBOUND", author: "PATIENT", body: "بكام جلسة الليزر؟", delivery: "DELIVERED", createdAt: new Date(now - 30 * MIN) },
            { tenantId: a.id, direction: "OUTBOUND", author: "AI", body: "أهلاً! السعر بيتحدد بعد الكشف.", delivery: "DELIVERED", createdAt: new Date(now - 29 * MIN) },
            { tenantId: a.id, direction: "INBOUND", author: "PATIENT", body: "طيب ممكن ميعاد؟", delivery: "DELIVERED", createdAt: new Date(now - 5 * MIN) },
          ],
        },
      },
    });
    // The first inbound message is unread too: two unread in this thread.
    convLead = await db.conversation.create({
      data: {
        tenantId: a.id,
        channel: "WHATSAPP",
        leadId: leadA.id,
        contactName: "Karim",
        contactPhone: "+201066601234",
        status: "WAITING_ON_PATIENT",
        assignedToId: receptionA.id,
        updatedAt: new Date(now - HOUR),
        messages: {
          create: [
            { tenantId: a.id, direction: "INBOUND", author: "PATIENT", body: "Hair transplant price?", delivery: "DELIVERED", readAt: new Date(now - 2 * HOUR), createdAt: new Date(now - 2 * HOUR) },
            { tenantId: a.id, direction: "OUTBOUND", author: "HUMAN", authorId: receptionA.id, body: "Hi Karim, we will call you.", delivery: "LOGGED", createdAt: new Date(now - HOUR) },
          ],
        },
      },
    });
    convClosed = await db.conversation.create({
      data: {
        tenantId: a.id,
        channel: "SMS",
        contactName: "Unknown Caller",
        contactPhone: "+201077701234",
        status: "CLOSED",
        closedAt: new Date(now - 24 * HOUR),
        updatedAt: new Date(now - 24 * HOUR),
        messages: { create: [{ tenantId: a.id, direction: "INBOUND", author: "PATIENT", body: "Are you open on Friday?", delivery: "DELIVERED", readAt: new Date(now - 25 * HOUR), createdAt: new Date(now - 25 * HOUR) }] },
      },
    });
    convB = await db.conversation.create({ data: { tenantId: tenantB.id, channel: "WHATSAPP", contactName: "B contact", status: "OPEN" } });
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("list", () => {
    it("shows open threads newest first with names, assignee, last message, unread counts and the inbox counts", async () => {
      const { res, body } = await list("");
      expect(res.status).toBe(200);
      expect(body.conversations.map((c: { id: string }) => c.id)).toEqual([convPatient.id, convLead.id]);
      const [first, second] = body.conversations;
      expect(first).toMatchObject({ displayName: "Salma Fathy", channel: "WHATSAPP", status: "WAITING_ON_CLINIC", unread: 2, patient: { id: patientA.id } });
      expect(first.lastMessage).toMatchObject({ body: "طيب ممكن ميعاد؟", direction: "INBOUND", author: "PATIENT" });
      expect(second).toMatchObject({ displayName: "Karim Lead", unread: 0, assignedTo: { id: receptionA.id, fullName: "Desk A" }, lead: { id: leadA.id, stage: "NEW" } });
      expect(body.counts).toEqual({ open: 2, waitingClinic: 1, waitingPatient: 1, closed: 1, unread: 2 });
      expect(body.total).toBe(2);
    });

    it("filters by status, channel and assignee, and searches names and phone numbers", async () => {
      expect((await list("?status=closed")).body.conversations.map((c: { id: string }) => c.id)).toEqual([convClosed.id]);
      expect((await list("?status=all")).body.total).toBe(3);
      expect((await list("?status=waiting_clinic")).body.conversations.map((c: { id: string }) => c.id)).toEqual([convPatient.id]);
      expect((await list("?status=waiting_patient")).body.conversations.map((c: { id: string }) => c.id)).toEqual([convLead.id]);
      expect((await list("?status=all&channel=SMS")).body.conversations.map((c: { id: string }) => c.id)).toEqual([convClosed.id]);
      expect((await list("?mine=1", receptionCookie)).body.conversations.map((c: { id: string }) => c.id)).toEqual([convLead.id]);
      expect((await list("?mine=1", ownerCookie)).body.conversations).toEqual([]);
      expect((await list("?q=salma")).body.conversations.map((c: { id: string }) => c.id)).toEqual([convPatient.id]);
      expect((await list("?q=karim%20lead")).body.conversations.map((c: { id: string }) => c.id)).toEqual([convLead.id]);
      expect((await list("?status=all&q=0107770")).body.conversations.map((c: { id: string }) => c.id)).toEqual([convClosed.id]);
      expect((await list("?status=later")).res.status).toBe(422);
      expect((await list("?channel=FAX")).res.status).toBe(422);
    });

    it("never shows another tenant's threads; anonymous is 401", async () => {
      const b = await list("?status=all", ownerBCookie);
      expect(b.body.conversations.map((c: { id: string }) => c.id)).toEqual([convB.id]);
      expect((await listRoute(request("/api/conversations"))).status).toBe(401);
    });
  });

  describe("thread and read receipts", () => {
    it("returns the messages in order with authors, the template context and the delivery mode; foreign ids are 404", async () => {
      const { res, body } = await thread(convPatient.id, assistantCookie);
      expect(res.status).toBe(200);
      const c = body.conversation;
      expect(c.messages.map((m: { author: string; direction: string }) => `${m.direction}:${m.author}`)).toEqual(["INBOUND:PATIENT", "OUTBOUND:AI", "INBOUND:PATIENT"]);
      expect(c.unread).toBe(2);
      expect(c.truncated).toBe(false);
      expect(c.deliveryMode).toBe("logged");
      expect(c.templateContext).toMatchObject({ name: "Salma", clinic: "Aura Test Clinic", doctor: "Dr. Amina" });
      expect(c.templateContext.date).toMatch(/\d{2} \w{3} \d{4}, \d{2}:\d{2}/);
      const lead = (await thread(convLead.id)).body.conversation;
      expect(lead.messages[1]).toMatchObject({ author: "HUMAN", authorName: "Desk A", delivery: "LOGGED" });
      expect(lead.templateContext).toMatchObject({ name: "Karim", doctor: "", date: "" });
      expect((await thread(convPatient.id, ownerBCookie)).res.status).toBe(404);
      expect((await thread("does-not-exist")).res.status).toBe(404);
    });

    it("opening a thread stamps its unread inbound messages read, once, for any role that can read", async () => {
      const first = await markRead(convPatient.id, assistantCookie);
      expect(first.res.status).toBe(200);
      expect(first.body).toEqual({ marked: 2 });
      expect((await thread(convPatient.id)).body.conversation.unread).toBe(0);
      expect((await markRead(convPatient.id)).body).toEqual({ marked: 0 });
      expect(await db.message.count({ where: { conversationId: convPatient.id, direction: "INBOUND", readAt: null } })).toBe(0);
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "conversation.read", entityId: convPatient.id } })).toBe(1);
      expect((await list("")).body.counts.unread).toBe(0);
      expect((await markRead(convPatient.id, ownerBCookie)).res.status).toBe(404);
    });
  });

  describe("replies", () => {
    it("stores a staff reply as HUMAN by the sender, LOGGED with no channel connected, and hands the turn to the patient", async () => {
      const { res, body } = await reply(convPatient.id, { body: "أكيد يا سلمى، الثلاثاء الساعة ٤ مناسب؟", templateKey: "booking-confirmation-ar" });
      expect(res.status).toBe(201);
      expect(body.delivery).toBe("LOGGED");
      expect(body.failedReason).toBeNull();
      expect(body.message).toMatchObject({ direction: "OUTBOUND", author: "HUMAN", authorName: "Desk A", delivery: "LOGGED", templateKey: "booking-confirmation-ar" });
      const stored = await db.message.findUniqueOrThrow({ where: { id: body.message.id } });
      expect(stored).toMatchObject({ tenantId: a.id, conversationId: convPatient.id, authorId: receptionA.id, delivery: "LOGGED" });
      const conv = await db.conversation.findUniqueOrThrow({ where: { id: convPatient.id } });
      expect(conv.status).toBe("WAITING_ON_PATIENT");
      expect(conv.lastOutboundAt).toBeTruthy();
      expect(conv.lastOutboundAt!.getTime()).toBeGreaterThan(Date.now() - MIN);
      const audits = await db.auditLog.findMany({ where: { tenantId: a.id, action: "conversation.reply", entityId: convPatient.id } });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBe(receptionA.id);
    });

    it("reopens a closed thread and stamps the linked lead's last contact", async () => {
      const closed = await reply(convClosed.id, { body: "Yes, Friday 2 pm to 8 pm." });
      expect(closed.res.status).toBe(201);
      const conv = await db.conversation.findUniqueOrThrow({ where: { id: convClosed.id } });
      expect(conv).toMatchObject({ status: "WAITING_ON_PATIENT", closedAt: null });
      expect((await db.lead.findUniqueOrThrow({ where: { id: leadA.id } })).lastContactAt).toBeNull();
      expect((await reply(convLead.id, { body: "Following up on the price list." })).res.status).toBe(201);
      expect((await db.lead.findUniqueOrThrow({ where: { id: leadA.id } })).lastContactAt).toBeTruthy();
      // Put the SMS thread back the way the other tests expect it.
      await db.conversation.update({ where: { id: convClosed.id }, data: { status: "CLOSED", closedAt: new Date() } });
    });

    it("accepts a reply typed without a template (templateKey null or blank)", async () => {
      for (const templateKey of [null, ""]) {
        const { res, body } = await reply(convPatient.id, { body: "Typed by hand.", templateKey });
        expect(res.status).toBe(201);
        expect(body.message.templateKey).toBeNull();
      }
    });

    it("refuses an empty reply and one that still carries a placeholder (422)", async () => {
      const empty = await reply(convPatient.id, { body: "   " });
      expect(empty.res.status).toBe(422);
      const placeholder = await reply(convPatient.id, { body: "Your visit is on {{date}} with {{ doctor }}." });
      expect(placeholder.res.status).toBe(422);
      expect(placeholder.body.issues.fieldErrors.body[0]).toBe("Replace {{date}}, {{doctor}} before sending");
      expect((await reply(convPatient.id, { body: "x".repeat(4001) })).res.status).toBe(422);
    });

    it("assistants cannot reply (403); foreign threads are 404; cross-origin is 403; anonymous is 401", async () => {
      const before = await db.message.count({ where: { conversationId: convPatient.id } });
      expect((await reply(convPatient.id, { body: "hello" }, assistantCookie)).res.status).toBe(403);
      expect((await reply(convPatient.id, { body: "hello" }, ownerBCookie)).res.status).toBe(404);
      expect((await reply(convPatient.id, { body: "hello" }, receptionCookie, { origin: "https://evil.example" })).res.status).toBe(403);
      expect((await replyRoute(request(`/api/conversations/${convPatient.id}/messages`, { method: "POST", body: { body: "x" } }), params(convPatient.id))).status).toBe(401);
      expect(await db.message.count({ where: { conversationId: convPatient.id } })).toBe(before);
    });
  });

  describe("patch", () => {
    it("closes and reopens, assigns, links a patient and a lead, and unlinks; every change is audited", async () => {
      const closed = await patch(convPatient.id, { status: "CLOSED" });
      expect(closed.res.status).toBe(200);
      expect(closed.body.conversation.status).toBe("CLOSED");
      expect((await db.conversation.findUniqueOrThrow({ where: { id: convPatient.id } })).closedAt).toBeTruthy();
      const reopened = await patch(convPatient.id, { status: "OPEN" });
      expect(reopened.body.conversation.status).toBe("OPEN");
      expect((await db.conversation.findUniqueOrThrow({ where: { id: convPatient.id } })).closedAt).toBeNull();

      const assigned = await patch(convPatient.id, { assignedToId: doctorA.id });
      expect(assigned.body.conversation.assignedTo).toEqual({ id: doctorA.id, fullName: "Dr. Amina" });
      expect((await patch(convPatient.id, { assignedToId: "" })).body.conversation.assignedTo).toBeNull();

      const linked = await patch(convClosed.id, { leadId: leadA.id, patientId: patientA.id, contactName: "Salma (SMS)" });
      expect(linked.res.status).toBe(200);
      expect(linked.body.conversation).toMatchObject({ lead: { id: leadA.id }, patient: { id: patientA.id }, contactName: "Salma (SMS)", displayName: "Salma Fathy" });
      const unlinked = await patch(convClosed.id, { leadId: null, patientId: null });
      expect(unlinked.body.conversation).toMatchObject({ lead: null, patient: null, displayName: "Salma (SMS)" });
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "conversation.update", entityId: convClosed.id } })).toBe(2);
      // Closing and reopening are named in the audit log (audit finding: they were not logged).
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "conversation.close", entityId: convPatient.id } })).toBe(1);
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "conversation.reopen", entityId: convPatient.id } })).toBe(1);
    });

    it("confirming objections stamps the thread and copies them to the linked lead", async () => {
      const { res, body } = await patch(convLead.id, { objections: ["PRICE", "TIMING", "PRICE"] });
      expect(res.status).toBe(200);
      expect(body.conversation.objections).toEqual(["PRICE", "TIMING"]);
      expect(body.conversation.objectionsConfirmedAt).toBeTruthy();
      expect((await db.lead.findUniqueOrThrow({ where: { id: leadA.id } })).objections).toEqual(["PRICE", "TIMING"]);
    });

    it("validates (422), refuses foreign links (404), assistants (403) and foreign threads (404)", async () => {
      expect((await patch(convPatient.id, { status: "SNOOZED" })).res.status).toBe(422);
      expect((await patch(convPatient.id, { objections: ["BORED"] })).res.status).toBe(422);
      expect((await patch(convPatient.id, { assignedToId: userB.id })).res.status).toBe(404);
      expect((await patch(convPatient.id, { patientId: patientB.id })).res.status).toBe(404);
      expect((await patch(convPatient.id, { leadId: leadB.id })).res.status).toBe(404);
      expect((await patch(convPatient.id, { status: "CLOSED" }, assistantCookie)).res.status).toBe(403);
      expect((await patch(convPatient.id, { status: "CLOSED" }, ownerBCookie)).res.status).toBe(404);
      expect((await db.conversation.findUniqueOrThrow({ where: { id: convPatient.id } })).status).toBe("OPEN");
    });

    it("creates a lead from a thread: the thread's number is kept and the thread is linked; a foreign thread is 404", async () => {
      const res = await createLeadRoute(request("/api/leads", { method: "POST", cookie: receptionCookie, body: { fullName: "Friday Caller", source: "PHONE", conversationId: convClosed.id } }));
      expect(res.status).toBe(201);
      const lead = (await res.json()).lead;
      expect(lead).toMatchObject({ fullName: "Friday Caller", phone: "+201077701234", whatsapp: "+201077701234", source: "PHONE" });
      expect((await db.conversation.findUniqueOrThrow({ where: { id: convClosed.id } })).leadId).toBe(lead.id);
      const foreign = await createLeadRoute(request("/api/leads", { method: "POST", cookie: receptionCookie, body: { fullName: "X", conversationId: convB.id } }));
      expect(foreign.status).toBe(404);
    });
  });

  describe("templates", () => {
    let templateId: string;

    it("owners create templates; duplicates are 409, unknown placeholders 422, other roles 403", async () => {
      const body = { key: "Price-Reply-EN", name: "Price reply (EN)", language: "en", category: "price", body: "Hi {{name}}, the price is confirmed at the consultation with {{doctor}}." };
      const res = await createTemplateRoute(request("/api/messaging/templates", { method: "POST", cookie: ownerCookie, body }));
      expect(res.status).toBe(201);
      const template = (await res.json()).template;
      templateId = template.id;
      expect(template).toMatchObject({ key: "price-reply-en", name: "Price reply (EN)", language: "en", active: true });
      expect((await createTemplateRoute(request("/api/messaging/templates", { method: "POST", cookie: ownerCookie, body }))).status).toBe(409);
      const unknown = await createTemplateRoute(request("/api/messaging/templates", { method: "POST", cookie: ownerCookie, body: { ...body, key: "x-1", body: "Hi {{first_name}}" } }));
      expect(unknown.status).toBe(422);
      expect((await unknown.json()).issues.fieldErrors.body[0]).toMatch(/Unknown placeholder \{\{first_name\}\}/);
      expect((await createTemplateRoute(request("/api/messaging/templates", { method: "POST", cookie: ownerCookie, body: { name: "No key", body: "x" } }))).status).toBe(422);
      expect((await createTemplateRoute(request("/api/messaging/templates", { method: "POST", cookie: receptionCookie, body: { ...body, key: "r-1" } }))).status).toBe(403);
      expect((await createTemplateRoute(request("/api/messaging/templates", { method: "POST", cookie: assistantCookie, body: { ...body, key: "a-1" } }))).status).toBe(403);
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "messaging.template.create" } })).toBe(1);
    });

    it("lists active templates for every reader and inactive ones only for owners asking for all", async () => {
      const edited = await patchTemplateRoute(
        request(`/api/messaging/templates/${templateId}`, { method: "PATCH", cookie: ownerCookie, body: { body: "Hi {{name}}, prices start at 1,200 EGP.", active: false } }),
        params(templateId),
      );
      expect(edited.status).toBe(200);
      expect((await edited.json()).template).toMatchObject({ body: "Hi {{name}}, prices start at 1,200 EGP.", active: false });
      const forDesk = await (await templatesRoute(request("/api/messaging/templates", { cookie: receptionCookie }))).json();
      expect(forDesk.templates.map((t: { id: string }) => t.id)).not.toContain(templateId);
      const deskAll = await (await templatesRoute(request("/api/messaging/templates?all=1", { cookie: receptionCookie }))).json();
      expect(deskAll.templates.map((t: { id: string }) => t.id)).not.toContain(templateId);
      const ownerAll = await (await templatesRoute(request("/api/messaging/templates?all=1", { cookie: ownerCookie }))).json();
      expect(ownerAll.templates.map((t: { id: string }) => t.id)).toContain(templateId);
      expect((await templatesRoute(request("/api/messaging/templates", { cookie: assistantCookie }))).status).toBe(200);
    });

    it("editing is owner-only, validated, and another tenant's template is 404", async () => {
      const patchAs = (cookie: string, body: unknown) => patchTemplateRoute(request(`/api/messaging/templates/${templateId}`, { method: "PATCH", cookie, body }), params(templateId));
      expect((await patchAs(receptionCookie, { name: "Desk edit" })).status).toBe(403);
      expect((await patchAs(ownerCookie, { language: "fr" })).status).toBe(422);
      expect((await patchAs(ownerCookie, { body: "{{nope}}" })).status).toBe(422);
      expect((await patchAs(ownerBCookie, { name: "Theirs now" })).status).toBe(404);
      expect((await db.messageTemplate.findUniqueOrThrow({ where: { id: templateId } })).name).toBe("Price reply (EN)");
    });
  });
});
