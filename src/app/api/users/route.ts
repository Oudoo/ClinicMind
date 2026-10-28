import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { assertCan, grantableRoles } from "@/lib/auth/rbac";
import { getActingContext } from "@/lib/auth/session";
import { inviteUser } from "@/lib/auth/auth-tokens";
import { clientIp, crossOriginRejected, isSameOrigin, normalizeEmail } from "@/lib/auth/request";

export const dynamic = "force-dynamic";

const InviteInput = z.object({
  email: z.string().trim().min(3).max(254).email(),
  fullName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["SUPER_ADMIN", "CLINIC_OWNER", "DOCTOR", "NURSE", "RECEPTIONIST", "ASSISTANT"]),
  clinicId: z.string().optional(),
  /** Defaults to true for doctors; the owner sets it for anyone else who signs clinical records. */
  isClinician: z.boolean().optional(),
});

const userSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  clinicId: true,
  isClinician: true,
  createdAt: true,
} as const;

/** Staff of the acting tenant. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "users:manage");
    const users = await db.user.findMany({
      where: { tenantId: ctx.tenantId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: userSelect,
    });
    return ok({ users });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * Invite a staff member: creates an INVITED user in the acting tenant and
 * e-mails a single-use link to set their password. The link is also returned
 * so the administrator can hand it over directly.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "users:manage");

    const input = InviteInput.parse(await req.json());
    if (!grantableRoles(ctx.role).includes(input.role)) {
      return NextResponse.json({ error: "role_not_grantable" }, { status: 403 });
    }

    const email = normalizeEmail(input.email);
    const existing = await db.user.findFirst({
      where: { tenantId: ctx.tenantId, email: { equals: email, mode: "insensitive" }, deletedAt: null },
      select: { id: true },
    });
    if (existing) return NextResponse.json({ error: "email_taken" }, { status: 409 });

    if (input.clinicId) {
      const clinic = await db.clinic.findFirst({
        where: { id: input.clinicId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!clinic) return NextResponse.json({ error: "clinic_not_found" }, { status: 404 });
    }

    const user = await db.user.create({
      data: {
        tenantId: ctx.tenantId,
        clinicId: input.clinicId,
        email,
        fullName: input.fullName,
        role: input.role,
        status: "INVITED",
        isClinician: input.isClinician ?? input.role === "DOCTOR",
      },
      select: userSelect,
    });

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
      action: "user.invite",
      entity: "User",
      entityId: user.id,
      after: { email: user.email, role: user.role, isClinician: user.isClinician },
    });

    return ok({ user, inviteUrl: invite.url, inviteExpiresAt: invite.expiresAt.toISOString() }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
