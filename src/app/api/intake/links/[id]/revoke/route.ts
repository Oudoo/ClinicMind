import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { revokeIntakeLink } from "@/modules/intake/service";

export const dynamic = "force-dynamic";

/** `POST /api/intake/links/[id]/revoke` → `{ link }`; the token stops working immediately. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const link = await revokeIntakeLink(ctx.tenantId, id, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    if (!link) return notFound("intake_link");
    return ok({ link });
  } catch (err) {
    return handleApiError(err);
  }
}
