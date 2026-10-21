import { z } from "zod";
import { NextResponse } from "next/server";
import { handleApiError, tooManyRequests } from "@/lib/api";
import { setPasswordWithToken } from "@/lib/auth/auth-tokens";
import { AUTH_RATE_WINDOW_MS, SESSION_COOKIE, SET_PASSWORD_IP_LIMIT } from "@/lib/auth/constants";
import { PasswordSchema } from "@/lib/auth/password";
import { rateLimit } from "@/lib/auth/rate-limit";
import { clientIp, crossOriginRejected, isSameOrigin, userAgent } from "@/lib/auth/request";
import { sessionCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  token: z.string().min(1).max(128),
  password: PasswordSchema,
});

/**
 * Complete an invitation or password reset: consume the single-use token, set
 * the password, activate the user, revoke their other sessions and sign the
 * caller in.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();

    const ip = clientIp(req) ?? "unknown";
    const byIp = rateLimit(`set-password:ip:${ip}`, SET_PASSWORD_IP_LIMIT, AUTH_RATE_WINDOW_MS);
    if (!byIp.ok) return tooManyRequests(byIp.retryAfterSeconds);

    const body = Body.parse(await req.json());
    const result = await setPasswordWithToken(body.token, body.password, {
      ip,
      userAgent: userAgent(req),
    });

    if (!result.ok) {
      return NextResponse.json({ error: `${result.reason}_token` }, { status: 400 });
    }

    const res = NextResponse.json({ ok: true, kind: result.kind, redirectTo: "/dashboard" });
    res.cookies.set(SESSION_COOKIE, result.session.token, sessionCookieOptions(result.session.expiresAt));
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
