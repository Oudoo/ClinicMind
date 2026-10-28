import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { handleApiError } from "@/lib/api";
import { EMBED_COOKIE, SESSION_COOKIE } from "@/lib/auth/constants";
import { clientIp, crossOriginRejected, isSameOrigin, userAgent } from "@/lib/auth/request";
import { clearedCookieOptions, getActingContext, revokeSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Sign out: revoke the current session row (if any), record it in the audit
 * log, and clear both credential cookies. `Clear-Site-Data` asks the browser
 * to drop this site's cached pages and stored data too (cookies are cleared
 * one by one above rather than with the "cookies" directive, which would also
 * sign the person out of other clinics on sibling subdomains). Idempotent — an
 * already signed-out caller gets the same 200.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();

    const ctx = await getActingContext(req);
    if (ctx?.auth.method === "session") {
      await revokeSession(ctx.auth.sessionId);
      await audit({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorEmail: ctx.email,
        action: "auth.logout",
        entity: "User",
        entityId: ctx.userId,
        patientId: null,
        ip: clientIp(req),
        device: userAgent(req),
      });
    }

    const res = NextResponse.json({ ok: true });
    res.headers.set("Clear-Site-Data", '"cache", "storage"');
    res.headers.set("Cache-Control", "no-store");
    res.cookies.set(SESSION_COOKIE, "", clearedCookieOptions());
    res.cookies.set(EMBED_COOKIE, "", { ...clearedCookieOptions(), sameSite: "none", secure: true });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
