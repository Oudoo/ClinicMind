import { NextResponse, type NextRequest } from "next/server";
import { EMBED_COOKIE, SESSION_COOKIE } from "@/lib/auth/constants";
import { rateLimit } from "@/lib/auth/rate-limit";
import { getEmbedOrigins } from "@/lib/embed-origins";

/**
 * Request proxy (the Next.js 16 successor of `middleware.ts`; runs on the Node.js runtime).
 *
 *  - Strips the legacy `x-clinicmind-*` tenant headers from every request. The
 *    acting tenant is derived from the authenticated session or embed token
 *    (lib/auth/session.ts), never from the host or a client-supplied header.
 *  - Sends dashboard visitors who carry no credential cookie at all to /login,
 *    preserving the requested path. This is a cheap short-circuit without a DB
 *    round trip; the dashboard layout performs the authoritative session check.
 *  - Rate-limits the API per client address, with tighter budgets on the AI and
 *    token-minting endpoints (SEC-8). State is per process; the per-account
 *    lockouts in lib/auth are database-backed.
 *  - Emits the Content-Security-Policy. `/embed/<slug>` may be framed only by
 *    that tenant's allow-listed origins (SEC-7); every other page refuses to be
 *    framed at all.
 */
export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (pathname.startsWith("/api/")) {
    const limited = apiRateLimit(req, pathname);
    if (limited) return limited;
  }

  if (isDashboardPath(pathname) && !req.cookies.has(SESSION_COOKIE) && !req.cookies.has(EMBED_COOKIE)) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return withSecurityHeaders(NextResponse.redirect(login), pathname, null);
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete("x-clinicmind-tenant");
  requestHeaders.delete("x-clinicmind-domain");

  const embedSlug = embedSlugOf(pathname);
  const frameAncestors = embedSlug ? await embedFrameAncestors(embedSlug) : null;

  return withSecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    pathname,
    frameAncestors,
  );
}

function isDashboardPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

function embedSlugOf(pathname: string): string | null {
  const m = /^\/embed\/([a-z0-9-]+)\/?$/.exec(pathname);
  return m ? m[1]! : null;
}

async function embedFrameAncestors(slug: string): Promise<string> {
  const cfg = await getEmbedOrigins(slug);
  if (!cfg || !cfg.enabled || cfg.origins.length === 0) return "'self'";
  return `'self' ${cfg.origins.join(" ")}`;
}

// ── Rate limiting ────────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 1000;
const LIMITS: { test: (p: string) => boolean; limit: number; name: string }[] = [
  {
    test: (p) =>
      p === "/api/assistant" ||
      p === "/api/consultations/extract" ||
      p === "/api/consultations/transcribe" ||
      /^\/api\/patients\/[^/]+\/history\/extract$/.test(p),
    limit: 40,
    name: "ai",
  },
  { test: (p) => p === "/api/embed/token", limit: 60, name: "embed-token" },
  { test: () => true, limit: 600, name: "api" },
];

function apiRateLimit(req: NextRequest, pathname: string): NextResponse | null {
  // Authentication endpoints have their own per-e-mail and per-IP budgets.
  if (pathname.startsWith("/api/auth/") || pathname === "/api/health") return null;
  const ip = clientAddress(req);
  for (const rule of LIMITS) {
    if (!rule.test(pathname)) continue;
    const result = rateLimit(`${rule.name}:${ip}`, rule.limit, WINDOW_MS);
    if (!result.ok) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterSeconds: result.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds), "Cache-Control": "no-store" } },
      );
    }
    if (rule.name !== "api") {
      // Specific budgets also count against the general one.
      const general = rateLimit(`api:${ip}`, 600, WINDOW_MS);
      if (!general.ok) {
        return NextResponse.json(
          { error: "rate_limited", retryAfterSeconds: general.retryAfterSeconds },
          { status: 429, headers: { "Retry-After": String(general.retryAfterSeconds) } },
        );
      }
    }
    return null;
  }
  return null;
}

function clientAddress(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return (first || req.headers.get("x-real-ip") || "unknown").slice(0, 64);
}

// ── Security headers ─────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== "production";

function contentSecurityPolicy(frameAncestors: string): string {
  return [
    "default-src 'self'",
    // Next.js injects inline bootstrap scripts; dev needs eval for fast refresh.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

function withSecurityHeaders(res: NextResponse, pathname: string, embedFrameAncestors: string | null): NextResponse {
  // Patient photos set their own, stricter policy (default-src 'none'; sandbox).
  if (pathname.startsWith("/api/concierge/files/")) {
    res.headers.set("X-Frame-Options", "DENY");
    return res;
  }
  const isEmbed = pathname.startsWith("/embed");
  if (isEmbed) {
    res.headers.set("Content-Security-Policy", contentSecurityPolicy(embedFrameAncestors ?? "'self'"));
  } else {
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Content-Security-Policy", contentSecurityPolicy("'none'"));
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|embed.js|logo.svg|icon.svg).*)"],
};
