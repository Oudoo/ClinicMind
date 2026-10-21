import { NextResponse } from "next/server";

/**
 * Request-level helpers for route handlers: cookie parsing, client metadata,
 * a same-origin check for cookie-authenticated mutations and redirect-target
 * validation.
 */

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * Best-effort client address. Trusts the first `X-Forwarded-For` hop, which is
 * correct behind the reverse proxy / TLS terminator the app is deployed behind
 * and merely imprecise without one.
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = req.headers.get("x-real-ip");
  return real ? real.slice(0, 64) : null;
}

export function userAgent(req: Request): string | null {
  const ua = req.headers.get("user-agent");
  return ua ? ua.slice(0, 512) : null;
}

/**
 * CSRF defense-in-depth on top of `SameSite=Lax` cookies: when a browser sends
 * an `Origin` header on a state-changing request it must match the host the
 * request arrived on (directly or via `X-Forwarded-Host`). Requests without an
 * `Origin` header (server-to-server, tests, curl) are allowed through; the
 * session cookie is still required.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  if (origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [req.headers.get("x-forwarded-host"), req.headers.get("host")]
    .filter((h): h is string => Boolean(h))
    .map((h) => h.split(",")[0]!.trim().toLowerCase());
  if (hosts.length === 0) {
    try {
      hosts.push(new URL(req.url).host.toLowerCase());
    } catch {
      return false;
    }
  }
  return hosts.includes(originHost);
}

export function crossOriginRejected(): NextResponse {
  return NextResponse.json(
    { error: "forbidden", message: "Cross-origin request rejected" },
    { status: 403 },
  );
}

/**
 * Only allow redirects back into this app after sign-in: a single leading
 * slash, no scheme, no protocol-relative `//host` form.
 */
export function safeRedirectPath(candidate: string | null | undefined): string | null {
  if (!candidate || candidate.length > 512) return null;
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.startsWith("/\\")) {
    return null;
  }
  if (/[\r\n]/.test(candidate)) return null;
  return candidate;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
