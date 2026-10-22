import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { parsePaging } from "@/lib/validation";
import { createPatient, listPatients } from "@/modules/patients/service";

export const dynamic = "force-dynamic";

/**
 * Paginated patient registry of the acting tenant.
 * Query: `q` (name / phone / e-mail), `page`, `pageSize`, `tag`, `archived=1`.
 * Responds `{ patients, total, page, pageSize }`.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");

    const params = new URL(req.url).searchParams;
    const { page, pageSize } = parsePaging(params);
    const result = await listPatients(ctx.tenantId, {
      q: params.get("q") ?? undefined,
      tag: params.get("tag") ?? undefined,
      includeArchived: params.get("archived") === "1",
      page,
      pageSize,
    });
    return ok(result);
  } catch (err) {
    return handleApiError(err);
  }
}

/** Register a patient. Responds 201 `{ patient }`, or 422 with field errors. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const body: unknown = await req.json().catch(() => null);
    const patient = await createPatient(ctx.tenantId, body, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok({ patient }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
