import { z } from "zod";
import { audit } from "@/lib/audit";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, unauthorized } from "@/lib/api";
import { clientIp } from "@/lib/auth/request";
import { getTenantTimezone } from "@/modules/appointments/service";
import { exportFinanceCsv } from "@/modules/finance/service";
import { csvResponse, csvRowCount } from "@/modules/reporting/csv";
import { periodFromSearchParams } from "@/modules/reporting/query";

export const dynamic = "force-dynamic";

const Query = z.object({ kind: z.enum(["payments", "procedures"]) });

/**
 * `GET /api/finance/export?kind=payments|procedures&from=YYYY-MM-DD&to=YYYY-MM-DD` → CSV
 * (`finance:read`). Audited as `finance.export` with the period and row count.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "finance:read");
    const params = new URL(req.url).searchParams;
    const { kind } = Query.parse(Object.fromEntries(params));
    const timeZone = await getTenantTimezone(ctx.tenantId);
    const period = periodFromSearchParams(params, timeZone);
    const { filename, csv } = await exportFinanceCsv(ctx.tenantId, kind, period, timeZone);
    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      ip: clientIp(req),
      action: "finance.export",
      entity: "Finance",
      entityId: kind,
      patientId: null,
      after: { kind, from: period.from.toISOString(), to: period.to.toISOString(), rows: csvRowCount(csv) },
    });
    return csvResponse(filename, csv);
  } catch (err) {
    return handleApiError(err);
  }
}
