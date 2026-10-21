import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { generateEmbedSecret } from "@/lib/embed";
import { audit } from "@/lib/audit";
import { handleApiError, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

const ProvisionInput = z.object({
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with dashes"),
  name: z.string().min(1),
  ownerEmail: z.string().email(),
  branding: z
    .object({ accent: z.string().optional(), productName: z.string().optional(), logoUrl: z.string().optional() })
    .optional(),
  customDomain: z.string().optional(),
});

/**
 * Provision a new tenant (client instance). Requires `platform:manage`, which
 * only SUPER_ADMIN holds — a clinic owner's `tenant:manage` covers their own
 * tenant's settings, never the platform. Creates the tenant, its embed config
 * (with a freshly generated embed secret), a default clinic and the owner user
 * in one transaction so a new client gets a fully isolated, ready-to-embed
 * ClinicMind. The embed secret is returned once, in this response only.
 */
export async function POST(req: Request) {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "platform:manage");

    const input = ProvisionInput.parse(await req.json());

    const existing = await db.tenant.findFirst({ where: { slug: input.slug } });
    if (existing) return ok({ error: "slug_taken" }, { status: 409 });

    const embedSecret = generateEmbedSecret();

    const tenant = await db.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          slug: input.slug,
          name: input.name,
          status: "ACTIVE",
          branding: input.branding ?? undefined,
          customDomain: input.customDomain,
          embed: {
            create: {
              enabled: true,
              secretHash: embedSecret.hash,
              secretPrefix: embedSecret.prefix,
              secretRotatedAt: new Date(),
            },
          },
          clinics: { create: { name: input.name } },
        },
      });
      await tx.user.create({
        data: { tenantId: t.id, email: input.ownerEmail, role: "CLINIC_OWNER", status: "INVITED" },
      });
      return t;
    });

    await audit({
      tenantId: tenant.id,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      action: "tenant.provision",
      entity: "Tenant",
      entityId: tenant.id,
      after: { slug: tenant.slug, embedSecretPrefix: embedSecret.prefix },
    });

    return ok(
      {
        tenant: { id: tenant.id, slug: tenant.slug },
        // Shown once. Hand it to the client's backend; it is not stored in plaintext.
        embedSecret: embedSecret.secret,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

/** List every tenant on the platform. SUPER_ADMIN only (`platform:manage`). */
export async function GET() {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "platform:manage");
    const tenants = await db.tenant.findMany({
      where: { ...notDeleted },
      select: { id: true, slug: true, name: true, status: true, customDomain: true },
      orderBy: { createdAt: "desc" },
    });
    return ok({ tenants });
  } catch (err) {
    return handleApiError(err);
  }
}
