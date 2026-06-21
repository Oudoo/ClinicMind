import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { signEmbedToken } from "@/lib/embed";
import { handleApiError, ok } from "@/lib/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const Body = z.object({
  tenantSlug: z.string(),
  userId: z.string(),
  role: z.enum(["SUPER_ADMIN", "CLINIC_OWNER", "DOCTOR", "RECEPTIONIST", "NURSE", "ASSISTANT"]),
  origin: z.string().url().optional(),
  ttlSeconds: z.number().int().min(60).max(3600).optional(),
});

/**
 * Server-to-server: mint a short-lived embed session token.
 *
 * The client's backend calls this with the tenant's embed public key (kept
 * server-side, NOT in the browser) to bridge their own logged-in session into an
 * authenticated, tenant-scoped ClinicMind iframe. This is the trust boundary that
 * lets every client run their own version under their own domain.
 */
export async function POST(req: Request) {
  try {
    const key = req.headers.get("x-clinicmind-embed-key");
    if (!key) {
      return NextResponse.json({ error: "missing_embed_key" }, { status: 401 });
    }

    const body = Body.parse(await req.json());

    const tenant = await db.tenant.findFirst({
      where: { slug: body.tenantSlug, status: "ACTIVE", ...notDeleted },
      include: { embed: true },
    });

    if (!tenant || !tenant.embed?.enabled || tenant.embed.publicKey !== key) {
      return NextResponse.json({ error: "invalid_tenant_or_key" }, { status: 403 });
    }

    if (body.origin && tenant.embed.allowedOrigins.length) {
      const originHost = new URL(body.origin).origin;
      if (!tenant.embed.allowedOrigins.includes(originHost)) {
        return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
      }
    }

    const token = await signEmbedToken(
      {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        userId: body.userId,
        role: body.role,
        origin: body.origin,
      },
      body.ttlSeconds ?? 600,
    );

    return ok({ token, expiresIn: body.ttlSeconds ?? 600 });
  } catch (err) {
    return handleApiError(err);
  }
}
