import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { ok, unauthorized } from "@/lib/api";
import { parsePaging } from "@/lib/validation";
import { handleConsultationError, listConsultations, ListQuery } from "@/modules/consultations/service";

export const dynamic = "force-dynamic";

/**
 * Recent consultations of the acting tenant, drafts awaiting review first.
 * `?status=` and `?patientId=` filter; `?page=&pageSize=` paginate.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:read");

    const params = new URL(req.url).searchParams;
    const query = ListQuery.parse({
      status: params.get("status") ?? undefined,
      patientId: params.get("patientId") ?? undefined,
    });
    const { page, pageSize } = parsePaging(params, { pageSize: 25, maxPageSize: 100 });

    return ok(await listConsultations(ctx.tenantId, { ...query, page, pageSize }));
  } catch (err) {
    return handleConsultationError(err);
  }
}
