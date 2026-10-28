/**
 * The price list (Phase 2, finance part 1): codes, units and course packages;
 * prices from a date that never change what was already charged; a branch's
 * own price before the clinic-wide one; the owner edits, everyone reads; and
 * a procedure recorded from an item takes the list price of its day.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, dateKeyInTz } from "@/lib/time";
import { GET as listRoute, POST as createRoute } from "@/app/api/prices/route";
import { GET as getRoute, PATCH as patchRoute } from "@/app/api/prices/[id]/route";
import { POST as scheduleRoute } from "@/app/api/prices/[id]/prices/route";
import { DELETE as withdrawRoute } from "@/app/api/prices/[id]/prices/[priceId]/route";
import { POST as procedureRoute } from "@/app/api/procedures/route";
import { nextPriceChange, priceInForce } from "@/modules/finance/prices";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const TZ = "Africa/Cairo";
const day = (n: number) => dateKeyInTz(addDays(new Date(), n, TZ), TZ);
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("price in force", () => {
  const at = (iso: string) => new Date(iso);
  const row = (id: string, amount: number, from: string, clinicId: string | null = null, created = from) => ({ id, clinicId, amount, effectiveFrom: at(from), createdAt: at(created) });
  const rows = [
    row("a", 1000, "2026-01-01T00:00:00Z"),
    row("b", 1200, "2026-06-01T00:00:00Z"),
    row("c", 900, "2026-03-01T00:00:00Z", "branch-2"),
    row("d", 1500, "2026-12-01T00:00:00Z"),
    row("e", 1250, "2026-06-01T00:00:00Z", null, "2026-06-01T10:00:00Z"),
  ];

  it("takes the newest row on or before the day, a branch's own first, the later entry of the same day", () => {
    expect(priceInForce(rows, at("2026-02-01T00:00:00Z"))?.amount).toBe(1000);
    expect(priceInForce(rows, at("2026-07-01T00:00:00Z"))?.amount).toBe(1250);
    expect(priceInForce(rows, at("2026-07-01T00:00:00Z"), "branch-2")?.amount).toBe(900);
    expect(priceInForce(rows, at("2026-07-01T00:00:00Z"), "branch-3")?.amount).toBe(1250);
    expect(priceInForce(rows, at("2025-12-31T00:00:00Z"))).toBeNull();
  });

  it("names the next change, but not a clinic-wide one a branch with its own price does not follow", () => {
    expect(nextPriceChange(rows, at("2026-07-01T00:00:00Z"))?.amount).toBe(1500);
    expect(nextPriceChange(rows, at("2026-07-01T00:00:00Z"), "branch-2")).toBeNull();
  });
});

describe.skipIf(!dbTestsEnabled)("price list routes", () => {
  const created: string[] = [];
  let tenant: { id: string };
  let otherTenant: { id: string };
  let ownerCookie: string;
  let receptionCookie: string;
  let otherOwnerCookie: string;
  let laser: { id: string };
  let hair: { id: string };
  let patient: { id: string };

  async function call(handler: (req: Request, ctx: never) => Promise<Response>, path: string, init: { method?: string; body?: unknown; cookie?: string } = {}, ctx?: unknown) {
    const res = await handler(request(path, { method: init.method, body: init.body, cookie: init.cookie ?? ownerCookie }), ctx as never);
    return { status: res.status, json: await res.json() };
  }
  const newItem = (body: Record<string, unknown>, cookie?: string) => call(createRoute, "/api/prices", { method: "POST", body, cookie });

  beforeAll(async () => {
    tenant = await createTenant({ slug: `prices-${Date.now().toString(36)}` });
    otherTenant = await createTenant({ slug: `prices-b-${Date.now().toString(36)}` });
    created.push(tenant.id, otherTenant.id);
    const owner = await createUser({ tenantId: tenant.id, role: "CLINIC_OWNER" });
    const reception = await createUser({ tenantId: tenant.id, role: "RECEPTIONIST" });
    const otherOwner = await createUser({ tenantId: otherTenant.id, role: "CLINIC_OWNER" });
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    otherOwnerCookie = await sessionCookieFor(otherOwner.id);
    laser = await db.treatment.create({ data: { tenantId: tenant.id, key: "laser-hair-removal", name: "Laser hair removal", category: "laser" } });
    hair = await db.treatment.create({ data: { tenantId: tenant.id, key: "hair-transplant", name: "Hair transplant", category: "hair" } });
    patient = await db.patient.create({ data: { tenantId: tenant.id, fullName: "Price Patient" } });
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("the owner adds items with a code, a unit and a first price; codes are unique and upper-cased", async () => {
    const face = await newItem({ code: "lsr-face", name: "Laser — full face", category: "laser", unit: "SESSION", treatmentId: laser.id, price: 1200 });
    expect(face.status).toBe(201);
    expect(face.json.item).toMatchObject({ code: "LSR-FACE", unit: "SESSION", price: 1200, active: true, treatment: { id: laser.id } });
    expect(face.json.item.history).toHaveLength(1);

    const taken = await newItem({ code: "LSR-FACE", name: "Again", category: "laser", treatmentId: laser.id, price: 1 });
    expect(taken.status).toBe(409);
    expect(taken.json.error).toBe("code_taken");

    const grafts = await newItem({ code: "FUE-GRAFT", name: "FUE transplant", category: "hair", unit: "UNIT", unitLabel: "graft", treatmentId: hair.id, price: 22 });
    expect(grafts.json.item).toMatchObject({ unit: "UNIT", unitLabel: "graft", price: 22 });

    const bad = await newItem({ code: "x", name: "?", category: "laser", unit: "PACKAGE", treatmentId: laser.id, price: -5 });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.json.issues.fieldErrors)).toEqual(expect.arrayContaining(["code", "name", "price", "sessions", "sessionItemId"]));

    const audit = await db.auditLog.findFirst({ where: { tenantId: tenant.id, action: "price.item.create", entityId: face.json.item.id } });
    expect(audit?.after).toMatchObject({ code: "LSR-FACE", price: 1200 });
  });

  it("a course package names its sessions and shows the saving against single sessions", async () => {
    const single = await newItem({ code: "LSR-UNDERARM", name: "Laser — underarms", category: "laser", treatmentId: laser.id, price: 900 });
    const course = await newItem({ code: "LSR-UNDERARM-6", name: "Laser — underarms, 6 sessions", category: "laser", unit: "PACKAGE", sessions: 6, sessionItemId: single.json.item.id, treatmentId: laser.id, price: 4500 });
    expect(course.status).toBe(201);
    expect(course.json.item).toMatchObject({ sessions: 6, sessionItem: { code: "LSR-UNDERARM" }, saving: 900 * 6 - 4500 });
    const nested = await newItem({ code: "LSR-NESTED", name: "Course of courses", category: "laser", unit: "PACKAGE", sessions: 2, sessionItemId: course.json.item.id, treatmentId: laser.id, price: 1 });
    expect(nested.status).toBe(422);
  });

  it("a price changes from a day on: never in the past, the old price still there, a scheduled change replaceable and withdrawable", async () => {
    const { json } = await newItem({ code: "PRP-1", name: "PRP session", category: "hair", treatmentId: hair.id, price: 3000 });
    const id = json.item.id;
    const past = await call(scheduleRoute, `/api/prices/${id}/prices`, { method: "POST", body: { amount: 3500, effectiveFrom: day(-1) } }, idParams(id));
    expect(past.status).toBe(422);
    expect(past.json.error).toBe("price_in_the_past");

    const next = await call(scheduleRoute, `/api/prices/${id}/prices`, { method: "POST", body: { amount: 3500, effectiveFrom: day(10) } }, idParams(id));
    expect(next.status).toBe(201);
    expect(next.json.item).toMatchObject({ price: 3000, next: { amount: 3500, effectiveFrom: day(10) } });
    // Rescheduling the same day replaces the plan instead of piling up rows.
    const replaced = await call(scheduleRoute, `/api/prices/${id}/prices`, { method: "POST", body: { amount: 3400, effectiveFrom: day(10) } }, idParams(id));
    expect(replaced.json.item.next).toMatchObject({ amount: 3400 });
    expect(replaced.json.item.history.filter((h: { scheduled: boolean }) => h.scheduled)).toHaveLength(1);

    // As of that day the new price applies; today it does not.
    const later = await call(listRoute, `/api/prices?at=${day(10)}&q=PRP-1`);
    expect(later.json.items[0]).toMatchObject({ price: 3400, priceSince: day(10) });
    const today = await call(listRoute, "/api/prices?q=PRP-1");
    expect(today.json.items[0].price).toBe(3000);

    const scheduled = replaced.json.item.history.find((h: { scheduled: boolean }) => h.scheduled);
    const withdrawn = await call(withdrawRoute, `/api/prices/${id}/prices/${scheduled.id}`, { method: "DELETE" }, { params: Promise.resolve({ id, priceId: scheduled.id }) });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.json.item.next).toBeNull();
    const inForce = withdrawn.json.item.history[0];
    const refused = await call(withdrawRoute, `/api/prices/${id}/prices/${inForce.id}`, { method: "DELETE" }, { params: Promise.resolve({ id, priceId: inForce.id }) });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("price_in_force");
  });

  it("a branch's own price comes before the clinic-wide one", async () => {
    const branch = await db.clinic.create({ data: { tenantId: tenant.id, name: "Branch 2" } });
    const { json } = await newItem({ code: "LSR-LEGS", name: "Laser — full legs", category: "laser", treatmentId: laser.id, price: 2500 });
    const id = json.item.id;
    await call(scheduleRoute, `/api/prices/${id}/prices`, { method: "POST", body: { amount: 2200, effectiveFrom: day(0), clinicId: branch.id } }, idParams(id));
    const atBranch = await call(listRoute, `/api/prices?q=LSR-LEGS&clinicId=${branch.id}`);
    expect(atBranch.json.items[0]).toMatchObject({ price: 2200, branchPrice: true });
    const wide = await call(listRoute, "/api/prices?q=LSR-LEGS");
    expect(wide.json.items[0]).toMatchObject({ price: 2500, branchPrice: false, branchPrices: [{ clinicId: branch.id, amount: 2200 }] });
    const foreignBranch = await db.clinic.findFirstOrThrow({ where: { tenantId: otherTenant.id } });
    const refused = await call(scheduleRoute, `/api/prices/${id}/prices`, { method: "POST", body: { amount: 1, effectiveFrom: day(0), clinicId: foreignBranch.id } }, idParams(id));
    expect(refused.status).toBe(404);
  });

  it("everyone reads, only the owner edits; another clinic sees none of it", async () => {
    const list = await call(listRoute, "/api/prices", { cookie: receptionCookie });
    expect(list.status).toBe(200);
    expect(list.json.items.length).toBeGreaterThan(3);
    expect((await newItem({ code: "NOPE", name: "Nope", category: "skin", treatmentId: laser.id, price: 1 }, receptionCookie)).status).toBe(403);
    const id = list.json.items[0].id;
    expect((await call(patchRoute, `/api/prices/${id}`, { method: "PATCH", body: { name: "Changed" }, cookie: receptionCookie }, idParams(id))).status).toBe(403);
    expect((await call(scheduleRoute, `/api/prices/${id}/prices`, { method: "POST", body: { amount: 1, effectiveFrom: day(1) }, cookie: receptionCookie }, idParams(id))).status).toBe(403);

    expect((await call(listRoute, "/api/prices", { cookie: otherOwnerCookie })).json.items).toEqual([]);
    expect((await call(getRoute, `/api/prices/${id}`, { cookie: otherOwnerCookie }, idParams(id))).status).toBe(404);
    expect((await call(patchRoute, `/api/prices/${id}`, { method: "PATCH", body: { name: "Hijack" }, cookie: otherOwnerCookie }, idParams(id))).status).toBe(404);
  });

  it("the owner renames, retires and brings back an item; the code stays", async () => {
    const { json } = await newItem({ code: "PEEL-1", name: "Chemical peel", category: "skin", treatmentId: laser.id, price: 1800 });
    const id = json.item.id;
    const renamed = await call(patchRoute, `/api/prices/${id}`, { method: "PATCH", body: { name: "Chemical peel — medium depth", active: false, code: "CHANGED" } }, idParams(id));
    expect(renamed.status).toBe(200);
    expect(renamed.json.item).toMatchObject({ code: "PEEL-1", name: "Chemical peel — medium depth", active: false });
    expect((await call(listRoute, "/api/prices?q=PEEL-1")).json.items).toEqual([]);
    expect((await call(listRoute, "/api/prices?q=PEEL-1&includeInactive=1")).json.items).toHaveLength(1);
    expect((await call(patchRoute, `/api/prices/${id}`, { method: "PATCH", body: { unit: "PACKAGE" } }, idParams(id))).status).toBe(422);
  });

  it("a procedure from an item takes the item's treatment and the list price of its day, times the quantity", async () => {
    const { json } = await newItem({ code: "BTX-AREA", name: "Botox — per area", category: "injectables", unit: "AREA", treatmentId: hair.id, price: 2500 });
    const id = json.item.id;
    await call(scheduleRoute, `/api/prices/${id}/prices`, { method: "POST", body: { amount: 2800, effectiveFrom: day(5) } }, idParams(id));
    const record = (performedAt: Date, extra: Record<string, unknown> = {}) =>
      call(procedureRoute, "/api/procedures", { method: "POST", body: { patientId: patient.id, priceItemId: id, quantity: 3, performedAt: performedAt.toISOString(), ...extra } });

    const now = await record(new Date());
    expect(now.status).toBe(201);
    expect(now.json.procedure).toMatchObject({ treatmentId: hair.id, priceItemId: id, quantity: 3, price: 7500 });
    const later = await record(addDays(new Date(), 6, TZ));
    expect(later.json.procedure.price).toBe(8400);
    // A price given on purpose stands (discounts and their limits come with invoicing).
    expect((await record(new Date(), { price: 7000 })).json.procedure.price).toBe(7000);
    // The item decides the treatment.
    expect((await record(new Date(), { treatmentId: laser.id })).status).toBe(422);
    // The old procedure keeps its price when the list changes.
    expect((await db.procedure.findUniqueOrThrow({ where: { id: now.json.procedure.id } })).price).toBe(7500);

    await call(patchRoute, `/api/prices/${id}`, { method: "PATCH", body: { active: false } }, idParams(id));
    const retired = await record(new Date());
    expect(retired.status).toBe(422);
    expect(retired.json.error).toBe("price_item_inactive");
  });
});
