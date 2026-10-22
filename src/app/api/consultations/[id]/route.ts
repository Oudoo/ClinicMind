import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { ok, unauthorized } from "@/lib/api";
import { getConsultation, handleConsultationError } from "@/modules/consultations/service";

export const dynamic = "force-dynamic";

/** One consultation in full: transcript, extraction, summary, status, patient, visit. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:read");

    const consultation = await getConsultation(ctx.tenantId, id);
    // A foreign-tenant id looks exactly like a missing one.
    if (!consultation) return ok({ error: "not_found", entity: "consultation" }, { status: 404 });
    return ok({ consultation });
  } catch (err) {
    return handleConsultationError(err);
  }
}
