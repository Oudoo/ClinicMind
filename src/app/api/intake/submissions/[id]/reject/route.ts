import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { rejectSubmission } from "@/modules/intake/service";
import { intakeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/intake/submissions/[id]/reject` `{ note }` → `{ submission }`. 409 when already reviewed. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const body: unknown = await req.json().catch(() => null);
    const submission = await rejectSubmission(ctx.tenantId, id, body ?? {}, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    if (!submission) return notFound("intake_submission");
    return ok({ submission });
  } catch (err) {
    return intakeErrorResponse(err) ?? handleApiError(err);
  }
}
