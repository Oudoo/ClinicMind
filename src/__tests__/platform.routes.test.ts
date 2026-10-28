/**
 * Platform console against the test database: provisioning, listing, detail,
 * updates (branding, domain, suspension), owner invitations and the clinic
 * owner's own branding endpoint. Everything is SUPER_ADMIN-only except the
 * last, which is `tenant:manage` on the acting tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { GET as listTenants, POST as provisionTenant } from "@/app/api/tenants/route";
import { GET as getTenant, PATCH as patchTenant } from "@/app/api/tenants/[id]/route";
import { POST as inviteOwner } from "@/app/api/tenants/[id]/owner/route";
import { PATCH as patchOwnBranding } from "@/app/api/tenant/branding/route";
import { GET as me } from "@/app/api/me/route";
import { createTenant, createUser, deleteTenants, request, sessionCookieFor } from "@/test/db";

const hasDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!hasDb)("platform console", () => {
  const created: string[] = [];
  const stamp = Date.now().toString(36);
  let superCookie: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let ownerTenantId: string;

  beforeAll(async () => {
    // Platform administrators live in their own tenant; the slug "platform" is hidden from listings.
    const platform = await createTenant({ slug: "platform", name: "Platform" }).catch(async () => {
      const existing = await db.tenant.findUnique({ where: { slug: "platform" } });
      if (!existing) throw new Error("could not create the platform tenant");
      return existing;
    });
    if (!created.includes(platform.id)) created.push(platform.id);
    const superAdmin = await createUser({ tenantId: platform.id, role: "SUPER_ADMIN", fullName: "Root" });
    superCookie = await sessionCookieFor(superAdmin.id);

    const clinic = await createTenant({ slug: `pc-${stamp}`, name: "Existing Clinic" });
    created.push(clinic.id);
    ownerTenantId = clinic.id;
    const owner = await createUser({ tenantId: clinic.id, role: "CLINIC_OWNER", fullName: "Owner" });
    const reception = await createUser({ tenantId: clinic.id, role: "RECEPTIONIST" });
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
  });

  afterAll(async () => {
    const extra = await db.tenant.findMany({ where: { slug: { startsWith: `nour-${stamp}` } }, select: { id: true } });
    await deleteTenants([...created, ...extra.map((t) => t.id)]);
  });

  describe("access", () => {
    it("every platform endpoint needs platform:manage; a clinic owner gets 403 and a visitor 401", async () => {
      const calls = [
        () => listTenants(request("/api/tenants", { cookie: ownerCookie })),
        () => provisionTenant(request("/api/tenants", { cookie: ownerCookie, body: { slug: "x", name: "X", ownerEmail: "x@x.test" } })),
        () => getTenant(request(`/api/tenants/${ownerTenantId}`, { cookie: ownerCookie }), idParams(ownerTenantId)),
        () => patchTenant(request(`/api/tenants/${ownerTenantId}`, { method: "PATCH", cookie: ownerCookie, body: { name: "Mine" } }), idParams(ownerTenantId)),
        () => inviteOwner(request(`/api/tenants/${ownerTenantId}/owner`, { cookie: ownerCookie, body: { email: "o@x.test" } }), idParams(ownerTenantId)),
      ];
      for (const call of calls) expect((await call()).status).toBe(403);
      expect((await listTenants(request("/api/tenants"))).status).toBe(401);
    });
  });

  describe("provisioning", () => {
    const slug = `nour-${stamp}`;
    let tenantId: string;
    let inviteUrl: string;

    it("creates the tenant, its clinic, embed config and invited owner, and returns the secret once", async () => {
      const res = await provisionTenant(
        request("/api/tenants", {
          cookie: superCookie,
          body: {
            slug,
            name: "Nour Clinics",
            ownerEmail: "Dr.Nour@NourClinics.test",
            ownerFullName: "Dr. Nour Hassan",
            timezone: "Asia/Riyadh",
            branding: { productName: "Nour Care", accent: "#0f766e" },
            allowedOrigins: ["https://www.nourclinics.test"],
          },
        }),
      );
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      tenantId = body.tenant.id;
      inviteUrl = body.inviteUrl;
      expect(body.tenant).toMatchObject({ slug, name: "Nour Clinics" });
      expect(body.owner.email).toBe("dr.nour@nourclinics.test");
      expect(body.embedSecret).toMatch(/^cmembed_/);
      expect(inviteUrl).toMatch(/\/invite\//);

      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        include: { clinics: true, embed: true, users: true },
      });
      expect(tenant).toMatchObject({ status: "ACTIVE", branding: { productName: "Nour Care", accent: "#0F766E" } });
      expect(tenant?.clinics[0]).toMatchObject({ name: "Nour Clinics", timezone: "Asia/Riyadh" });
      expect(tenant?.embed).toMatchObject({ enabled: true, allowedOrigins: ["https://www.nourclinics.test"] });
      expect(tenant?.embed?.secretHash).not.toContain(body.embedSecret);
      expect(tenant?.users).toHaveLength(1);
      expect(tenant?.users[0]).toMatchObject({ role: "CLINIC_OWNER", status: "INVITED", fullName: "Dr. Nour Hassan" });
      const auditRow = await db.auditLog.findFirst({ where: { tenantId, action: "tenant.provision" } });
      expect(auditRow).toMatchObject({ entity: "Tenant", entityId: tenantId });
    });

    it("refuses a taken slug, a reserved slug, an unknown time zone and a bad accent", async () => {
      const base = { name: "Dup", ownerEmail: "dup@x.test" };
      expect((await provisionTenant(request("/api/tenants", { cookie: superCookie, body: { ...base, slug } }))).status).toBe(409);
      const reserved = await provisionTenant(request("/api/tenants", { cookie: superCookie, body: { ...base, slug: "platform" } }));
      expect(reserved.status).toBe(422);
      await expect(reserved.json()).resolves.toMatchObject({ error: "slug_reserved" });
      expect((await provisionTenant(request("/api/tenants", { cookie: superCookie, body: { ...base, slug: `tz-${stamp}`, timezone: "Mars/Olympus" } }))).status).toBe(422);
      expect((await provisionTenant(request("/api/tenants", { cookie: superCookie, body: { ...base, slug: `ac-${stamp}`, branding: { accent: "teal" } } }))).status).toBe(422);
      expect(await db.tenant.count({ where: { slug: { in: [`tz-${stamp}`, `ac-${stamp}`] } } })).toBe(0);
    });

    it("lists client tenants with owner and counts, hiding the platform tenant", async () => {
      const res = await listTenants(request("/api/tenants", { cookie: superCookie }));
      expect(res.status).toBe(200);
      const { tenants } = (await res.json()) as { tenants: { slug: string; owner: { email: string; status: string } | null; counts: { users: number } }[] };
      const nour = tenants.find((t) => t.slug === slug);
      expect(nour).toMatchObject({ owner: { email: "dr.nour@nourclinics.test", status: "INVITED" }, counts: { users: 1, patients: 0 } });
      expect(tenants.some((t) => t.slug === "platform")).toBe(false);
    });

    it("returns the detail with clinics, users and usage, and 404 for an unknown or platform tenant", async () => {
      const res = await getTenant(request(`/api/tenants/${tenantId}`, { cookie: superCookie }), idParams(tenantId));
      expect(res.status).toBe(200);
      const { tenant } = await res.json();
      expect(tenant.clinics).toHaveLength(1);
      expect(tenant.users).toHaveLength(1);
      expect(tenant.counts).toMatchObject({ users: 1, patients: 0, appointments: 0, consultations: 0, visits: 0 });
      expect((await getTenant(request("/api/tenants/nope", { cookie: superCookie }), idParams("nope"))).status).toBe(404);
      const platform = await db.tenant.findUnique({ where: { slug: "platform" }, select: { id: true } });
      expect((await getTenant(request(`/api/tenants/${platform!.id}`, { cookie: superCookie }), idParams(platform!.id))).status).toBe(404);
    });

    it("updates name and branding with merge semantics (empty clears), and audits it", async () => {
      const res = await patchTenant(
        request(`/api/tenants/${tenantId}`, { method: "PATCH", cookie: superCookie, body: { name: "Nour Clinics Group", branding: { accent: "", logoUrl: "https://cdn.nourclinics.test/logo.svg" } } }),
        idParams(tenantId),
      );
      expect(res.status).toBe(200);
      const row = await db.tenant.findUnique({ where: { id: tenantId } });
      expect(row?.name).toBe("Nour Clinics Group");
      expect(row?.branding).toEqual({ productName: "Nour Care", logoUrl: "https://cdn.nourclinics.test/logo.svg" });
      expect(await db.auditLog.count({ where: { tenantId, action: "tenant.update" } })).toBe(1);
    });

    it("assigns a custom domain once, refuses it for another tenant, and resets verification on change", async () => {
      const first = await patchTenant(
        request(`/api/tenants/${tenantId}`, { method: "PATCH", cookie: superCookie, body: { customDomain: "App.NourClinics.test", customDomainVerified: true } }),
        idParams(tenantId),
      );
      expect(first.status).toBe(200);
      expect(await db.tenant.findUnique({ where: { id: tenantId }, select: { customDomain: true, customDomainVerified: true } })).toEqual({
        customDomain: "app.nourclinics.test",
        customDomainVerified: true,
      });
      const clash = await patchTenant(
        request(`/api/tenants/${ownerTenantId}`, { method: "PATCH", cookie: superCookie, body: { customDomain: "app.nourclinics.test" } }),
        idParams(ownerTenantId),
      );
      expect(clash.status).toBe(409);
      await expect(clash.json()).resolves.toMatchObject({ error: "domain_taken" });
      const changed = await patchTenant(
        request(`/api/tenants/${tenantId}`, { method: "PATCH", cookie: superCookie, body: { customDomain: "portal.nourclinics.test" } }),
        idParams(tenantId),
      );
      expect(changed.status).toBe(200);
      expect((await db.tenant.findUnique({ where: { id: tenantId }, select: { customDomainVerified: true } }))?.customDomainVerified).toBe(false);
    });

    it("suspending a tenant ends its staff's access; activating restores it", async () => {
      const staff = await createUser({ tenantId, role: "DOCTOR" });
      const cookie = await sessionCookieFor(staff.id);
      expect((await me(request("/api/me", { cookie }))).status).toBe(200);

      const suspend = await patchTenant(request(`/api/tenants/${tenantId}`, { method: "PATCH", cookie: superCookie, body: { status: "SUSPENDED" } }), idParams(tenantId));
      expect(suspend.status).toBe(200);
      expect((await me(request("/api/me", { cookie }))).status).toBe(401);
      expect(await db.auditLog.count({ where: { tenantId, action: "tenant.status" } })).toBe(1);

      const activate = await patchTenant(request(`/api/tenants/${tenantId}`, { method: "PATCH", cookie: superCookie, body: { status: "ACTIVE" } }), idParams(tenantId));
      expect(activate.status).toBe(200);
      expect((await me(request("/api/me", { cookie }))).status).toBe(200);
      expect((await patchTenant(request(`/api/tenants/${tenantId}`, { method: "PATCH", cookie: superCookie, body: { status: "ARCHIVED" } }), idParams(tenantId))).status).toBe(422);
    });

    it("invites a second owner, re-invites a pending one, and refuses an active account", async () => {
      const fresh = await inviteOwner(request(`/api/tenants/${tenantId}/owner`, { cookie: superCookie, body: { email: "manager@nourclinics.test", fullName: "Manager" } }), idParams(tenantId));
      expect(fresh.status).toBe(201);
      const freshBody = await fresh.json();
      expect(freshBody.owner).toMatchObject({ email: "manager@nourclinics.test", status: "INVITED" });
      expect(freshBody.inviteUrl).toMatch(/\/invite\//);
      expect(await db.user.count({ where: { tenantId, role: "CLINIC_OWNER" } })).toBe(2);

      const again = await inviteOwner(request(`/api/tenants/${tenantId}/owner`, { cookie: superCookie, body: { email: "manager@nourclinics.test" } }), idParams(tenantId));
      expect(again.status).toBe(201);
      expect(await db.user.count({ where: { tenantId, role: "CLINIC_OWNER" } })).toBe(2);
      expect(await db.auditLog.count({ where: { tenantId, action: "tenant.owner.reinvite" } })).toBe(1);

      const active = await createUser({ tenantId, role: "DOCTOR", email: `active-${stamp}@nourclinics.test` });
      const refused = await inviteOwner(request(`/api/tenants/${tenantId}/owner`, { cookie: superCookie, body: { email: active.email } }), idParams(tenantId));
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({ error: "email_taken" });
    });
  });

  describe("a clinic owner's own branding", () => {
    it("is editable by the owner, refused for a receptionist, validated, and never touches another tenant", async () => {
      const ok = await patchOwnBranding(request("/api/tenant/branding", { method: "PATCH", cookie: ownerCookie, body: { productName: "Existing Care", accent: "#1d4ed8" } }));
      expect(ok.status).toBe(200);
      await expect(ok.json()).resolves.toEqual({ branding: { productName: "Existing Care", accent: "#1D4ED8" } });
      expect((await db.tenant.findUnique({ where: { id: ownerTenantId }, select: { branding: true } }))?.branding).toEqual({ productName: "Existing Care", accent: "#1D4ED8" });

      expect((await patchOwnBranding(request("/api/tenant/branding", { method: "PATCH", cookie: receptionCookie, body: { productName: "Nope" } }))).status).toBe(403);
      expect((await patchOwnBranding(request("/api/tenant/branding", { method: "PATCH", cookie: ownerCookie, body: { accent: "blue" } }))).status).toBe(422);
      expect((await patchOwnBranding(request("/api/tenant/branding", { method: "PATCH", cookie: ownerCookie, body: { tenantId: "other" } }))).status).toBe(422);
      expect((await patchOwnBranding(request("/api/tenant/branding", { method: "PATCH", body: { productName: "x" } }))).status).toBe(401);
    });
  });
});
