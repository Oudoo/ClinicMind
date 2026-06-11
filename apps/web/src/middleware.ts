import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PATHS = ["/login", "/register", "/audit", "/api/auth", "/api/public", "/api/v1", "/accept-invite"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Cookie name depends on transport (https → __Secure- prefix); accept both
  // so the app works behind any proxy/TLS topology.
  const token =
    (await getToken({
      req: request,
      secret: process.env.AUTH_SECRET,
      secureCookie: true,
    })) ??
    (await getToken({
      req: request,
      secret: process.env.AUTH_SECRET,
      secureCookie: false,
    }));
  if (!token) {
    const url = new URL("/login", request.url);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }

  // Client-portal users may only access their portal + shared APIs
  if (token.clientId && !pathname.startsWith("/client/") && !pathname.startsWith("/api/")) {
    return NextResponse.redirect(new URL(`/client/${token.tenantSlug}`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)).*)"],
};
