import { z } from "zod";
import { handleApiError, ok, tooManyRequests } from "@/lib/api";
import { requestPasswordReset } from "@/lib/auth/auth-tokens";
import { AUTH_RATE_WINDOW_MS, RESET_EMAIL_LIMIT, RESET_IP_LIMIT } from "@/lib/auth/constants";
import { rateLimit } from "@/lib/auth/rate-limit";
import { clientIp, crossOriginRejected, isSameOrigin, normalizeEmail, userAgent } from "@/lib/auth/request";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().trim().min(3).max(254).email(),
  tenant: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{0,40}$/)
    .optional(),
});

/**
 * Request a password-reset (or, for a user who never set a password, a fresh
 * invitation) link by e-mail. The response is identical whether or not the
 * address is known.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();

    const body = Body.parse(await req.json());
    const email = normalizeEmail(body.email);
    const ip = clientIp(req) ?? "unknown";

    const byIp = rateLimit(`reset:ip:${ip}`, RESET_IP_LIMIT, AUTH_RATE_WINDOW_MS);
    if (!byIp.ok) return tooManyRequests(byIp.retryAfterSeconds);
    const byEmail = rateLimit(`reset:email:${email}`, RESET_EMAIL_LIMIT, AUTH_RATE_WINDOW_MS);
    if (!byEmail.ok) return tooManyRequests(byEmail.retryAfterSeconds);

    await requestPasswordReset({ email, tenantSlug: body.tenant || null, ip: clientIp(req), userAgent: userAgent(req) });
    return ok({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
