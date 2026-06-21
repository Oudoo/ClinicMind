import { NextResponse, type NextRequest } from "next/server";
import { resolveTenantHintFromHost } from "@/lib/tenant";

/**
 * Edge middleware.
 *
 *  - Resolves the tenant hint from the host (custom domain / subdomain) and
 *    forwards it downstream via `x-clinicmind-tenant`.
 *  - Applies a strict framing policy: the embeddable surface (/embed/*) is
 *    allowed to be framed (frame-ancestors is finalized per-tenant in the route
 *    handler from its allow-list); everything else is same-origin only.
 *
 * Note: full DB lookups don't run at the edge — only host parsing. The route
 * layer performs the authoritative tenant + embed-origin checks.
 */
export function middleware(req: NextRequest) {
  const host = req.headers.get("host");
  const hint = resolveTenantHintFromHost(host);

  const requestHeaders = new Headers(req.headers);
  if (hint.slug) requestHeaders.set("x-clinicmind-tenant", hint.slug);
  if (hint.customDomain) requestHeaders.set("x-clinicmind-domain", hint.customDomain);

  const res = NextResponse.next({ request: { headers: requestHeaders } });

  const isEmbed = req.nextUrl.pathname.startsWith("/embed");
  if (!isEmbed) {
    // Hard deny framing for the admin surface; embed routes set their own CSP.
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|embed.js).*)"],
};
