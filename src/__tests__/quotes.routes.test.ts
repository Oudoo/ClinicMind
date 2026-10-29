/**
 * Treatment plans and quotes (Phase 5) over the real route handlers and the
 * test database: a draft is priced from today's list for its branch, with
 * discounts inside the role's limit and their reasons; giving it numbers it
 * in the branch's quote sequence and fixes it (the database refuses any
 * change); it is sent on WhatsApp in its language behind a link, the latest
 * link being the one that works; the patient accepts all of it or some items
 * with a signature, from the link or on the clinic's screen, and the accepted
 * items become planned procedures at the quoted prices, with no day until
 * they are done, which the recall list picks up when nothing is booked; an
 * expired quote is accepted only once given more days; declines, withdrawals
 * and revisions; case acceptance by count and value; RBAC and isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, dateKeyInTz, startOfDayInTz } from "@/lib/time";
import { formatDocumentNumber } from "@/modules/finance/documents";
import { cleanSignature, quoteState, quoteTotals, strokesToPath } from "@/modules/quotes/constants";
import { unitWord } from "@/modules/quotes/copy";
import { quoteByToken, quoteMessage } from "@/modules/quotes/service";
import { sweepRecalls } from "@/modules/recalls/engine";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { GET as listRoute, POST as createRoute } from "@/app/api/quotes/route";
import { DELETE as discardRoute, GET as getRoute, PATCH as patchRoute } from "@/app/api/quotes/[id]/route";
import { POST as giveRoute } from "@/app/api/quotes/[id]/give/route";
import { POST as sendRoute } from "@/app/api/quotes/[id]/send/route";
import { POST as acceptRoute } from "@/app/api/quotes/[id]/accept/route";
import { POST as declineRoute } from "@/app/api/quotes/[id]/decline/route";
import { POST as withdrawRoute } from "@/app/api/quotes/[id]/withdraw/route";
import { POST as extendRoute } from "@/app/api/quotes/[id]/extend/route";
import { POST as reviseRoute } from "@/app/api/quotes/[id]/revise/route";
import { GET as acceptanceRoute } from "@/app/api/quotes/acceptance/route";
import { GET as publicGet, POST as publicPost } from "@/app/api/public/quotes/[token]/route";
import { POST as signRoute } from "@/app/api/procedures/[id]/sign/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const DAY = 86_400_000;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });
const dayKey = (n: number) => dateKeyInTz(addDays(new Date(), n, TZ), TZ);
/** A hand-drawn signature: eight points across the pad. */
const SIGNATURE = "M20,120 L60,90 L100,110 L140,70 L180,100 L220,60 L260,95 L300,80";

describe("quotes (pure)", () => {
  it("a quote given is expired once its last valid day has passed; nothing else expires", () => {
    expect(quoteState("SENT", "2026-11-28", "2026-11-28")).toBe("SENT");
    expect(quoteState("SENT", "2026-11-28", "2026-11-29")).toBe("EXPIRED");
    expect(quoteState("DRAFT", "2026-11-28", "2026-12-30")).toBe("DRAFT");
    expect(quoteState("ACCEPTED", "2026-11-28", "2026-12-30")).toBe("ACCEPTED");
  });

  it("takes a drawn signature, and nothing that is not one", () => {
    expect(cleanSignature(`  ${SIGNATURE.replace(/ /g, "   ")} `)).toBe(SIGNATURE);
    expect(cleanSignature(strokesToPath([[{ x: 20.4, y: 120 }, { x: 60, y: 90.6 }, { x: 100, y: 110 }, { x: 140, y: 70 }], [{ x: 180, y: 100 }, { x: 220, y: 60 }, { x: 260, y: 95 }, { x: 900, y: -5 }]]))).toBe(
      "M20,120 L60,91 L100,110 L140,70 M180,100 L220,60 L260,95 L600,0",
    );
    expect(cleanSignature("M10,10 L11,11 L12,10 L11,12 L10,11 L12,12 L11,10 L10,12")).toBeNull(); // a dot
    expect(cleanSignature("M10,10 L50,10 L90,10")).toBeNull(); // three points
    expect(cleanSignature(`${SIGNATURE} L700,10`)).toBeNull(); // off the pad
    expect(cleanSignature(`L20,120 ${SIGNATURE}`)).toBeNull(); // starts with a line
    expect(cleanSignature(`${SIGNATURE}"/><script>alert(1)</script>`)).toBeNull();
    expect(cleanSignature(42)).toBeNull();
  });

  it("adds up a plan, and words its units", () => {
    expect(quoteTotals([{ price: 50_000, discount: 0 }, { price: 9_000, discount: 900 }])).toEqual({ list: 59_000, discount: 900, total: 58_100 });
    expect(unitWord("UNIT", "graft", 2_000, "en")).toBe("grafts");
    expect(unitWord("AREA", null, 1, "en")).toBe("area");
    expect(unitWord("TOOTH", null, 2, "en")).toBe("teeth");
    expect(unitWord("SESSION", null, 6, "ar")).toBe("جلسة");
  });

  it("writes the message in the quote's language, with the total and the last valid day", () => {
    const quote = { language: "ar" as const, number: "ZAM-QT-000003", tenantName: "Aura", total: 58_100, validUntil: "2026-11-27T22:00:00.000Z", timezone: TZ, patient: { id: "p", fullName: "Salma Adel", phone: null, language: "ar" } };
    expect(quoteMessage(quote, "https://x.test/q/abc")).toBe("مرحبًا Salma، خطة علاجك رقم ZAM-QT-000003 من Aura بإجمالي 58,100 جنيه، سارية حتى 28 نوفمبر 2026. يمكنك الاطلاع عليها والموافقة عليها من هنا: https://x.test/q/abc");
    expect(quoteMessage({ ...quote, language: "en" }, "https://x.test/q/abc")).toBe("Hi Salma, your treatment plan ZAM-QT-000003 from Aura: 58,100 EGP, valid until 28 November 2026. See it and accept it here: https://x.test/q/abc");
    expect(formatDocumentNumber("ZAM", "QUOTE", 3)).toBe("ZAM-QT-000003");
  });
});

