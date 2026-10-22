import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { restorePatient } from "@/modules/patients/service";

export const dynamic = "force-dynamic";

/** Bring an archived patient back. 404 unless the patient is archived in this tenant. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const patient = await restorePatient(ctx.tenantId, id, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    if (!patient) return notFound("patient");
    return ok({ patient });
  } catch (err) {
    return handleApiError(err);
  }
}
