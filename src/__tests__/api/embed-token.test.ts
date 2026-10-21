import { describe, it, expect, beforeEach, vi } from "vitest";

const requestState = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  cookies: new Map<string, string>(),
}));

vi.mock("@/lib/db", async () => {
  const { fake } = await import("@/__tests__/helpers/fake-db");
  return { db: fake.db, notDeleted: { deletedAt: null } };
});
vi.mock("next/headers", () => ({
  headers: () => ({ get: (name: string) => requestState.headers.get(name.toLowerCase()) ?? null }),
  cookies: () => ({
    get: (name: string) => {
      const value = requestState.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import { fake } from "@/__tests__/helpers/fake-db";
import { jsonRequest, seedTwoTenants, SECRET_A, SECRET_B, TENANT_A, TENANT_B } from "@/__tests__/helpers/fixtures";
import { EMBED_SECRET_HEADER, signEmbedToken, verifyEmbedToken } from "@/lib/embed";
import { getActingContext } from "@/lib/auth/session";
import { POST as mintToken } from "@/app/api/embed/token/route";

const ORIGIN_A = "https://care.acme.com";

function mint(body: Record<string, unknown>, secret: string | null = SECRET_A) {
  const headers: Record<string, string> = secret ? { [EMBED_SECRET_HEADER]: secret } : {};
  return mintToken(jsonRequest("/api/embed/token", body, headers));
}

const base = { tenantSlug: TENANT_A.slug, userId: "doctor-a", origin: ORIGIN_A };

beforeEach(() => {
  seedTwoTenants(fake);
  requestState.headers.clear();
  requestState.cookies.clear();
});

describe("SEC-2 · POST /api/embed/token", () => {
  it("requires the embed secret header", async () => {
    const res = await mint(base, null);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "missing_embed_secret" });
  });

  it("rejects a wrong secret, a secret of another tenant and the old plaintext-key header", async () => {
    expect((await mint(base, "cmembed_wrong")).status).toBe(403);
    expect((await mint(base, SECRET_B)).status).toBe(403);
    const legacy = mintToken(jsonRequest("/api/embed/token", base, { "x-clinicmind-embed-key": SECRET_A }));
    expect((await legacy).status).toBe(401);
    expect(fake.rows("auditLog")).toHaveLength(0);
  });

  it("rejects when embedding is disabled or no secret has been generated", async () => {
    const config = fake.rows("tenantEmbedConfig").find((c) => c.tenantId === TENANT_A.id)!;
    config.enabled = false;
    expect((await mint(base)).status).toBe(403);
    config.enabled = true;
    config.secretHash = null;
    const res = await mint(base);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "invalid_tenant_or_secret" });
  });

  it("requires an allow-listed origin", async () => {
    const missing = await mint({ tenantSlug: TENANT_A.slug, userId: "doctor-a" });
    expect(missing.status).toBe(422);

    const foreign = await mint({ ...base, origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual({ error: "origin_not_allowed" });

    const config = fake.rows("tenantEmbedConfig").find((c) => c.tenantId === TENANT_A.id)!;
    config.allowedOrigins = [];
    expect((await mint(base)).status).toBe(403);
  });

  it("can never mint SUPER_ADMIN, whatever the secret", async () => {
    const res = await mint({ ...base, userId: "super", role: "SUPER_ADMIN" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("validation_error");
    expect(body.issues.fieldErrors.role).toBeDefined();
  });

  it("only mints for an active user of that tenant", async () => {
    for (const userId of ["doctor-b", "invited-a", "disabled-a", "deleted-a", "ghost"]) {
      const res = await mint({ ...base, userId });
      expect(res.status, userId).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "user_not_in_tenant" });
    }
  });

  it("never widens a user's role", async () => {
    const res = await mint({ ...base, userId: "reception-a", role: "DOCTOR" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "role_not_permitted" });

    const owner = await mint({ ...base, userId: "owner-a", role: "DOCTOR" }); // owners cannot sign
    expect(owner.status).toBe(403);
  });

  it("mints a token for the user's own role by default, or a narrower one on request", async () => {
    const res = await mint(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ expiresIn: 600, role: "DOCTOR" });
    await expect(verifyEmbedToken(body.token)).resolves.toEqual({
      tenantId: TENANT_A.id,
      tenantSlug: TENANT_A.slug,
      userId: "doctor-a",
      role: "DOCTOR",
      origin: ORIGIN_A,
    });

    const narrower = await mint({ ...base, role: "ASSISTANT", ttlSeconds: 120 });
    expect(narrower.status).toBe(200);
    const narrowerBody = await narrower.json();
    expect(narrowerBody).toMatchObject({ expiresIn: 120, role: "ASSISTANT" });
    await expect(verifyEmbedToken(narrowerBody.token)).resolves.toMatchObject({ role: "ASSISTANT" });

    expect(fake.rows("auditLog").map((a) => a.action)).toEqual(["embed.token.mint", "embed.token.mint"]);
    expect(fake.rows("auditLog")[0]).toMatchObject({ tenantId: TENANT_A.id, actorId: "doctor-a" });
  });

  it("caps a platform admin at the tenant's top role", async () => {
    const res = await mint({ ...base, userId: "super" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ role: "CLINIC_OWNER" });
  });
});

describe("SEC-2 · session resolution from an embed token", () => {
  async function contextFor(token: string) {
    requestState.headers.set("authorization", `Bearer ${token}`);
    return getActingContext();
  }

  it("binds a minted token to the real user record", async () => {
    const res = await mint(base);
    const { token } = await res.json();
    const ctx = await contextFor(token);
    expect(ctx).toMatchObject({
      tenantId: TENANT_A.id,
      tenantSlug: TENANT_A.slug,
      userId: "doctor-a",
      email: "doctor@acme",
      role: "DOCTOR",
    });
  });

  it("honours a narrower role carried by the token", async () => {
    const token = await signEmbedToken({ tenantId: TENANT_A.id, tenantSlug: TENANT_A.slug, userId: "doctor-a", role: "ASSISTANT" });
    expect((await contextFor(token))?.role).toBe("ASSISTANT");
  });

  it("rejects a token whose role exceeds the user's stored role — without falling back to the header resolver", async () => {
    // If the embed path fell through, this header would hand out tenant B's owner session.
    requestState.headers.set("x-clinicmind-tenant", TENANT_B.slug);
    for (const role of ["SUPER_ADMIN", "CLINIC_OWNER", "DOCTOR"]) {
      const token = await signEmbedToken({ tenantId: TENANT_A.id, tenantSlug: TENANT_A.slug, userId: "reception-a", role });
      expect(await contextFor(token), role).toBeNull();
    }
  });

  it("rejects a token for a user who is not an active member of the tenant", async () => {
    for (const userId of ["doctor-b", "invited-a", "disabled-a", "deleted-a", "ghost"]) {
      const token = await signEmbedToken({ tenantId: TENANT_A.id, tenantSlug: TENANT_A.slug, userId, role: "ASSISTANT" });
      expect(await contextFor(token), userId).toBeNull();
    }
  });

  it("rejects a token for an inactive tenant", async () => {
    fake.rows("tenant").find((t) => t.id === TENANT_A.id)!.status = "SUSPENDED";
    const token = await signEmbedToken({ tenantId: TENANT_A.id, tenantSlug: TENANT_A.slug, userId: "doctor-a", role: "DOCTOR" });
    expect(await contextFor(token)).toBeNull();
  });

  it("reads the token from the cm_embed cookie as well", async () => {
    const token = await signEmbedToken({ tenantId: TENANT_A.id, tenantSlug: TENANT_A.slug, userId: "doctor-a", role: "DOCTOR" });
    requestState.cookies.set("cm_embed", token);
    expect((await getActingContext())?.userId).toBe("doctor-a");
  });
});
