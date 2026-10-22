import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { ok, unauthorized } from "@/lib/api";
import { OwnerInviteInput } from "@/modules/platform/dto";
import { inviteOwner } from "@/modules/platform/service";
import { handlePlatformError } from "@/modules/platform/http";

export const dynamic = "force-dynamic";

/**
 * Invite (or re-invite) the clinic owner of a tenant. The single-use link is
 * e-mailed and returned so the platform administrator can hand it over.
 * `platform:manage` only.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "platform:manage");
    const input = OwnerInviteInput.parse(await req.json());
    const result = await inviteOwner(id, input, { userId: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handlePlatformError(err);
  }
}
