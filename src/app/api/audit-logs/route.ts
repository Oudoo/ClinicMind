import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getTenantTimezone } from "@/modules/appointments/service";
import { parseAuditQuery } from "@/modules/audit/query";
import { listAuditLogs } from "@/modules/audit/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/audit-logs?actor=&patient=&action=&from=&to=&q=&page=` — one page
 * (50 entries, newest first) of the clinic's audit log with the same filters
 * as the audit-log screen. Requires `audit:read` (the clinic owner).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "audit:read");

    const query = parseAuditQuery(new URL(req.url).searchParams);
    const timezone = await getTenantTimezone(ctx.tenantId);
    const result = await listAuditLogs(ctx.tenantId, query, timezone);
    return ok({
      entries: result.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
