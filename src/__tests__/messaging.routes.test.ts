/**
 * Messaging over the real route handlers and the test database: the signed
 * inbound webhook (bad or missing signature 401; a good one stores the thread,
 * the message, a lead for an unknown number and the notifications; retries
 * with the same message id are idempotent; Meta's payload and delivery
 * receipts), WhatsApp's hub challenge, the integration settings
 * (tenant:manage; the secret shown once), the outbound adapters (WhatsApp
 * Cloud API, the signed inbox webhook, the logged mode), the objection tagger
 * in Arabic and English, and the SSRF guard on outbound URLs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { GET as verifyRoute, POST as inboundRoute } from "@/app/api/integrations/messaging/inbound/[tenantSlug]/route";
import { GET as statusRoute, PATCH as updateRoute } from "@/app/api/messaging/integration/route";
import { POST as secretRoute } from "@/app/api/messaging/integration/secret/route";
import { POST as testRoute } from "@/app/api/messaging/integration/test/route";
import { POST as replyRoute } from "@/app/api/conversations/[id]/messages/route";
import { tagObjections } from "@/modules/messaging/tagger";
import { parseMetaPayload, parseMetaStatuses, receiptAdvances } from "@/modules/messaging/inbound";
import { __setMessagingFetchForTests, signBody, signatureMatches } from "@/modules/messaging/provider";
import { isPrivateAddress, outboundUrlProblem, resolvedUrlProblem } from "@/modules/messaging/url-guard";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const STRICT = { strict: true };

function metaDelivery(value: Record<string, unknown>) {
  return { object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", ...value } }] }] };
}

describe("objection tagger (pure)", () => {
  it("tags English enquiries by keyword, whole words only", () => {
    expect(tagObjections("How much does it cost? Is it painful?")).toEqual(["PRICE", "PAIN"]);
    expect(tagObjections("How many days off work, and is there swelling?")).toEqual(["DOWNTIME"]);
    expect(tagObjections("Do you guarantee the results? Are you certified, any reviews?")).toEqual(["RESULTS_DOUBT", "TRUST"]);
    expect(tagObjections("Let me think about it, maybe after Eid")).toEqual(["TIMING"]);
    expect(tagObjections("I live in Spain and want to book")).toEqual([]);
    expect(tagObjections("")).toEqual([]);
    expect(tagObjections(null)).toEqual([]);
  });

  it("tags Egyptian Arabic, whatever the alef, ya and ta marbuta variants", () => {
    expect(tagObjections("بكام زراعة الشعر؟ وهل العملية بتوجع؟")).toEqual(["PRICE", "PAIN"]);
    expect(tagObjections("الأسعار غالية شوية")).toEqual(["PRICE"]);
    expect(tagObjections("الاسعار غاليه")).toEqual(["PRICE"]);
    expect(tagObjections("هرجع الشغل امتى؟ وفي تورم؟")).toEqual(["DOWNTIME"]);
    expect(tagObjections("النتيجة مضمونة؟ عندكم تقييمات؟")).toEqual(["RESULTS_DOUBT", "TRUST"]);
    expect(tagObjections("هفكر وأرد عليكم بعد العيد")).toEqual(["TIMING"]);
    expect(tagObjections("السلام عليكم، عايزة أحجز")).toEqual([]);
  });

  it("tags a mixed Arabic and English message once per objection", () => {
    expect(tagObjections("price كام؟ بكام الجلسة")).toEqual(["PRICE"]);
  });
});

describe("Meta payloads and receipts (pure)", () => {
  it("reads messages with the sender's profile name, the ad referral and placeholders for media", () => {
    const payload = metaDelivery({
      contacts: [{ wa_id: "201001234567", profile: { name: "Mona Adel" } }],
      messages: [
        { from: "201001234567", id: "wamid.A", timestamp: "1767225600", type: "text", text: { body: "بكام؟" }, referral: { source_id: "120210000000001" } },
        { from: "201001234567", id: "wamid.B", timestamp: "1767225601", type: "image", image: { caption: "my scalp" } },
        { from: "201001234567", id: "wamid.C", type: "reaction" },
      ],
    });
    const parsed = parseMetaPayload(payload);
    expect(parsed.map((m) => [m.externalId, m.body, m.name, m.ref])).toEqual([
      ["wamid.A", "بكام؟", "Mona Adel", "120210000000001"],
      ["wamid.B", "[image] my scalp", "Mona Adel", null],
      ["wamid.C", "[reaction]", "Mona Adel", null],
    ]);
    expect(parsed[0]!.receivedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseMetaPayload({ nothing: true })).toEqual([]);
  });

  it("reads delivery statuses and only lets receipts move a message forward", () => {
    const statuses = parseMetaStatuses(
      metaDelivery({
        statuses: [
          { id: "wamid.X", status: "delivered", timestamp: "1767225600" },
          { id: "wamid.Y", status: "failed", errors: [{ code: 131047, title: "Re-engagement message" }] },
          { id: "wamid.Z", status: "deleted" },
        ],
      }),
    );
    expect(statuses).toEqual([
      { externalId: "wamid.X", status: "DELIVERED", at: new Date("2026-01-01T00:00:00.000Z"), reason: null },
      { externalId: "wamid.Y", status: "FAILED", at: null, reason: "131047 Re-engagement message" },
    ]);
    expect(receiptAdvances("SENT", "DELIVERED")).toBe(true);
    expect(receiptAdvances("DELIVERED", "READ")).toBe(true);
    expect(receiptAdvances("READ", "DELIVERED")).toBe(false);
    expect(receiptAdvances("DELIVERED", "FAILED")).toBe(false);
    expect(receiptAdvances("SENT", "FAILED")).toBe(true);
    expect(receiptAdvances("FAILED", "SENT")).toBe(false);
    expect(receiptAdvances("FAILED", "DELIVERED")).toBe(true);
  });
});

describe("outbound URL guard (pure)", () => {
  it("knows private, loopback, link-local and reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "not-an-ip"]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "41.33.12.7", "2a00:1450:4001:80b::200e"]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
    }
  });

  it("in production accepts https to public hosts only; in development http and localhost are fine", async () => {
    expect(outboundUrlProblem("https://inbox.example.com/hooks/clinic", STRICT)).toBeNull();
    expect(outboundUrlProblem("http://inbox.example.com/hook", STRICT)).toBe("Use an https URL");
    expect(outboundUrlProblem("https://localhost:8443/hook", STRICT)).toBe("The URL must point to a public host");
    expect(outboundUrlProblem("https://metadata.google.internal/", STRICT)).toBe("The URL must point to a public host");
    expect(outboundUrlProblem("https://169.254.169.254/latest/meta-data", STRICT)).toBe("The URL must point to a public address");
    expect(outboundUrlProblem("https://[::1]/hook", STRICT)).toBe("The URL must point to a public address");
    expect(outboundUrlProblem("https://user:pass@inbox.example.com/", STRICT)).toMatch(/credentials/i);
    expect(outboundUrlProblem("ftp://inbox.example.com/", STRICT)).toBe("Use an http(s) URL");
    expect(outboundUrlProblem("not a url", STRICT)).toBe("Not a valid URL");
    expect(outboundUrlProblem("http://localhost:4000/hook", { strict: false })).toBeNull();
    expect(await resolvedUrlProblem("https://rebind.example.com/", STRICT, async () => ["10.0.0.7"])).toBe("The host resolves to a private address");
    expect(await resolvedUrlProblem("https://inbox.example.com/", STRICT, async () => ["93.184.216.34"])).toBeNull();
    expect(await resolvedUrlProblem("https://nowhere.example.com/", STRICT, async () => Promise.reject(new Error("ENOTFOUND")))).toBe("The host does not resolve");
  });
});

describe.skipIf(!dbTestsEnabled)("messaging", () => {
  const created: string[] = [];
  const env = { ...process.env };
  let a: { id: string; slug: string; name: string };
  let b: { id: string; slug: string };
  let bare: { id: string; slug: string };
  let ownerCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let reception: { id: string };
  let patientA: { id: string };
  let patientB: { id: string };
  let campaignA: { id: string };
  let secret: string;

  const slugParams = (tenantSlug: string) => ({ params: Promise.resolve({ tenantSlug }) });
  const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

  function post(slug: string, raw: string, headers: Record<string, string> = {}) {
    return inboundRoute(
      new Request(`http://localhost:3000/api/integrations/messaging/inbound/${slug}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw }),
      slugParams(slug),
    );
  }
  function signed(slug: string, payload: unknown, key = secret) {
    const raw = JSON.stringify(payload);
    return post(slug, raw, { "x-clinicmind-signature": signBody(key, raw) });
  }
  const verify = (slug: string, query: string) => verifyRoute(new Request(`http://localhost:3000/api/integrations/messaging/inbound/${slug}?${query}`), slugParams(slug));

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `msg-a-${Date.now().toString(36)}`, name: "Aura Messaging" });
    const tenantB = await createTenant({ slug: `msg-b-${Date.now().toString(36)}` });
    const tenantBare = await createTenant({ slug: `msg-c-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id, tenantBare.id);
    a = tenantA;
    b = tenantB;
    bare = tenantBare;
    const owner = await createUser({ tenantId: a.id, role: "CLINIC_OWNER", fullName: "Owner A" });
    reception = await createUser({ tenantId: a.id, role: "RECEPTIONIST", fullName: "Desk A" });
    const assistant = await createUser({ tenantId: a.id, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b.id, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    patientA = await db.patient.create({ data: { tenantId: a.id, fullName: "Hala Mansour", phone: "+201011112222", whatsapp: "+201011112222", language: "ar" } });
    patientB = await db.patient.create({ data: { tenantId: b.id, fullName: "Patient Of B", phone: "+201099990000" } });
    campaignA = await db.campaign.create({ data: { tenantId: a.id, externalId: "120210000000001", name: "Meta · Hair transplant", platform: "META", source: "CLICK_TO_WHATSAPP_AD" } });

    // The owner generates the webhook secret: shown once, kept hashed (and encrypted for signing).
    const res = await secretRoute(request("/api/messaging/integration/secret", { method: "POST", cookie: ownerCookie }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    secret = body.secret;
    expect(secret).toMatch(/^cmwh_/);
    // Tenant B has a secret of its own.
    await secretRoute(request("/api/messaging/integration/secret", { method: "POST", cookie: ownerBCookie }));
  });

  afterEach(() => {
    __setMessagingFetchForTests(null);
    for (const key of ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_CLOUD_TOKEN"]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("signed inbound webhook", () => {
    it("answers 401 to a missing or bad signature, an unknown tenant and a tenant without an integration", async () => {
      const payload = JSON.stringify({ from: "01022223333", body: "Hello" });
      expect((await post(a.slug, payload)).status).toBe(401);
      expect((await post(a.slug, payload, { "x-clinicmind-signature": "sha256=deadbeef" })).status).toBe(401);
      expect((await post(a.slug, payload, { "x-clinicmind-signature": signBody("cmwh_not-the-secret", payload) })).status).toBe(401);
      expect((await post(a.slug, `${payload} `, { "x-clinicmind-signature": signBody(secret, payload) })).status).toBe(401);
      expect((await signed("no-such-clinic", { from: "01022223333", body: "Hello" })).status).toBe(401);
      expect((await signed(bare.slug, { from: "01022223333", body: "Hello" })).status).toBe(401);
      // Tenant A's secret does not open tenant B's door.
      expect((await signed(b.slug, { from: "01022223333", body: "Hello" })).status).toBe(401);
      expect(await db.message.count({ where: { tenantId: { in: [a.id, b.id] } } })).toBe(0);
      expect((await post(a.slug, payload, { "x-hub-signature-256": signBody(secret, payload) })).status).toBe(401);
    });

    it("a good signature stores the thread, the message and a lead for the unknown number, and tells the desk", async () => {
      const res = await signed(a.slug, { from: "0102 222 3333", name: "Mona Adel", body: "بكام زراعة الشعر؟", externalId: "ext-1", ref: "120210000000001" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.accepted).toBe(1);
      const [result] = body.results;
      expect(result.duplicate).toBe(false);

      const conversation = await db.conversation.findUniqueOrThrow({ where: { id: result.conversationId } });
      expect(conversation).toMatchObject({ tenantId: a.id, channel: "WHATSAPP", status: "WAITING_ON_CLINIC", contactPhone: "+201022223333", contactName: "Mona Adel", leadId: result.leadId, objections: ["PRICE"] });
      expect(conversation.lastInboundAt).toBeTruthy();
      const message = await db.message.findUniqueOrThrow({ where: { id: result.messageId } });
      expect(message).toMatchObject({ tenantId: a.id, direction: "INBOUND", author: "PATIENT", delivery: "DELIVERED", externalId: "ext-1", body: "بكام زراعة الشعر؟", readAt: null });
      const lead = await db.lead.findUniqueOrThrow({ where: { id: result.leadId } });
      expect(lead).toMatchObject({ tenantId: a.id, fullName: "Mona Adel", phone: "+201022223333", source: "CLICK_TO_WHATSAPP_AD", campaignId: campaignA.id, stage: "NEW" });

      const notifications = await db.notification.findMany({ where: { tenantId: a.id, userId: reception.id }, orderBy: { createdAt: "asc" } });
      expect(notifications.map((n) => n.kind).sort()).toEqual(["LEAD_NEW", "MESSAGE_INBOUND"]);
      const inbound = notifications.find((n) => n.kind === "MESSAGE_INBOUND")!;
      expect(inbound).toMatchObject({ title: "New message from Mona Adel", href: `/dashboard/conversations?c=${conversation.id}`, entityId: conversation.id });
      expect((await db.channelIntegration.findFirstOrThrow({ where: { tenantId: a.id } })).lastInboundAt).toBeTruthy();
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "conversation.inbound.open", entityId: conversation.id } })).toBe(1);
    });

    it("is idempotent on the provider's message id, and a second message joins the same thread without a second lead", async () => {
      const again = await signed(a.slug, { from: "+201022223333", name: "Mona Adel", body: "بكام زراعة الشعر؟", externalId: "ext-1" });
      expect(again.status).toBe(200);
      const body = await again.json();
      expect(body.results[0].duplicate).toBe(true);
      expect(await db.message.count({ where: { tenantId: a.id, externalId: "ext-1" } })).toBe(1);

      const next = await (await signed(a.slug, { from: "+201022223333", body: "Is it painful?", externalId: "ext-2" })).json();
      expect(next.results[0].conversationId).toBe(body.results[0].conversationId);
      expect(next.results[0].leadId).toBe(body.results[0].leadId);
      expect(await db.lead.count({ where: { tenantId: a.id, phone: "+201022223333" } })).toBe(1);
      expect((await db.conversation.findUniqueOrThrow({ where: { id: next.results[0].conversationId } })).objections).toEqual(["PRICE", "PAIN"]);
      expect(await db.notification.count({ where: { tenantId: a.id, kind: "MESSAGE_INBOUND", userId: reception.id } })).toBe(2);
    });

    it("attributes a lead to the ad only when the message carries a referral", async () => {
      const organic = await (await signed(a.slug, { from: "01044445555", name: "Organic Sender", body: "Hello", externalId: "ext-organic" })).json();
      expect(await db.lead.findUniqueOrThrow({ where: { id: organic.results[0].leadId } })).toMatchObject({ source: "OTHER", campaignId: null });
      const unknownAd = await (await signed(a.slug, { from: "01044446666", body: "Hi", externalId: "ext-ad", ref: "some-other-ad" })).json();
      expect(await db.lead.findUniqueOrThrow({ where: { id: unknownAd.results[0].leadId } })).toMatchObject({ source: "CLICK_TO_WHATSAPP_AD", campaignId: null, fullName: "+201044446666" });
      const web = await (await signed(a.slug, { channel: "WEB_CHAT", from: "01044447777", body: "Hi", externalId: "ext-web" })).json();
      expect(await db.lead.findUniqueOrThrow({ where: { id: web.results[0].leadId } })).toMatchObject({ source: "WEBSITE" });
    });

    it("a known patient's number links the patient and opens no lead; batches are accepted", async () => {
      const res = await signed(a.slug, [
        { from: "01011112222", body: "Can I move my appointment?", externalId: "ext-p1" },
        { from: "01011112222", body: "Thursday would be better", externalId: "ext-p2" },
      ]);
      const body = await res.json();
      expect(body.accepted).toBe(2);
      expect(body.results[0].conversationId).toBe(body.results[1].conversationId);
      const conversation = await db.conversation.findUniqueOrThrow({ where: { id: body.results[0].conversationId } });
      expect(conversation).toMatchObject({ patientId: patientA.id, leadId: null, contactName: "Hala Mansour", contactPhone: "+201011112222" });
      expect(await db.lead.count({ where: { tenantId: a.id, phone: "+201011112222" } })).toBe(0);
    });

    it("rejects a malformed message (422), malformed JSON (400) and an oversized body (413)", async () => {
      expect((await signed(a.slug, { from: "01022223333" })).status).toBe(422);
      expect((await signed(a.slug, { body: "no sender" })).status).toBe(422);
      const raw = "{not json";
      expect((await post(a.slug, raw, { "x-clinicmind-signature": signBody(secret, raw) })).status).toBe(400);
      expect((await post(a.slug, "{}", { "content-length": "5000000", "x-clinicmind-signature": signBody(secret, "{}") })).status).toBe(413);
    });

    it("delivery receipts move this tenant's outbound messages forward only", async () => {
      const conversation = await db.conversation.create({ data: { tenantId: a.id, channel: "WHATSAPP", contactPhone: "+201033334444", status: "WAITING_ON_PATIENT" } });
      const out = await db.message.create({ data: { tenantId: a.id, conversationId: conversation.id, direction: "OUTBOUND", author: "HUMAN", body: "Hi", delivery: "SENT", externalId: "out-1" } });
      const foreign = await db.message.create({
        data: { tenantId: b.id, conversationId: (await db.conversation.create({ data: { tenantId: b.id, channel: "WHATSAPP" } })).id, direction: "OUTBOUND", author: "HUMAN", body: "B", delivery: "SENT" },
      });
      const delivered = await (await signed(a.slug, { event: "message.status", messageId: out.id, status: "delivered" })).json();
      expect(delivered.receipts).toBe(1);
      expect((await db.message.findUniqueOrThrow({ where: { id: out.id } })).delivery).toBe("DELIVERED");
      expect((await (await signed(a.slug, { event: "message.status", externalId: "out-1", status: "sent" })).json()).receipts).toBe(0);
      expect((await (await signed(a.slug, { event: "message.status", externalId: "out-1", status: "read" })).json()).receipts).toBe(1);
      const read = await db.message.findUniqueOrThrow({ where: { id: out.id } });
      expect(read.delivery).toBe("READ");
      expect(read.deliveredAt).toBeTruthy();
      expect((await (await signed(a.slug, { event: "message.status", messageId: foreign.id, status: "failed" })).json()).receipts).toBe(0);
      expect((await db.message.findUniqueOrThrow({ where: { id: foreign.id } })).delivery).toBe("SENT");
      expect((await signed(a.slug, { event: "message.status", status: "read" })).status).toBe(422);
    });
  });

  describe("WhatsApp Cloud webhook", () => {
    it("answers Meta's hub challenge only with the right verify token", async () => {
      process.env.WHATSAPP_VERIFY_TOKEN = "verify-me-please";
      const ok = await verify(a.slug, "hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=1158201444");
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("1158201444");
      expect((await verify(a.slug, "hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403);
      expect((await verify(a.slug, "hub.mode=unsubscribe&hub.verify_token=verify-me-please&hub.challenge=1")).status).toBe(403);
      expect((await verify("no-such-clinic", "hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=1")).status).toBe(403);
      delete process.env.WHATSAPP_VERIFY_TOKEN;
      expect((await verify(a.slug, "hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=1")).status).toBe(403);
    });

    it("accepts Meta's signed payload for a WhatsApp Cloud integration: messages and statuses", async () => {
      process.env.WHATSAPP_APP_SECRET = "meta-app-secret";
      const raw = JSON.stringify(
        metaDelivery({
          contacts: [{ wa_id: "201055556666", profile: { name: "Omar Zaki" } }],
          messages: [{ from: "201055556666", id: "wamid.IN1", timestamp: String(Math.floor(Date.now() / 1000) - 60), type: "text", text: { body: "Is laser painful?" } }],
        }),
      );
      // Not a WhatsApp Cloud integration yet: Meta's signature is not accepted.
      expect((await post(a.slug, raw, { "x-hub-signature-256": signBody("meta-app-secret", raw) })).status).toBe(401);
      const original = await db.channelIntegration.findUniqueOrThrow({ where: { tenantId_channel: { tenantId: a.id, channel: "WHATSAPP" } } });
      await db.channelIntegration.update({ where: { id: original.id }, data: { provider: "whatsapp_cloud" } });
      try {
        expect((await post(a.slug, raw, { "x-hub-signature-256": signBody("another-secret", raw) })).status).toBe(401);
        const res = await post(a.slug, raw, { "x-hub-signature-256": signBody("meta-app-secret", raw) });
        expect(res.status).toBe(200);
        const body = await res.json();
        const conversation = await db.conversation.findUniqueOrThrow({ where: { id: body.results[0].conversationId } });
        expect(conversation).toMatchObject({ contactName: "Omar Zaki", contactPhone: "+201055556666", externalId: "201055556666", objections: ["PAIN"] });

        const out = await db.message.create({ data: { tenantId: a.id, conversationId: conversation.id, direction: "OUTBOUND", author: "HUMAN", body: "Not much", delivery: "SENT", externalId: "wamid.OUT1" } });
        const statusRaw = JSON.stringify(metaDelivery({ statuses: [{ id: "wamid.OUT1", status: "read", timestamp: String(Math.floor(Date.now() / 1000)) }] }));
        const statusRes = await post(a.slug, statusRaw, { "x-hub-signature-256": signBody("meta-app-secret", statusRaw) });
        expect((await statusRes.json()).receipts).toBe(1);
        expect((await db.message.findUniqueOrThrow({ where: { id: out.id } })).delivery).toBe("READ");
        delete process.env.WHATSAPP_APP_SECRET;
        expect((await post(a.slug, raw, { "x-hub-signature-256": signBody("meta-app-secret", raw) })).status).toBe(401);
      } finally {
        await db.channelIntegration.update({ where: { id: original.id }, data: { provider: original.provider, enabled: original.enabled } });
      }
    });
  });

  describe("integration settings", () => {
    it("shows the status to readers (outbound URL shortened) and never the secret", async () => {
      await updateRoute(request("/api/messaging/integration", { method: "PATCH", cookie: ownerCookie, body: { provider: "inbox_webhook", outboundUrl: "http://inbox.example.test/hooks/clinic?token=abc" } }));
      const forOwner = (await (await statusRoute(request("/api/messaging/integration", { cookie: ownerCookie }))).json()).integration;
      expect(forOwner).toMatchObject({ provider: "inbox_webhook", enabled: true, outboundUrl: "http://inbox.example.test/hooks/clinic?token=abc", hasSecret: true, secretPrefix: secret.slice(0, 10) });
      expect(forOwner.inboundUrl).toMatch(new RegExp(`/api/integrations/messaging/inbound/${a.slug}$`));
      expect(forOwner.env).toEqual({ whatsappTokenSet: Boolean(process.env.WHATSAPP_CLOUD_TOKEN?.trim()), whatsappAppSecretSet: false, whatsappVerifyTokenSet: false });
      const forAssistant = await statusRoute(request("/api/messaging/integration", { cookie: assistantCookie }));
      expect(forAssistant.status).toBe(200);
      const text = JSON.stringify(await forAssistant.json());
      expect(text).toContain("http://inbox.example.test/…");
      expect(text).not.toContain("token=abc");
      expect(text).not.toContain(secret);
      expect(JSON.stringify(forOwner)).not.toContain(secret);
      const row = await db.channelIntegration.findFirstOrThrow({ where: { tenantId: a.id } });
      expect(row.secretHash).toBe(createHash("sha256").update(secret).digest("hex"));
      expect(JSON.stringify(row.config)).not.toContain(secret);
    });

    it("only owners connect a channel; WhatsApp Cloud needs a phone number id; bad URLs are 422", async () => {
      const patch = (body: unknown, cookie = ownerCookie, headers?: Record<string, string>) => updateRoute(request("/api/messaging/integration", { method: "PATCH", cookie, body, headers }));
      expect((await patch({ provider: "whatsapp_cloud" }, receptionCookie)).status).toBe(403);
      expect((await patch({ provider: "manual" }, ownerCookie, { origin: "https://evil.example" })).status).toBe(403);
      const missing = await patch({ provider: "whatsapp_cloud" });
      expect(missing.status).toBe(422);
      expect((await missing.json()).issues.fieldErrors.phoneNumberId).toBeTruthy();
      expect((await patch({ provider: "whatsapp_cloud", phoneNumberId: "12ab" })).status).toBe(422);
      expect((await patch({ provider: "inbox_webhook", outboundUrl: "ftp://inbox.example.test/" })).status).toBe(422);
      expect((await patch({ provider: "carrier_pigeon" })).status).toBe(422);
      const cloud = await patch({ provider: "whatsapp_cloud", phoneNumberId: "109876543210" });
      expect(cloud.status).toBe(200);
      expect((await cloud.json()).integration).toMatchObject({ provider: "whatsapp_cloud", enabled: true, phoneNumberId: "109876543210" });
      const manual = await patch({ provider: "manual" });
      expect((await manual.json()).integration).toMatchObject({ provider: "manual", enabled: false });
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "messaging.integration.update" } })).toBeGreaterThanOrEqual(3);
      expect((await secretRoute(request("/api/messaging/integration/secret", { method: "POST", cookie: receptionCookie }))).status).toBe(403);
    });

    it("a test message goes through whatever is connected and reports the result; owners only; foreign patients 404", async () => {
      const send = (body: unknown, cookie = ownerCookie) => testRoute(request("/api/messaging/integration/test", { method: "POST", cookie, body }));
      const res = await send({ patientId: patientA.id });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({ delivery: "LOGGED", failedReason: null });
      const message = await db.message.findUniqueOrThrow({ where: { id: body.messageId } });
      expect(message).toMatchObject({ author: "SYSTEM", direction: "OUTBOUND", body: "Test message from Aura Messaging — please ignore." });
      // An automated message is not an answer: the patient's question still waits on the clinic.
      const thread = await db.conversation.findUniqueOrThrow({ where: { id: body.conversationId } });
      expect(thread.patientId).toBe(patientA.id);
      expect(thread.status).toBe("WAITING_ON_CLINIC");
      expect(thread.lastOutboundAt).toBeTruthy();
      expect((await send({ patientId: patientB.id })).status).toBe(404);
      expect((await send({ patientId: patientA.id }, receptionCookie)).status).toBe(403);
      expect((await send({})).status).toBe(422);
    });
  });

  describe("outbound adapters", () => {
    let conversationId: string;

    beforeAll(async () => {
      conversationId = (await db.conversation.create({ data: { tenantId: a.id, channel: "WHATSAPP", patientId: patientA.id, contactPhone: "+201011112222", status: "WAITING_ON_CLINIC" } })).id;
    });

    async function replyWith(body: string) {
      const res = await replyRoute(request(`/api/conversations/${conversationId}/messages`, { method: "POST", cookie: receptionCookie, body: { body } }), idParams(conversationId));
      expect(res.status).toBe(201);
      return (await res.json()) as { message: { id: string; externalId: string | null }; delivery: string; failedReason: string | null };
    }
    const connect = (provider: string, config: Record<string, unknown>) =>
      db.channelIntegration.update({ where: { tenantId_channel: { tenantId: a.id, channel: "WHATSAPP" } }, data: { provider, enabled: true, config: { ...config, secretEncrypted: undefined } } });

    it("WhatsApp Cloud: posts the text to the Graph API with the server token and stores Meta's message id", async () => {
      const row = await db.channelIntegration.findFirstOrThrow({ where: { tenantId: a.id } });
      const encrypted = (row.config as { secretEncrypted?: string }).secretEncrypted;
      await db.channelIntegration.update({ where: { id: row.id }, data: { provider: "whatsapp_cloud", enabled: true, config: { phoneNumberId: "109876543210", secretEncrypted: encrypted } } });
      process.env.WHATSAPP_CLOUD_TOKEN = "EAAG-test-token";
      const calls: { url: string; init: RequestInit }[] = [];
      __setMessagingFetchForTests(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.SENT1" }] }), { status: 200, headers: { "content-type": "application/json" } });
      });
      const sent = await replyWith("Your consultation is confirmed.");
      expect(sent).toMatchObject({ delivery: "SENT", failedReason: null });
      expect(sent.message.externalId).toBe("wamid.SENT1");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://graph.facebook.com/v20.0/109876543210/messages");
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer EAAG-test-token");
      expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ messaging_product: "whatsapp", to: "201011112222", type: "text", text: { body: "Your consultation is confirmed." } });
      expect((await db.channelIntegration.findUniqueOrThrow({ where: { id: row.id } })).lastOutboundAt).toBeTruthy();

      __setMessagingFetchForTests(async () => new Response(JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), { status: 400 }));
      const windowClosed = await replyWith("Are you still interested?");
      expect(windowClosed.delivery).toBe("FAILED");
      expect(windowClosed.failedReason).toMatch(/24-hour window/);
      expect((await db.message.findUniqueOrThrow({ where: { id: windowClosed.message.id } })).failedReason).toMatch(/24-hour window/);

      delete process.env.WHATSAPP_CLOUD_TOKEN;
      const noToken = await replyWith("Hello?");
      expect(noToken).toMatchObject({ delivery: "FAILED", failedReason: "WHATSAPP_CLOUD_TOKEN is not set on the server" });
    });

    it("inbox webhook: signs every call with the tenant's secret, refuses redirects and needs a secret", async () => {
      const row = await db.channelIntegration.findFirstOrThrow({ where: { tenantId: a.id } });
      const encrypted = (row.config as { secretEncrypted?: string }).secretEncrypted;
      await db.channelIntegration.update({ where: { id: row.id }, data: { provider: "inbox_webhook", enabled: true, config: { outboundUrl: "http://inbox.example.test/hook", secretEncrypted: encrypted } } });
      let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
      __setMessagingFetchForTests(async (url, init) => {
        seen = { url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) };
        expect(init?.redirect).toBe("manual");
        return new Response(JSON.stringify({ id: "inbox-777" }), { status: 202 });
      });
      const sent = await replyWith("See you on Thursday.");
      expect(sent).toMatchObject({ delivery: "SENT", failedReason: null });
      expect(sent.message.externalId).toBe("inbox-777");
      expect(seen!.url).toBe("http://inbox.example.test/hook");
      expect(signatureMatches(secret, seen!.body, seen!.headers["x-clinicmind-signature"])).toBe(true);
      expect(JSON.parse(seen!.body)).toMatchObject({ event: "message.outbound", messageId: sent.message.id, conversationId, to: "+201011112222", body: "See you on Thursday." });

      __setMessagingFetchForTests(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
      expect(await replyWith("Redirect me")).toMatchObject({ delivery: "FAILED", failedReason: "HTTP 302: redirects are not followed" });

      await connect("inbox_webhook", { outboundUrl: "http://inbox.example.test/hook" });
      await db.channelIntegration.update({ where: { id: row.id }, data: { secretHash: null, secretPrefix: null } });
      expect(await replyWith("No secret")).toMatchObject({ delivery: "FAILED", failedReason: "Generate the webhook secret first (Settings → Messaging)" });
    });

    it("logged mode: with the channel disabled the reply is written to the record only", async () => {
      await db.channelIntegration.update({ where: { tenantId_channel: { tenantId: a.id, channel: "WHATSAPP" } }, data: { enabled: false } });
      __setMessagingFetchForTests(async () => {
        throw new Error("no network call expected");
      });
      expect(await replyWith("Logged only")).toMatchObject({ delivery: "LOGGED", failedReason: null });
    });
  });
});
