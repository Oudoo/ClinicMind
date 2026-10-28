import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { assertCan } from "@/lib/auth/rbac";
import { getActingContext } from "@/lib/auth/session";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";

export const dynamic = "force-dynamic";

const UserUpdateInput = z.object({
  /** May this person sign clinical notes and procedures (with their role's permission)? */
  isClinician: z.boolean(),
});

/**
 * `PATCH /api/users/[id]` `{ isClinician }` — the clinic owner marks a staff
 * member as a clinician or not (users:manage). Nobody changes their own mark,
 * so a non-clinician administrator cannot grant themselves the right to sign;
 * another owner or the platform administrator does it. Audited.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "users:manage");
    const input = UserUpdateInput.parse(await req.json());

    if (id === ctx.userId) {
      return NextResponse.json(
        { error: "own_clinician_mark", message: "Another owner or the platform administrator changes your own clinician mark." },
        { status: 403 },
      );
    }
    const before = await db.user.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      select: { id: true, email: true, role: true, isClinician: true },
    });
    if (!before) return NextResponse.json({ error: "not_found", entity: "user" }, { status: 404 });
    if (before.role === "SUPER_ADMIN" && ctx.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const user = await db.user.update({
      where: { id: before.id },
      data: { isClinician: input.isClinician },
      select: { id: true, email: true, fullName: true, role: true, status: true, isClinician: true },
    });
    if (before.isClinician !== user.isClinician) {
      await audit({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorEmail: ctx.email,
        ip: clientIp(req),
        action: "user.clinician",
        entity: "User",
        entityId: user.id,
        before: { isClinician: before.isClinician },
        after: { isClinician: user.isClinician },
      });
    }
    return ok({ user });
  } catch (err) {
    return handleApiError(err);
  }
}
