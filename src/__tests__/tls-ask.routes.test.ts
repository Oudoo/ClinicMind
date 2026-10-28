/**
 * Caddy on-demand TLS gate: which hostnames this deployment will obtain
 * certificates for. ROOT_DOMAIN in tests is lvh.me:3000.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { GET as ask } from "@/app/api/tls/ask/route";
import { createTenant, deleteTenants } from "@/test/db";

const hasDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const status = (domain: string) => ask(new Request(`http://localhost:3000/api/tls/ask?domain=${encodeURIComponent(domain)}`)).then((r) => r.status);

describe.skipIf(!hasDb)("GET /api/tls/ask", () => {
  const created: string[] = [];
  const stamp = Date.now().toString(36);
  const active = `tls-${stamp}`;
  const suspended = `tls-off-${stamp}`;

  beforeAll(async () => {
    created.push((await createTenant({ slug: active })).id);
    created.push((await createTenant({ slug: suspended, status: "SUSPENDED" })).id);
    const custom = await createTenant({ slug: `tls-custom-${stamp}` });
    created.push(custom.id);
    await db.tenant.update({ where: { id: custom.id }, data: { customDomain: `app.${stamp}.example`, customDomainVerified: true } });
    const unverified = await createTenant({ slug: `tls-unv-${stamp}` });
    created.push(unverified.id);
    await db.tenant.update({ where: { id: unverified.id }, data: { customDomain: `portal.${stamp}.example`, customDomainVerified: false } });
  });

  afterAll(async () => deleteTenants(created));

  it("allows the root domain, its www and an active tenant's subdomain", async () => {
    expect(await status("lvh.me")).toBe(200);
    expect(await status("www.lvh.me")).toBe(200);
    expect(await status(`${active}.lvh.me`)).toBe(200);
    expect(await status(`${active.toUpperCase()}.LVH.ME`)).toBe(200);
  });

  it("refuses unknown, nested, suspended and malformed hostnames", async () => {
    expect(await status(`nope-${stamp}.lvh.me`)).toBe(404);
    expect(await status(`${suspended}.lvh.me`)).toBe(404);
    expect(await status(`deep.${active}.lvh.me`)).toBe(404);
    expect(await status("")).toBe(404);
    expect(await status("not a host")).toBe(404);
    expect(await status("localhost")).toBe(404);
    expect(await status("evil.example")).toBe(404);
  });

  it("allows a verified custom domain and refuses an unverified one", async () => {
    expect(await status(`app.${stamp}.example`)).toBe(200);
    expect(await status(`portal.${stamp}.example`)).toBe(404);
  });

  it("never caches its answer", async () => {
    const res = await ask(new Request("http://localhost:3000/api/tls/ask?domain=lvh.me"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
