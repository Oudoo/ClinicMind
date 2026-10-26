import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp } from "@/lib/auth/request";
import { handleApiError, unauthorized } from "@/lib/api";
import { parsePatientListQuery } from "@/modules/patients/filters";
import { exportPatientsCsv } from "@/modules/patients/export";

export const dynamic = "force-dynamic";

/**
 * `GET /api/patients/export?…` — the filtered patient list as CSV (same query
 * parameters as `GET /api/patients`, paging ignored, at most 5,000 rows).
 * UTF-8 with a byte-order mark so Excel renders Arabic; the export is audited
 * as `patient.export` with the filters and the row count. Requires `patients:export` (the clinic owner).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:export");

    const query = parsePatientListQuery(new URL(req.url).searchParams);
    const result = await exportPatientsCsv(ctx.tenantId, query, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return new Response(result.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "X-Row-Count": String(result.rows),
        ...(result.truncated ? { "X-Truncated": "1" } : {}),
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
