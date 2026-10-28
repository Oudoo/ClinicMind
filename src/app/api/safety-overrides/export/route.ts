import { getActingContext } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request";
import { handleApiError, unauthorized } from "@/lib/api";
import { exportSafetyOverridesCsv, OverrideListQuery, overrideScope } from "@/modules/consultations/safety/overrides";

export const dynamic = "force-dynamic";

/**
 * `GET /api/safety-overrides/export?…` — the filtered override list as CSV
 * (same filters as `GET /api/safety-overrides`, paging ignored, at most 5,000
 * rows), UTF-8 with a byte-order mark for Excel. Same visibility: the owner
 * exports everyone's, a doctor their own, other roles get 403. Audited as
 * `safety_override.export`.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    const scope = overrideScope(ctx);
    const query = OverrideListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    const result = await exportSafetyOverridesCsv(ctx.tenantId, scope, query, {
      userId: ctx.userId,
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
