/**
 * Per-tenant AI providers through the platform console API: keys are stored
 * encrypted, shown only as set/unset with a hint, and resolved for the
 * tenant's calls; clearing works; clinic staff cannot touch them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { GET as getTenant, PATCH as patchTenant } from "@/app/api/tenants/[id]/route";
import { resolveTenantAi } from "@/lib/ai/tenant-config";
import { createTenant, createUser, deleteTenants, request, sessionCookieFor } from "@/test/db";

const hasDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!hasDb)("platform console: AI providers", () => {
  const created: string[] = [];
  let superCookie: string;
  let ownerCookie: string;
  let clinicId: string;

  beforeAll(async () => {
    const platform = await createTenant({ slug: "platform", name: "Platform" }).catch(async () => {
      const existing = await db.tenant.findUnique({ where: { slug: "platform" } });
      if (!existing) throw new Error("could not create the platform tenant");
      return existing;
    });
    if (!created.includes(platform.id)) created.push(platform.id);
    superCookie = await sessionCookieFor((await createUser({ tenantId: platform.id, role: "SUPER_ADMIN" })).id);
    const clinic = await createTenant({ slug: `pai-${Date.now().toString(36)}` });
    created.push(clinic.id);
    clinicId = clinic.id;
    ownerCookie = await sessionCookieFor((await createUser({ tenantId: clinic.id, role: "CLINIC_OWNER" })).id);
  });
  afterAll(async () => deleteTenants(created));

  it("stores providers, models and encrypted keys; never returns a key", async () => {
    const patch = await patchTenant(
      request(`/api/tenants/${clinicId}`, {
        method: "PATCH",
        cookie: superCookie,
        body: { ai: { chatProvider: "openai", transcriptionProvider: "gemini", keys: { openai: "sk-live-secret-1234" }, models: { openaiChat: "gpt-4.1" } } },
      }),
      idParams(clinicId),
    );
    expect(patch.status).toBe(200);
    const detail = await (await getTenant(request(`/api/tenants/${clinicId}`, { cookie: superCookie }), idParams(clinicId))).json();
    expect(detail.tenant.ai.chatProvider).toBe("openai");
    expect(detail.tenant.ai.transcriptionProvider).toBe("gemini");
    expect(detail.tenant.ai.models.openaiChat).toBe("gpt-4.1");
    expect(detail.tenant.ai.keys.openai).toEqual({ set: true, hint: "…1234" });
    expect(detail.tenant.ai.keys.gemini).toEqual({ set: false, hint: null });
    expect(JSON.stringify(detail)).not.toContain("sk-live-secret");

    const row = await db.tenant.findUnique({ where: { id: clinicId }, select: { settings: true } });
    expect(JSON.stringify(row?.settings)).not.toContain("sk-live-secret");
    expect(JSON.stringify(row?.settings)).toContain('"enc":"v1.');

    const overrides = await resolveTenantAi(clinicId);
    expect(overrides?.chatProvider).toBe("openai");
    expect(overrides?.config?.openai).toEqual({ apiKey: "sk-live-secret-1234", chatModel: "gpt-4.1" });
  });

  it("clears a key and an override with empty values, and validates choices", async () => {
    const cleared = await patchTenant(
      request(`/api/tenants/${clinicId}`, { method: "PATCH", cookie: superCookie, body: { ai: { chatProvider: "inherit", keys: { openai: "" } } } }),
      idParams(clinicId),
    );
    expect(cleared.status).toBe(200);
    const detail = await (await getTenant(request(`/api/tenants/${clinicId}`, { cookie: superCookie }), idParams(clinicId))).json();
    expect(detail.tenant.ai.chatProvider).toBe("inherit");
    expect(detail.tenant.ai.keys.openai.set).toBe(false);
    expect(detail.tenant.ai.transcriptionProvider).toBe("gemini");

    const invalid = await patchTenant(
      request(`/api/tenants/${clinicId}`, { method: "PATCH", cookie: superCookie, body: { ai: { chatProvider: "bogus" } } }),
      idParams(clinicId),
    );
    expect(invalid.status).toBe(422);
  });

  it("is platform-only", async () => {
    const res = await patchTenant(
      request(`/api/tenants/${clinicId}`, { method: "PATCH", cookie: ownerCookie, body: { ai: { chatProvider: "openai" } } }),
      idParams(clinicId),
    );
    expect(res.status).toBe(403);
  });
});
