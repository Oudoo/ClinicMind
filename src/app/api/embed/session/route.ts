import { z } from "zod";
import { cookies } from "next/headers";
import { verifyEmbedToken } from "@/lib/embed";
import { handleApiError, ok } from "@/lib/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const Body = z.object({ token: z.string() });

/**
 * Exchange a signed embed token for an httpOnly session cookie scoped to the
 * iframe. Called by the embedded surface after it receives the token from the
 * host page via postMessage.
 */
export async function POST(req: Request) {
  try {
    const { token } = Body.parse(await req.json());
    const claims = await verifyEmbedToken(token); // throws if invalid/expired

    const cookieStore = await cookies();
    cookieStore.set("cm_embed", token, {
      httpOnly: true,
      // SameSite=None cookies are only accepted with Secure; browsers treat
      // http://localhost as a secure context, so this also works for local embeds.
      secure: true,
      sameSite: "none", // allow the cookie inside a cross-site iframe
      path: "/",
      maxAge: 600,
    });

    return ok({ ok: true, tenant: claims.tenantSlug, role: claims.role });
  } catch (err) {
    if (err instanceof Error && err.name !== "ZodError") {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }
    return handleApiError(err);
  }
}
