import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp } from "@/lib/auth/request";
import { handleApiError, unauthorized } from "@/lib/api";
import { getTenantTimezone } from "@/modules/appointments/service";
import { parseAuditQuery } from "@/modules/audit/query";
import { exportAuditCsv } from "@/modules/audit/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/audit-logs/export?…` — the filtered audit log as CSV (same query
 * parameters as `GET /api/audit-logs`, paging ignored, at most 100,000 rows),
 * streamed in batches. UTF-8 with a byte-order mark so Excel renders Arabic;
 * the export is itself audited as `audit.export`. Requires `audit:read`.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "audit:read");

    const query = parseAuditQuery(new URL(req.url).searchParams);
    const timezone = await getTenantTimezone(ctx.tenantId);
    const result = await exportAuditCsv(ctx.tenantId, query, timezone, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return new Response(result.stream, {
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
