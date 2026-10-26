import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { acceptSubmission } from "@/modules/intake/service";
import { intakeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/intake/submissions/[id]/accept` `{ mode: "create" | "merge", patientId? }`
 * → `{ submission, patientId, created }`. `create` registers a new patient from
 * the form; `merge` fills the empty fields of `patientId` (default: the
 * phone-matched patient) and appends history. 409 when already reviewed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const body: unknown = await req.json().catch(() => null);
    const result = await acceptSubmission(ctx.tenantId, id, body ?? {}, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    if (!result) return notFound("intake_submission");
    return ok(result);
  } catch (err) {
    return intakeErrorResponse(err) ?? handleApiError(err);
  }
}
