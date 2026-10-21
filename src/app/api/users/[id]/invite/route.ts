import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { assertCan } from "@/lib/auth/rbac";
import { getActingContext } from "@/lib/auth/session";
import { inviteUser } from "@/lib/auth/auth-tokens";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";

export const dynamic = "force-dynamic";

/** Re-issue the invitation of a staff member who has not set a password yet. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "users:manage");

    const user = await db.user.findFirst({
      where: { id: params.id, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, email: true, fullName: true, status: true, passwordHash: true },
    });
    if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (user.status !== "INVITED" && user.passwordHash) {
      return NextResponse.json({ error: "already_active" }, { status: 409 });
    }

    const invite = await inviteUser({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      tenantName: ctx.tenantName,
    });

    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      ip: clientIp(req),
      action: "user.invite.resend",
      entity: "User",
      entityId: user.id,
    });

    return ok({ inviteUrl: invite.url, inviteExpiresAt: invite.expiresAt.toISOString() });
  } catch (err) {
    return handleApiError(err);
  }
}
