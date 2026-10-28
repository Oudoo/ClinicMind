import { NextResponse } from "next/server";
import { notDeleted, systemDb } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Caddy's on-demand TLS "ask" endpoint: `GET /api/tls/ask?domain=<host>`.
 * Answers 200 when this deployment should obtain a certificate for the host
 * and 404 otherwise, so the TLS terminator never requests certificates for
 * hostnames that are not ours. Allowed: the app host, the root domain and its
 * `www`, `<slug>.<root domain>` for an active tenant, and an active tenant's
 * verified custom domain. Unauthenticated by design; it reveals only whether a
 * hostname is served, which DNS reveals anyway.
 */
export async function GET(req: Request) {
  const domain = (new URL(req.url).searchParams.get("domain") ?? "").trim().toLowerCase();
  if (!HOSTNAME.test(domain)) return answer(false);

  const root = env.ROOT_DOMAIN.split(":")[0]!.toLowerCase();
  let appHost = "";
  try {
    appHost = new URL(env.APP_URL).hostname.toLowerCase();
  } catch {
    appHost = "";
  }
  if (domain === root || domain === `www.${root}` || domain === appHost) return answer(true);

  if (domain.endsWith(`.${root}`)) {
    const slug = domain.slice(0, -(root.length + 1));
    if (!slug || slug.includes(".")) return answer(false);
    const tenant = await systemDb.tenant.findFirst({ where: { slug, status: "ACTIVE", ...notDeleted }, select: { id: true } });
    return answer(Boolean(tenant));
  }

  const custom = await systemDb.tenant.findFirst({
    where: { customDomain: domain, customDomainVerified: true, status: "ACTIVE", ...notDeleted },
    select: { id: true },
  });
  return answer(Boolean(custom));
}

function answer(allowed: boolean) {
  return NextResponse.json({ allowed }, { status: allowed ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