describe.skipIf(!dbTestsEnabled)("quote routes", () => {
  const created: string[] = [];
  let a: string;
  let c: string;
  let zamalek: string;
  let dokki: string;
  let doctorId: string;
  let ownerId: string;
  let receptionId: string;
  let ownerCookie: string;
  let doctorCookie: string;
  let receptionCookie: string;
  let nurseCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let ownerCCookie: string;
  const item: Record<string, string> = {};
  let n = 0;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const post = (route: (req: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, id: string, body: unknown, cookie: string) =>
    route(request(path, { method: "POST", cookie, body }), params(id)).then(json);
  const draft = (body: Record<string, unknown>, cookie = receptionCookie) => createRoute(request("/api/quotes", { method: "POST", cookie, body })).then(json);
  const patch = (id: string, body: Record<string, unknown>, cookie = receptionCookie) => patchRoute(request(`/api/quotes/${id}`, { method: "PATCH", cookie, body }), params(id)).then(json);
  const read = (id: string, cookie = receptionCookie) => getRoute(request(`/api/quotes/${id}`, { cookie }), params(id)).then(json);
  const give = (id: string, cookie = receptionCookie) => post(giveRoute, `/api/quotes/${id}/give`, id, undefined, cookie);
  const send = (id: string, cookie = receptionCookie) => post(sendRoute, `/api/quotes/${id}/send`, id, undefined, cookie);
  const answer = (token: string, body: unknown) => publicPost(request(`/api/public/quotes/${token}`, { method: "POST", body }), tokenParams(token)).then(json);
  const patient = async (name: string, language = "en", tenantId = a) => (await db.patient.create({ data: { tenantId, fullName: name, phone: `+2010088${String(++n).padStart(5, "0")}`, language } })).id;
  const plan = (patientId: string, extra: Record<string, unknown> = {}) => ({
    patientId,
    doctorId,
    phases: [
      { title: "Restoration", items: [{ priceItemId: item.grafts, quantity: 2_000, site: "Crown" }, { priceItemId: item.prp, quantity: 2 }] },
      { title: "Maintenance", items: [{ priceItemId: item.laser, quantity: 6, discount: 900, discountReason: "LOYALTY" }] },
    ],
    ...extra,
  });
  const tokenOf = (link: string) => link.split("/q/")[1] as string;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `quote-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `quote-b-${Date.now().toString(36)}` });
    const tenantC = await createTenant({ slug: `quote-c-${Date.now().toString(36)}` });
    a = tenantA.id;
    c = tenantC.id;
    created.push(a, tenantB.id, c);
    zamalek = (await db.clinic.findFirstOrThrow({ where: { tenantId: a } })).id;
    await db.clinic.update({ where: { id: zamalek }, data: { name: "Test Clinic — Zamalek" } });
    dokki = (await db.clinic.create({ data: { tenantId: a, name: "Test Clinic — Dokki" } })).id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Plan" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const nurse = await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" });
    const ownerC = await createUser({ tenantId: c, role: "CLINIC_OWNER", fullName: "Owner C" });
    ownerId = owner.id;
    doctorId = doctor.id;
    receptionId = reception.id;
    ownerCookie = await sessionCookieFor(owner.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    receptionCookie = await sessionCookieFor(reception.id);
    nurseCookie = await sessionCookieFor(nurse.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    ownerCCookie = await sessionCookieFor(ownerC.id);
    for (const t of [a, tenantB.id, c]) await ensureDefaultTreatments(t);
    const treatment = Object.fromEntries((await db.treatment.findMany({ where: { tenantId: a } })).map((t) => [t.key, t.id]));
    const since = new Date(Date.now() - 400 * DAY);
    const make = async (key: string, data: { code: string; name: string; category: string; unit: "UNIT" | "PACKAGE" | "SESSION" | "VISIT"; unitLabel?: string; sessions?: number; treatment: string; amount: number }, tenantId = a) =>
      (item[key] = (
        await db.priceItem.create({
          data: {
            tenantId,
            code: data.code,
            name: data.name,
            category: data.category,
            unit: data.unit,
            unitLabel: data.unitLabel ?? null,
            sessions: data.sessions ?? null,
            treatmentId: data.treatment,
            prices: { create: { tenantId, amount: data.amount, effectiveFrom: since } },
          },
        })
      ).id);
    await make("grafts", { code: "FUE-G", name: "FUE hair transplant", category: "hair", unit: "UNIT", unitLabel: "graft", treatment: treatment["hair-transplant"]!, amount: 25 });
    await make("prp", { code: "PRP-3", name: "PRP for hair loss, 3 sessions", category: "hair", unit: "PACKAGE", sessions: 3, treatment: treatment["prp-hair"]!, amount: 9_000 });
    await make("laser", { code: "LHR-S", name: "Laser hair removal, one session", category: "laser", unit: "SESSION", treatment: treatment["laser-hair-removal"]!, amount: 1_500 });
    await make("old", { code: "OLD-1", name: "Retired peel", category: "skin", unit: "VISIT", treatment: treatment.pigmentation!, amount: 800 });
    await db.priceItem.update({ where: { id: item.old }, data: { active: false } });
    // Dokki prices the laser session at 1,300.
    await db.priceItemPrice.create({ data: { tenantId: a, priceItemId: item.laser!, clinicId: dokki, amount: 1_300, effectiveFrom: since } });
    const treatmentB = await db.treatment.findFirstOrThrow({ where: { tenantId: tenantB.id, key: "acne" } });
    await make("foreign", { code: "B-1", name: "Their item", category: "skin", unit: "VISIT", treatment: treatmentB.id, amount: 500 }, tenantB.id);
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("drafts", () => {
    let p: string;
    let id: string;

    beforeAll(async () => {
      p = await patient("Salma Adel", "ar");
    });

    it("prices a plan from today's list for its branch: sessions, a course as one, discounts with their reasons", async () => {
      const made = await draft(plan(p));
      expect(made.res.status, JSON.stringify(made.json)).toBe(201);
      id = made.json.quote.id;
      expect(made.json.quote).toMatchObject({
        number: null,
        status: "DRAFT",
        state: "DRAFT",
        language: "ar",
        phases: ["Restoration", "Maintenance"],
        validUntilKey: dayKey(30),
        listTotal: 68_000,
        discountTotal: 900,
        total: 67_100,
        clinic: { id: zamalek },
        doctor: { id: doctorId, fullName: "Dr. Plan" },
      });
      expect(made.json.quote.items.map((i: { phase: number; description: string; site: string | null; quantity: number; stages: number; unitPrice: number; price: number; discount: number; net: number }) => [i.phase, i.description, i.site, i.quantity, i.stages, i.unitPrice, i.price, i.discount, i.net])).toEqual([
        [0, "FUE hair transplant", "Crown", 2_000, 1, 25, 50_000, 0, 50_000],
        [0, "PRP for hair loss, 3 sessions", null, 1, 3, 9_000, 9_000, 0, 9_000],
        [1, "Laser hair removal, one session", null, 6, 6, 1_500, 9_000, 900, 8_100],
      ]);
      const stored = await db.quoteItem.findFirstOrThrow({ where: { quoteId: id, priceItemId: item.laser } });
      expect(stored).toMatchObject({ discountReason: "LOYALTY", discountById: receptionId });
      expect(await db.auditLog.count({ where: { tenantId: a, action: "quote.draft", entityId: id } })).toBe(1);
    });

    it("refuses a discount above the role's limit, without its reason, or on items not on the list", async () => {
      const tooMuch = await draft(plan(p, { phases: [{ title: "One", items: [{ priceItemId: item.laser, quantity: 2, discount: 600, discountReason: "LOYALTY" }] }] }));
      expect(tooMuch.res.status).toBe(403);
      expect(tooMuch.json).toMatchObject({ error: "discount_limit", limit: 10, asked: 20 });
      expect(tooMuch.json.message).toContain("Laser hair removal, one session: Your role can give up to 10% off");
      const noReason = await draft(plan(p, { phases: [{ title: "One", items: [{ priceItemId: item.laser, discount: 100 }] }] }));
      expect(noReason.res.status).toBe(422);
      const retired = await draft(plan(p, { phases: [{ title: "One", items: [{ priceItemId: item.old }] }] }));
      expect(retired.res.status).toBe(422);
      expect(JSON.stringify(retired.json)).toContain("no longer on the price list");
      expect((await draft(plan(p, { phases: [{ title: "One", items: [{ priceItemId: item.foreign }] }] }))).res.status).toBe(404);
      expect((await draft(plan(p, { validUntil: dayKey(-1) }))).res.status).toBe(422);
      expect((await draft(plan(p, { validUntil: dayKey(400) }))).res.status).toBe(422);
      expect((await draft({ patientId: p, phases: [] })).res.status).toBe(422);
    });

    it("a branch's own price applies at that branch", async () => {
      const made = await draft({ patientId: p, clinicId: dokki, phases: [{ title: "Laser", items: [{ priceItemId: item.laser, quantity: 6 }] }] });
      expect(made.res.status).toBe(201);
      expect(made.json.quote).toMatchObject({ total: 7_800, clinic: { id: dokki } });
      // Moving the draft to Zamalek prices it there.
      const moved = await patch(made.json.quote.id, { clinicId: zamalek });
      expect(moved.json.quote).toMatchObject({ total: 9_000, clinic: { id: zamalek } });
      expect((await discardRoute(request(`/api/quotes/${made.json.quote.id}`, { method: "DELETE", cookie: receptionCookie }), params(made.json.quote.id))).status).toBe(200);
      expect(await db.quote.count({ where: { id: made.json.quote.id } })).toBe(0);
    });

    it("changes freely while a draft; the owner's larger discount stays when the desk saves it again, unchanged", async () => {
      const current = (await read(id)).json.quote;
      const phasesWith = (discount: number, reason: string) => [
        { title: "Restoration", items: current.items.filter((i: { phase: number }) => i.phase === 0).map((i: { id: string; priceItemId: string; quantity: number; site: string | null }) => ({ id: i.id, priceItemId: i.priceItemId, quantity: i.quantity, site: i.site ?? undefined })) },
        { title: "Maintenance", items: current.items.filter((i: { phase: number }) => i.phase === 1).map((i: { id: string; priceItemId: string; quantity: number }) => ({ id: i.id, priceItemId: i.priceItemId, quantity: i.quantity, discount, discountReason: reason })) },
      ];
      const byOwner = await patch(id, { phases: phasesWith(2_700, "DOCTOR") }, ownerCookie);
      expect(byOwner.res.status, JSON.stringify(byOwner.json)).toBe(200);
      expect(byOwner.json.quote.total).toBe(65_300);
      const after = (await read(id)).json.quote;
      const again = [
        { title: "Restoration", items: after.items.filter((i: { phase: number }) => i.phase === 0).map((i: { id: string; priceItemId: string; quantity: number; site: string | null }) => ({ id: i.id, priceItemId: i.priceItemId, quantity: i.quantity, site: i.site ?? undefined })) },
        { title: "Maintenance", items: after.items.filter((i: { phase: number }) => i.phase === 1).map((i: { id: string; priceItemId: string; quantity: number }) => ({ id: i.id, priceItemId: i.priceItemId, quantity: i.quantity, discount: 2_700, discountReason: "DOCTOR" })) },
      ];
      const byDesk = await patch(id, { title: "Hair restoration plan", phases: again });
      expect(byDesk.res.status, JSON.stringify(byDesk.json)).toBe(200);
      expect(byDesk.json.quote).toMatchObject({ title: "Hair restoration plan", total: 65_300 });
      expect((await db.quoteItem.findFirstOrThrow({ where: { quoteId: id, priceItemId: item.laser } })).discountById).toBe(ownerId);
      const raised = (await read(id)).json.quote;
      const more = [again[0], { title: "Maintenance", items: [{ id: raised.items[2].id, priceItemId: item.laser, quantity: 6, discount: 2_800, discountReason: "DOCTOR" }] }];
      expect((await patch(id, { phases: more })).res.status).toBe(403);
      // Back to the desk's own 10%.
      expect((await patch(id, { phases: phasesWith(900, "LOYALTY") })).json.quote.total).toBe(67_100);
    });

    it("giving it takes the branch's next quote number; from then on the database refuses any change", async () => {
      const given = await give(id);
      expect(given.res.status).toBe(200);
      expect(given.json.quote).toMatchObject({ number: "ZAM-QT-000001", status: "SENT", state: "SENT" });
      expect(given.json.quote.sentAt).toBeTruthy();
      expect((await give(id)).json.quote.number).toBe("ZAM-QT-000001");
      expect((await patch(id, { title: "Changed" })).res.status).toBe(409);
      expect((await discardRoute(request(`/api/quotes/${id}`, { method: "DELETE", cookie: receptionCookie }), params(id))).status).toBe(409);
      const one = await db.quoteItem.findFirstOrThrow({ where: { quoteId: id } });
      await expect(db.quoteItem.update({ where: { id: one.id }, data: { price: 1 } })).rejects.toThrow(/never change/);
      await expect(db.quoteItem.delete({ where: { id: one.id } })).rejects.toThrow(/never change/);
      await expect(db.quote.update({ where: { id }, data: { total: 1 } })).rejects.toThrow(/keeps its number/);
      await expect(db.quote.delete({ where: { id } })).rejects.toThrow(/never deleted/);
      const timeline = await db.timelineEvent.findFirstOrThrow({ where: { tenantId: a, patientId: p, refId: id } });
      expect(timeline.title).toBe("Treatment plan ZAM-QT-000001 given — 67,100 EGP");
    });

    it("is sent on WhatsApp in its language behind a link; the latest link is the one that works, and shows nothing internal", async () => {
      const sent = await send(id);
      expect(sent.res.status, JSON.stringify(sent.json)).toBe(200);
      expect(sent.json.link).toMatch(/\/q\/[A-Za-z0-9_-]{40,}$/);
      const message = await db.message.findFirstOrThrow({ where: { tenantId: a, templateKey: "quote:send" }, orderBy: { createdAt: "desc" } });
      expect(message.body).toContain("خطة علاجك رقم ZAM-QT-000001");
      expect(message.body).toContain(sent.json.link);
      const first = tokenOf(sent.json.link);
      expect((await quoteByToken(first))?.number).toBe("ZAM-QT-000001");
      const again = await send(id);
      expect(await quoteByToken(first)).toBeNull();
      const token = tokenOf(again.json.link);
      const page = await publicGet(request(`/api/public/quotes/${token}`), tokenParams(token)).then(json);
      expect(page.res.status).toBe(200);
      expect(page.json.quote).toMatchObject({ number: "ZAM-QT-000001", total: 67_100, language: "ar" });
      for (const hidden of ["declineReason", "withdrawnReason", "revisions", "revisionOf"]) expect(page.json.quote).not.toHaveProperty(hidden);
      expect(page.json.quote.items[0]).not.toHaveProperty("procedure");
      expect(page.json.quote.items[2]).not.toHaveProperty("discountReason");
      expect((await publicGet(request("/api/public/quotes/not-a-real-token-at-all"), tokenParams("not-a-real-token-at-all"))).status).toBe(404);
    });

    it("the patient accepts part of it from the link with a signature: planned procedures at the quoted prices", async () => {
      const token = tokenOf((await send(id)).json.link);
      const quote = (await read(id)).json.quote;
      const [grafts, prp, laser] = quote.items as { id: string }[];
      const bad = async (body: Record<string, unknown>) => (await answer(token, { action: "accept", itemIds: [grafts!.id], name: "Salma Adel", signature: SIGNATURE, agree: true, ...body })).res.status;
      expect(await bad({ signature: "M1,1 L2,2" })).toBe(422);
      expect(await bad({ agree: false })).toBe(422);
      expect(await bad({ itemIds: [] })).toBe(422);
      expect(await bad({ itemIds: ["someone-elses-item"] })).toBe(422);
      expect(await bad({ name: " " })).toBe(422);
      expect((await answer(token, { action: "maybe" })).res.status).toBe(422);

      const accepted = await answer(token, { action: "accept", itemIds: [grafts!.id, laser!.id], name: "Salma Adel", signature: SIGNATURE, agree: true });
      expect(accepted.res.status, JSON.stringify(accepted.json)).toBe(200);
      expect(accepted.json.quote).toMatchObject({ status: "ACCEPTED", acceptedVia: "link", acceptedName: "Salma Adel", acceptedTotal: 58_100, signature: SIGNATURE });
      const items = await db.quoteItem.findMany({ where: { quoteId: id }, orderBy: { position: "asc" } });
      expect(items.map((i) => i.accepted)).toEqual([true, false, true]);
      expect(items[1]!.procedureId).toBeNull();
      const procedures = await db.procedure.findMany({ where: { id: { in: [items[0]!.procedureId!, items[2]!.procedureId!] } }, orderBy: { price: "desc" } });
      expect(procedures.map((pr) => [pr.status, pr.undated, pr.price, pr.discount, pr.discountReason, pr.stages, pr.quantity, pr.doctorId, pr.priceItemId])).toEqual([
        ["PLANNED", true, 50_000, 0, null, 1, 2_000, doctorId, item.grafts],
        ["PLANNED", true, 9_000, 900, "LOYALTY", 6, 6, doctorId, item.laser],
      ]);
      expect(procedures[0]!.notes).toBe("Site: Crown · Treatment plan ZAM-QT-000001");
      expect(await db.auditLog.count({ where: { tenantId: a, action: "procedure.create", entityId: { in: procedures.map((pr) => pr.id) } } })).toBe(2);
      expect(await db.auditLog.count({ where: { tenantId: a, action: "quote.accept", entityId: id } })).toBe(1);
      const told = await db.notification.findMany({ where: { tenantId: a, kind: "QUOTE_ANSWERED" }, select: { userId: true, title: true } });
      expect(new Set(told.map((t) => t.userId))).toEqual(new Set([doctorId, receptionId]));
      expect(told[0]!.title).toBe("Salma Adel accepted treatment plan ZAM-QT-000001");
      // Answered: the link shows the signed copy, and takes no second answer.
      expect((await answer(token, { action: "accept", itemIds: [prp!.id], name: "Salma Adel", signature: SIGNATURE, agree: true })).res.status).toBe(409);
      expect((await answer(token, { action: "decline" })).res.status).toBe(409);
      expect((await quoteByToken(token))?.status).toBe("ACCEPTED");
      await expect(db.quote.update({ where: { id }, data: { acceptedTotal: 1 } })).rejects.toThrow(/final/);
    });

    it("what was accepted feeds the recall list when nothing is booked for it", async () => {
      await sweepRecalls(new Date(Date.now() + 4 * DAY), { tenantId: a });
      const recall = await db.recall.findFirstOrThrow({ where: { tenantId: a, patientId: p, kind: "UNBOOKED" } });
      expect(recall.label).toMatch(/\(ZAM-QT-000001\), not booked$/);
      const opened = await db.recallActivity.findFirstOrThrow({ where: { recallId: recall.id, kind: "STATUS" } });
      expect(opened.note).toContain("accepted in treatment plan ZAM-QT-000001");
    });

    it("an accepted procedure with no day is dated the day it is signed", async () => {
      const grafts = await db.quoteItem.findFirstOrThrow({ where: { quoteId: id, priceItemId: item.grafts } });
      const longAgo = new Date(Date.now() - 10 * DAY);
      await db.procedure.update({ where: { id: grafts.procedureId! }, data: { performedAt: longAgo } });
      const signed = await signRoute(request(`/api/procedures/${grafts.procedureId}/sign`, { method: "POST", cookie: doctorCookie }), params(grafts.procedureId!));
      expect(signed.status).toBe(200);
      const procedure = await db.procedure.findUniqueOrThrow({ where: { id: grafts.procedureId! } });
      expect(procedure).toMatchObject({ status: "SIGNED", undated: false });
      expect(dateKeyInTz(procedure.performedAt, TZ)).toBe(dayKey(0));
      const charge = await db.charge.findFirstOrThrow({ where: { procedureId: procedure.id } });
      expect(charge.amount).toBe(50_000);
      expect(dateKeyInTz(charge.chargedAt, TZ)).toBe(dayKey(0));
    });
  });

  describe("expiry, answers in the clinic, declines, withdrawals and revisions", () => {
    it("an expired quote cannot be accepted until it is given more days; then it is signed on the clinic's screen", async () => {
      const p = await patient("Expired Patient");
      const id = (await draft({ patientId: p, phases: [{ title: "Laser", items: [{ priceItemId: item.laser, quantity: 3 }] }] })).json.quote.id;
      const token = tokenOf((await send(id)).json.link);
      await db.quote.update({ where: { id }, data: { validUntil: addDays(startOfDayInTz(new Date(), TZ), -1, TZ) } });
      expect((await read(id)).json.quote.state).toBe("EXPIRED");
      const list = await listRoute(request("/api/quotes?state=EXPIRED", { cookie: receptionCookie })).then(json);
      expect(list.json.quotes.map((q: { id: string }) => q.id)).toContain(id);
      const itemIds = (await read(id)).json.quote.items.map((i: { id: string }) => i.id);
      const late = await answer(token, { action: "accept", itemIds, name: "Expired Patient", signature: SIGNATURE, agree: true });
      expect(late.res.status).toBe(409);
      expect((await send(id)).res.status).toBe(409);
      expect((await post(extendRoute, `/api/quotes/${id}/extend`, id, { validUntil: dayKey(-1) }, receptionCookie)).res.status).toBe(422);
      const extended = await post(extendRoute, `/api/quotes/${id}/extend`, id, { validUntil: dayKey(10) }, receptionCookie);
      expect(extended.json.quote).toMatchObject({ state: "SENT", validUntilKey: dayKey(10) });
      const inClinic = await post(acceptRoute, `/api/quotes/${id}/accept`, id, { itemIds, name: "Expired Patient", signature: SIGNATURE, agree: true }, receptionCookie);
      expect(inClinic.res.status, JSON.stringify(inClinic.json)).toBe(200);
      expect(inClinic.json.quote).toMatchObject({ status: "ACCEPTED", acceptedVia: "clinic", acceptedTotal: 4_500 });
      expect((await db.quote.findUniqueOrThrow({ where: { id } })).acceptedById).toBe(receptionId);
      // Signed in the clinic: nobody needs telling.
      expect(await db.notification.count({ where: { tenantId: a, kind: "QUOTE_ANSWERED", entityId: id } })).toBe(0);
    });

    it("a draft signed on the clinic's screen is given in the same step; behind no link", async () => {
      const p = await patient("Walk-in Patient");
      const made = (await draft({ patientId: p, phases: [{ title: "PRP", items: [{ priceItemId: item.prp }] }] }, doctorCookie)).json.quote;
      const signed = await post(acceptRoute, `/api/quotes/${made.id}/accept`, made.id, { itemIds: [made.items[0].id], name: "Walk-in Patient", signature: SIGNATURE, agree: true }, doctorCookie);
      expect(signed.res.status).toBe(200);
      expect(signed.json.quote).toMatchObject({ status: "ACCEPTED", number: "ZAM-QT-000003", acceptedTotal: 9_000 });
      expect(signed.json.quote.sentAt).toBeTruthy();
    });

    it("declined from the link with the patient's words; the clinic hears it", async () => {
      const p = await patient("Declining Patient");
      const id = (await draft({ patientId: p, doctorId, phases: [{ title: "Laser", items: [{ priceItemId: item.laser }] }] })).json.quote.id;
      const token = tokenOf((await send(id)).json.link);
      const declined = await answer(token, { action: "decline", reason: "Too expensive for me this month" });
      expect(declined.res.status).toBe(200);
      expect(declined.json.quote.status).toBe("DECLINED");
      expect(declined.json.quote).not.toHaveProperty("declineReason");
      expect((await read(id)).json.quote.declineReason).toBe("Too expensive for me this month");
      const told = await db.notification.findFirstOrThrow({ where: { tenantId: a, kind: "QUOTE_ANSWERED", entityId: id, userId: doctorId } });
      expect(told).toMatchObject({ title: "Declining Patient declined treatment plan ZAM-QT-000004", body: '"Too expensive for me this month"', level: "WARNING" });
      expect((await post(declineRoute, `/api/quotes/${id}/decline`, id, {}, receptionCookie)).res.status).toBe(409);
      expect((await post(withdrawRoute, `/api/quotes/${id}/withdraw`, id, { reason: "Changed plan" }, receptionCookie)).res.status).toBe(409);
    });

    it("a revision is a new draft of the same plan; once given, it replaces the open quote", async () => {
      const p = await patient("Revised Patient");
      const id = (await draft({ patientId: p, phases: [{ title: "Laser", items: [{ priceItemId: item.laser, quantity: 6, discount: 900, discountReason: "PACKAGE" }] }] }, ownerCookie)).json.quote.id;
      await give(id, ownerCookie);
      const revised = await post(reviseRoute, `/api/quotes/${id}/revise`, id, undefined, receptionCookie);
      expect(revised.res.status, JSON.stringify(revised.json)).toBe(201);
      const revision = revised.json.quote;
      expect(revision).toMatchObject({ status: "DRAFT", number: null, total: 8_100, revisionOf: { id } });
      expect((await read(id)).json.quote.revisions).toEqual([{ id: revision.id, number: null, status: "DRAFT" }]);
      expect((await read(id)).json.quote.status).toBe("SENT");
      const given = await give(revision.id);
      const original = (await read(id)).json.quote;
      expect(original).toMatchObject({ status: "WITHDRAWN", withdrawnReason: `Replaced by ${given.json.quote.number}` });
      const withdrawal = await db.auditLog.findFirstOrThrow({ where: { tenantId: a, action: "quote.withdraw", entityId: id } });
      expect(withdrawal.after).toMatchObject({ reason: `Replaced by ${given.json.quote.number}` });
      expect(withdrawal.patientId).toBe(p);
      expect((await post(reviseRoute, `/api/quotes/${revision.id}/revise`, revision.id, undefined, receptionCookie)).res.status).toBe(201);
    });

    it("the clinic withdraws an open quote with a reason; a draft is discarded instead", async () => {
      const p = await patient("Withdrawn Patient");
      const id = (await draft({ patientId: p, phases: [{ title: "PRP", items: [{ priceItemId: item.prp }] }] })).json.quote.id;
      expect((await post(withdrawRoute, `/api/quotes/${id}/withdraw`, id, { reason: "Doctor changed the plan" }, receptionCookie)).res.status).toBe(409);
      await give(id);
      expect((await post(withdrawRoute, `/api/quotes/${id}/withdraw`, id, { reason: "x" }, receptionCookie)).res.status).toBe(422);
      const withdrawn = await post(withdrawRoute, `/api/quotes/${id}/withdraw`, id, { reason: "Doctor changed the plan" }, receptionCookie);
      expect(withdrawn.json.quote).toMatchObject({ status: "WITHDRAWN", withdrawnReason: "Doctor changed the plan" });
    });
  });

  describe("case acceptance", () => {
    it("counts quotes given by number and value, accepted in part counting in part, withdrawn ones left out; by doctor for the owner only", async () => {
      const doctorC = await createUser({ tenantId: c, role: "DOCTOR", fullName: "Dr. C" });
      const treatment = await db.treatment.findFirstOrThrow({ where: { tenantId: c, key: "laser-hair-removal" } });
      const laserC = (await db.priceItem.create({ data: { tenantId: c, code: "L", name: "Laser session", category: "laser", unit: "SESSION", treatmentId: treatment.id, prices: { create: { tenantId: c, amount: 1_000, effectiveFrom: new Date(Date.now() - 30 * DAY) } } } })).id;
      const make = async (name: string, quantity: number) => {
        const pid = await patient(name, "en", c);
        const q = (await createRoute(request("/api/quotes", { method: "POST", cookie: ownerCCookie, body: { patientId: pid, doctorId: doctorC.id, phases: [{ title: "Laser", items: [{ priceItemId: laserC, quantity }, { priceItemId: laserC, quantity: 1 }] }] } })).then(json)).json.quote;
        await post(giveRoute, `/api/quotes/${q.id}/give`, q.id, undefined, ownerCCookie);
        return q as { id: string; items: { id: string }[] };
      };
      const all = await make("All", 4); // 5,000, accepted in full
      const part = await make("Part", 9); // 10,000, accepted 9,000
      const no = await make("No", 1); // 2,000, declined
      const old = await make("Old", 2); // 3,000, expired
      await make("Waiting", 3); // 4,000, open
      const gone = await make("Gone", 5); // withdrawn: left out
      const sign = (q: { id: string }, itemIds: string[]) => post(acceptRoute, `/api/quotes/${q.id}/accept`, q.id, { itemIds, name: "Patient", signature: SIGNATURE, agree: true }, ownerCCookie);
      await sign(all, all.items.map((i) => i.id));
      await sign(part, [part.items[0]!.id]);
      await post(declineRoute, `/api/quotes/${no.id}/decline`, no.id, { reason: "Price" }, ownerCCookie);
      await db.quote.update({ where: { id: old.id }, data: { validUntil: addDays(startOfDayInTz(new Date(), TZ), -2, TZ) } });
      await post(withdrawRoute, `/api/quotes/${gone.id}/withdraw`, gone.id, { reason: "Replaced on paper" }, ownerCCookie);

      const owner = await acceptanceRoute(request("/api/quotes/acceptance?days=30", { cookie: ownerCCookie })).then(json);
      expect(owner.res.status).toBe(200);
      expect(owner.json).toMatchObject({ days: 30, presented: 5, presentedValue: 24_000, accepted: 2, acceptedValue: 14_000, declined: 1, expired: 1, open: 1, expiringSoon: { count: 0, value: 0 } });
      expect(owner.json.byDoctor).toEqual([{ doctorId: doctorC.id, name: "Dr. C", presented: 5, presentedValue: 24_000, accepted: 2, acceptedValue: 14_000, declined: 1, expired: 1, open: 1 }]);
      expect(owner.json.byTreatment).toEqual([{ treatmentId: treatment.id, name: treatment.name, presented: 10, presentedValue: 24_000, accepted: 3, acceptedValue: 14_000 }]);
      const desk = await createUser({ tenantId: c, role: "RECEPTIONIST" });
      const byDesk = await acceptanceRoute(request("/api/quotes/acceptance", { cookie: await sessionCookieFor(desk.id) })).then(json);
      expect(byDesk.json.byDoctor).toBeNull();
      expect(byDesk.json.presented).toBe(5);
    });
  });

  describe("who may", () => {
    it("doctors, nurses, the desk and the owner make and give plans; assistants and other clinics do not see them", async () => {
      const p = await patient("Access Patient");
      const body = { patientId: p, phases: [{ title: "PRP", items: [{ priceItemId: item.prp }] }] };
      expect((await draft(body, nurseCookie)).res.status).toBe(201);
      const id = (await draft(body, doctorCookie)).json.quote.id;
      expect((await read(id, nurseCookie)).res.status).toBe(200);
      expect((await draft(body, assistantCookie)).res.status).toBe(403);
      expect((await read(id, assistantCookie)).res.status).toBe(403);
      expect((await listRoute(request("/api/quotes", { cookie: assistantCookie }))).status).toBe(403);
      expect((await acceptanceRoute(request("/api/quotes/acceptance", { cookie: assistantCookie }))).status).toBe(403);
      expect((await read(id, ownerBCookie)).res.status).toBe(404);
      expect((await give(id, ownerBCookie)).res.status).toBe(404);
      expect((await patch(id, { title: "Theirs" }, ownerBCookie)).res.status).toBe(404);
      const patientB = await db.patient.findFirst({ where: { tenantId: { not: a } }, select: { id: true } });
      if (patientB) expect((await draft({ ...body, patientId: patientB.id })).res.status).toBe(404);
      const theirs = await listRoute(request("/api/quotes", { cookie: ownerBCookie })).then(json);
      expect(theirs.json.quotes).toEqual([]);
    });
  });
});
