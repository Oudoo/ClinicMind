import { db, notDeleted } from "@/lib/db";
import { env } from "@/lib/env";
import type { Tenant } from "@prisma/client";

/**
 * Multi-tenancy resolution.
 *
 * A request reaches ClinicMind through one of three surfaces, all mapping to one
 * Tenant:
 *   1. Custom domain   — clinic.acme.com           -> Tenant.customDomain
 *   2. Subdomain       — acme.clinics.host         -> Tenant.slug
 *   3. Explicit header — x-clinicmind-tenant: acme (host dashboard / embed)
 *
 * This keeps each client's instance fully isolated end-to-end.
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

  const tenant = await db.tenant.findFirst({
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
