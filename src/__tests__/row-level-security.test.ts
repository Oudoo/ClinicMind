/**
 * Clinic isolation in the database itself (row-level security, src/lib/db.ts).
 *
 * The behaviour checks need the tests to connect as the application role
 * (TEST_DATABASE_URL → clinicmind_app, TEST_SYSTEM_DATABASE_URL → the owner),
 * as CI runs them; connected as the owner nothing is enforced and they are
 * skipped, except in CI, where that is a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindScope, db, rlsStatus, systemDb, tenantDatabaseUrl, withoutScope, withSystem, withTenant, type RlsStatus } from "@/lib/db";
import { createTenant, dbTestsEnabled, deleteTenants } from "@/test/db";

describe("tenantDatabaseUrl", () => {
  it("carries the clinic as a connection option and caps the pool", () => {
    const url = tenantDatabaseUrl("ckabc_123-x", "postgresql://u:p@h:5432/d?schema=public&connection_limit=20");
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("schema")).toBe("public");
    expect(params.get("options")).toBe("-c app.current_tenant=ckabc_123-x");
    expect(Number(params.get("connection_limit"))).toBeLessThan(20);
  });

  it("keeps options already on the URL", () => {
    const url = tenantDatabaseUrl("t1", "postgresql://u:p@h/d?options=-c%20statement_timeout%3D5000");
    expect(new URLSearchParams(url.split("?")[1]).get("options")).toBe("-c statement_timeout=5000 -c app.current_tenant=t1");
  });

  it("refuses an id that is not a plain identifier", () => {
    for (const bad of ["", "a b", "a,b", "x' OR '1'='1", "-c role=postgres", "a".repeat(65)]) {
      expect(() => tenantDatabaseUrl(bad, "postgresql://u:p@h/d")).toThrow();
    }
  });
});

describe.runIf(dbTestsEnabled)("row-level security", () => {
  const created: string[] = [];
  let status: RlsStatus;
  let a: string;
  let b: string;
  let pa: string;
  let pb: string;
  const both = () => ({ id: { in: [pa, pb] } });

  /** Behaviour checks need the policies to bind the app's connection. */
  function needsEnforcement(ctx: { skip: () => void }) {
    if (status.enforced) return;
    if (process.env.CI) throw new Error(`CI must run the tests as the application role: ${status.reason}`);
    ctx.skip();
  }

  beforeAll(async () => {
    status = await rlsStatus();
    const stamp = Date.now().toString(36);
    a = (await createTenant({ slug: `rls-a-${stamp}` })).id;
    b = (await createTenant({ slug: `rls-b-${stamp}` })).id;
    created.push(a, b);
    pa = (await systemDb.patient.create({ data: { tenantId: a, fullName: "Patient Of A", gender: "FEMALE" } })).id;
    pb = (await systemDb.patient.create({ data: { tenantId: b, fullName: "Patient Of B", gender: "MALE" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("gives each clinic's connections the clinic, and none to the others", async () => {
    const setting = (rows: { t: string | null }[]) => rows[0]?.t || null;
    expect(setting(await withTenant(a, () => db.$queryRaw<{ t: string | null }[]>`SELECT current_setting('app.current_tenant', true) AS t`))).toBe(a);
    expect(setting(await withoutScope(() => db.$queryRaw<{ t: string | null }[]>`SELECT current_setting('app.current_tenant', true) AS t`))).toBeNull();
  });

  it("the system connection reaches every clinic", async () => {
    expect(status.systemCanReachAllClinics).toBe(true);
    expect(await withSystem(() => db.patient.count({ where: both() }))).toBe(2);
    expect(await systemDb.patient.count({ where: both() })).toBe(2);
  });

  it("a query run without the clinic set returns nothing", async (ctx) => {
    needsEnforcement(ctx);
    expect(await withoutScope(() => db.patient.count({ where: both() }))).toBe(0);
    expect(await withoutScope(() => db.patient.findUnique({ where: { id: pa } }))).toBeNull();
    // The same for writes: nothing to update, nothing can be inserted.
    expect((await withoutScope(() => db.patient.updateMany({ where: both(), data: { notes: "x" } }))).count).toBe(0);
    await expect(withoutScope(() => db.patient.create({ data: { tenantId: a, fullName: "Nobody", gender: "MALE" } }))).rejects.toThrow();
  });

  it("a clinic sees only its own rows, even when a query forgets its clinic filter", async (ctx) => {
    needsEnforcement(ctx);
    const rows = await withTenant(a, () => db.patient.findMany({ where: both(), select: { id: true } }));
    expect(rows.map((r) => r.id)).toEqual([pa]);
    expect(await withTenant(a, () => db.patient.findUnique({ where: { id: pb } }))).toBeNull();
  });

  it("a clinic cannot write into another clinic", async (ctx) => {
    needsEnforcement(ctx);
    await expect(withTenant(a, () => db.patient.create({ data: { tenantId: b, fullName: "Planted", gender: "MALE" } }))).rejects.toThrow();
    expect((await withTenant(a, () => db.patient.updateMany({ where: { id: pb }, data: { fullName: "Changed" } }))).count).toBe(0);
    expect((await withTenant(a, () => db.patient.deleteMany({ where: { id: pb } }))).count).toBe(0);
    // Moving its own row to the other clinic is refused too.
    await expect(withTenant(a, () => db.patient.update({ where: { id: pa }, data: { tenantId: b } }))).rejects.toThrow();
    expect(await systemDb.patient.findUniqueOrThrow({ where: { id: pb } })).toMatchObject({ tenantId: b, fullName: "Patient Of B" });
    expect(await systemDb.patient.count({ where: { fullName: "Planted" } })).toBe(0);
  });

  it("interactive transactions stay in the clinic", async (ctx) => {
    needsEnforcement(ctx);
    const seen = await withTenant(a, () => db.$transaction(async (tx) => tx.patient.findMany({ where: both(), select: { id: true } })));
    expect(seen.map((r) => r.id)).toEqual([pa]);
  });

  it("a callback bound to a clinic keeps it when something else calls it later", async (ctx) => {
    needsEnforcement(ctx);
    const read = () => db.patient.findMany({ where: both(), select: { id: true } });
    const bound = withTenant(a, () => bindScope(read));
    expect((await withoutScope(bound)).map((r) => r.id)).toEqual([pa]);
    // Unbound, the same callback called from outside sees nothing.
    const unbound = withTenant(a, () => read);
    expect(await withoutScope(unbound)).toEqual([]);
  });

  it("sessions and one-time tokens are out of the application role's reach", async (ctx) => {
    needsEnforcement(ctx);
    await expect(withTenant(a, () => db.session.count())).rejects.toThrow();
    await expect(withTenant(a, () => db.authToken.count())).rejects.toThrow();
    await expect(systemDb.session.count()).resolves.toBeGreaterThanOrEqual(0);
  });
});
