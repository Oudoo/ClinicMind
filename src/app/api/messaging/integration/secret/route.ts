import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { rotateWebhookSecret } from "@/modules/messaging/integrations";
import { actorOf } from "../../_lib/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

/** `POST /api/messaging/integration/secret` → `{ secret, prefix, rotatedAt }`; the secret is shown exactly once (tenant:manage). */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    return ok(await rotateWebhookSecret(ctx.tenantId, actorOf(ctx, req)), NO_STORE);
  } catch (err) {
    return handleApiError(err);
  }
}
