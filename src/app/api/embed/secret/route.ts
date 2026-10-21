import { db } from "@/lib/db";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { generateEmbedSecret } from "@/lib/embed";
import { audit } from "@/lib/audit";
import { handleApiError, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Generate (or rotate) the acting tenant's embed secret.
 *
 * The plaintext is returned exactly once in this response and only its SHA-256
 * hash is stored; there is no endpoint that reads it back. Rotating invalidates
 * the previous secret immediately — tokens already minted stay valid until
 * they expire (≤ 1 hour).
 */
export async function POST() {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "embed:manage");

    const generated = generateEmbedSecret();
    const rotatedAt = new Date();

    const previous = await db.tenantEmbedConfig.findUnique({
      where: { tenantId: ctx.tenantId },
      select: { secretPrefix: true },
    });

    const config = await db.tenantEmbedConfig.upsert({
      where: { tenantId: ctx.tenantId },
      // A tenant without an embed config gets one, still disabled: generating a
      // secret must not silently switch embedding on.
      create: {
        tenantId: ctx.tenantId,
        enabled: false,
        secretHash: generated.hash,
        secretPrefix: generated.prefix,
        secretRotatedAt: rotatedAt,
      },
      update: {
        secretHash: generated.hash,
        secretPrefix: generated.prefix,
        secretRotatedAt: rotatedAt,
      },
      select: { enabled: true, secretPrefix: true, secretRotatedAt: true },
    });

    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      action: previous?.secretPrefix ? "embed.secret.rotate" : "embed.secret.generate",
      entity: "TenantEmbedConfig",
      entityId: ctx.tenantId,
      before: { secretPrefix: previous?.secretPrefix ?? null },
      after: { secretPrefix: config.secretPrefix },
    });

    return ok(
      {
        secret: generated.secret,
        prefix: config.secretPrefix,
        rotatedAt: config.secretRotatedAt,
        enabled: config.enabled,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
