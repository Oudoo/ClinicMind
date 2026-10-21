import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api";
import { EMBED_COOKIE, SESSION_COOKIE } from "@/lib/auth/constants";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { clearedCookieOptions, getActingContext, revokeSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Sign out: revoke the current session row (if any) and clear both credential
 * cookies. Idempotent — an already signed-out caller gets the same 200.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();

    const ctx = await getActingContext(req);
    if (ctx?.auth.method === "session") await revokeSession(ctx.auth.sessionId);

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", clearedCookieOptions());
    res.cookies.set(EMBED_COOKIE, "", { ...clearedCookieOptions(), sameSite: "none", secure: true });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
