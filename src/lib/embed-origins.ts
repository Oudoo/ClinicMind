import { systemDb } from "@/lib/db";

/**
 * Allowed framing origins of a tenant's embed surface, read by the proxy to
 * emit `frame-ancestors` for `/embed/<slug>` (SEC-7). Cached briefly so the
 * lookup does not hit the database on every request.
 */
export interface EmbedOrigins {
  enabled: boolean;
  origins: string[];
}

const TTL_MS = 60_000;
const cache = new Map<string, { value: EmbedOrigins | null; expires: number }>();

export async function getEmbedOrigins(slug: string): Promise<EmbedOrigins | null> {
  const hit = cache.get(slug);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;

  let value: EmbedOrigins | null = null;
  try {
    const tenant = await systemDb.tenant.findFirst({
      where: { slug, status: "ACTIVE", deletedAt: null },
      select: { embed: { select: { enabled: true, allowedOrigins: true } } },
    });
    value = tenant?.embed
      ? { enabled: tenant.embed.enabled, origins: tenant.embed.allowedOrigins.filter(isHttpOrigin) }
      : null;
  } catch {
    value = null; // fail closed: no origins → not frameable
  }
  cache.set(slug, { value, expires: now + TTL_MS });
  return value;
}

/** Test hook. */
export function resetEmbedOriginsCache(): void {
  cache.clear();
}

function isHttpOrigin(o: string): boolean {
  try {
    const u = new URL(o);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === o;
  } catch {
    return false;
  }
}
