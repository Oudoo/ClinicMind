import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { handleApiError, unauthorized } from "@/lib/api";
import { clientIp } from "@/lib/auth/request";
import { csvResponse, csvRowCount } from "@/modules/reporting/csv";
import { isMetricId } from "@/modules/reporting/definitions";
import { metricCsv } from "@/modules/reporting/export";
import { parseReportQuery } from "@/modules/reporting/query";
import { getReport } from "@/modules/reporting/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/reports/export?metric=M4&part=doctor&period…` → CSV of that table
 * (`reports:read`; M4 needs `finance:read`). Audited as `report.export`.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "reports:read");
    const params = new URL(req.url).searchParams;
    const metric = params.get("metric");
    if (!isMetricId(metric)) {
      return NextResponse.json({ error: "validation_error", issues: { fieldErrors: { metric: ["Unknown metric"] } } }, { status: 422 });
    }
    if (metric === "M4") assertCan(ctx.role, "finance:read");
    const part = params.get("part")?.slice(0, 40) || undefined;
    const query = parseReportQuery(Object.fromEntries(params));
    const report = await getReport(ctx.tenantId, query, { canSeeRevenue: can(ctx.role, "finance:read") });
    const out = metricCsv(report, metric, part);
    if (!out) return NextResponse.json({ error: "not_found", entity: "table" }, { status: 404 });
    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      ip: clientIp(req),
      action: "report.export",
      entity: "Report",
      entityId: metric,
      patientId: null,
      after: { metric, part: part ?? null, query: { ...query }, rows: csvRowCount(out.csv) },
    });
    return csvResponse(out.filename, out.csv);
  } catch (err) {
    return handleApiError(err);
  }
}
