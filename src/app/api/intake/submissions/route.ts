import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { parsePaging } from "@/lib/validation";
import { countSubmissionsByStatus, listSubmissions } from "@/modules/intake/service";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["PENDING", "ACCEPTED", "REJECTED", "all"]);

/**
 * `GET /api/intake/submissions?status=PENDING|ACCEPTED|REJECTED|all&patientId=&page=&pageSize=`
 * → `{ submissions, total, page, pageSize, counts }`. Pending ones oldest first,
 * each with the phone-match suggestion (`matchedPatient`). Requires `patients:write`.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const params = new URL(req.url).searchParams;
    const { page, pageSize } = parsePaging(params);
    const statusRaw = params.get("status") ?? "PENDING";
    const status = STATUSES.has(statusRaw) ? (statusRaw as "PENDING" | "ACCEPTED" | "REJECTED" | "all") : "PENDING";
    const [result, counts] = await Promise.all([
      listSubmissions(ctx.tenantId, {
        status,
        page,
        pageSize,
        patientId: params.get("patientId")?.trim().slice(0, 64) || undefined,
      }),
      countSubmissionsByStatus(ctx.tenantId),
    ]);
    return ok({ ...result, counts });
  } catch (err) {
    return handleApiError(err);
  }
}
