import { notDeleted, systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import type { Tenant } from "@prisma/client";

/**
 * Multi-tenancy resolution from the request host.
 *
 * A tenant can be reached on a custom domain (clinic.acme.com ->
 * Tenant.customDomain) or a subdomain (acme.clinics.host -> Tenant.slug). The
 * host is only a *hint* used for public surfaces (pre-filling the clinic on the
 * sign-in page, the /embed/<slug> shell). The acting tenant of an authenticated
 * request always comes from the session or embed token (lib/auth/session.ts),
 * never from the host or from a client-supplied header.
 */

/** Strip port and extract the candidate tenant slug from a host header. */
export function resolveTenantHintFromHost(host: string | null): {
  customDomain?: string;
  slug?: string;
} {
  if (!host) return {};
  const hostname = host.split(":")[0]!.toLowerCase();
  const root = env.ROOT_DOMAIN.split(":")[0]!.toLowerCase();

  if (hostname === root || hostname === `www.${root}`) return {};

  if (hostname.endsWith(`.${root}`)) {
    const slug = hostname.slice(0, -1 * (root.length + 1)).split(".")[0];
    return slug ? { slug } : {};
  }

  // Anything else is treated as a (potential) custom domain.
  return { customDomain: hostname };
}

export interface TenantContext {
  tenant: Pick<
    Tenant,
    "id" | "slug" | "name" | "status" | "branding" | "settings" | "customDomain"
  >;
}

/**
 * Load the active tenant for a request. Returns null when no active tenant
 * matches (callers render a 404 / onboarding surface).
 */
export async function getTenantContext(opts: {
  host?: string | null;
  explicitSlug?: string | null;
}): Promise<TenantContext | null> {
  const hint = opts.explicitSlug
    ? { slug: opts.explicitSlug }
    : resolveTenantHintFromHost(opts.host ?? null);

  if (!hint.slug && !hint.customDomain) return null;

  const tenant = await systemDb.tenant.findFirst({
    where: {
      ...notDeleted,
      status: "ACTIVE",
      ...(hint.customDomain
        ? { customDomain: hint.customDomain, customDomainVerified: true }
        : { slug: hint.slug }),
    },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      branding: true,
      settings: true,
      customDomain: true,
    },
  });

  return tenant ? { tenant } : null;
}

export class TenantNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super("Tenant not found or inactive");
    this.name = "TenantNotFoundError";
  }
}

/** Require a tenant or throw — for API handlers. */
export async function requireTenant(opts: {
  host?: string | null;
  explicitSlug?: string | null;
}): Promise<TenantContext> {
  const ctx = await getTenantContext(opts);
  if (!ctx) throw new TenantNotFoundError();
  return ctx;
}
