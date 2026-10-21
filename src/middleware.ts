import { NextResponse, type NextRequest } from "next/server";
import { EMBED_COOKIE, SESSION_COOKIE } from "@/lib/auth/constants";

/**
 * Edge middleware.
 *
 *  - Strips the legacy `x-clinicmind-*` tenant headers from every request. The
 *    acting tenant is derived from the authenticated session or embed token
 *    (lib/auth/session.ts), never from the host or a client-supplied header.
 *  - Sends dashboard visitors who carry no credential cookie at all to /login,
 *    preserving the requested path. This is a cheap short-circuit without a DB
 *    round trip; the dashboard layout performs the authoritative session check.
 *  - Applies the framing policy: /embed/* may be framed (frame-ancestors is
 *    finalised per tenant in the route layer); everything else is same-origin.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isDashboardPath(pathname) && !req.cookies.has(SESSION_COOKIE) && !req.cookies.has(EMBED_COOKIE)) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return withFramingPolicy(NextResponse.redirect(login), pathname);
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete("x-clinicmind-tenant");
  requestHeaders.delete("x-clinicmind-domain");

  return withFramingPolicy(NextResponse.next({ request: { headers: requestHeaders } }), pathname);
}

function isDashboardPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

function withFramingPolicy(res: NextResponse, pathname: string): NextResponse {
  if (!pathname.startsWith("/embed")) {
    // Hard deny framing for the admin surface; embed routes set their own CSP.
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|embed.js).*)"],
};
