import { z } from "zod";
import { NextResponse } from "next/server";
import { handleApiError, tooManyRequests } from "@/lib/api";
import {
  AUTH_RATE_WINDOW_MS,
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  PASSWORD_MAX_LENGTH,
  SESSION_COOKIE,
} from "@/lib/auth/constants";
import { authenticateWithPassword } from "@/lib/auth/login";
import { rateLimit } from "@/lib/auth/rate-limit";
import {
  clientIp,
  crossOriginRejected,
  isSameOrigin,
  normalizeEmail,
  safeRedirectPath,
  userAgent,
} from "@/lib/auth/request";
import { createSession, sessionCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().trim().min(3).max(254).email(),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** Tenant slug; only needed when the same credentials exist in several tenants. */
  tenant: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{0,40}$/)
    .optional(),
  /** Path to return to after sign-in (validated server-side). */
  next: z.string().max(512).optional(),
});

/**
 * Password sign-in. On success a server-side `Session` row is created and its
 * token set as an httpOnly, SameSite=Lax cookie. Failures are uniform
 * (`invalid_credentials`) except for `tenant_required`, which is only returned
 * once the password has been verified.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();

    const body = Body.parse(await req.json());
    const email = normalizeEmail(body.email);
    const ip = clientIp(req) ?? "unknown";

    const byIp = rateLimit(`login:ip:${ip}`, LOGIN_IP_LIMIT, AUTH_RATE_WINDOW_MS);
    if (!byIp.ok) return tooManyRequests(byIp.retryAfterSeconds);
    const byEmail = rateLimit(`login:email:${email}`, LOGIN_EMAIL_LIMIT, AUTH_RATE_WINDOW_MS);
    if (!byEmail.ok) return tooManyRequests(byEmail.retryAfterSeconds);

    const result = await authenticateWithPassword({
      email,
      password: body.password,
      tenantSlug: body.tenant || null,
      ip,
      userAgent: userAgent(req),
    });

    if (!result.ok) {
      if (result.reason === "locked") {
        return tooManyRequests(result.retryAfterSeconds, "account_locked");
      }
      return NextResponse.json({ error: result.reason }, { status: 401 });
    }

    const session = await createSession(result.user.id, { ip, userAgent: userAgent(req) });
    const res = NextResponse.json({
      ok: true,
      user: {
        id: result.user.id,
        email: result.user.email,
        fullName: result.user.fullName,
        role: result.user.role,
      },
      tenant: result.user.tenant,
      expiresAt: session.expiresAt.toISOString(),
      // Platform administrators land on the console; everyone else on their clinic.
      redirectTo: safeRedirectPath(body.next) ?? (result.user.role === "SUPER_ADMIN" ? "/platform" : "/dashboard"),
    });
    res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
