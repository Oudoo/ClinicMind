import { audit } from "@/lib/audit";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { financeReport, financeReportCsv, isFinanceReport, reportScope } from "@/modules/finance/reports";
import { csvResponse, csvRowCount } from "@/modules/reporting/csv";

export const dynamic = "force-dynamic";

/**
 * `GET /api/finance/reports/[report]?period=28d|…&from=&to=&clinicId=&status=&doctorId=&type=[&format=csv]`
 * — one of the owner's financial reports (`finance:read`): `income`, `production`, `branches`,
 * `adjustments`, `balances`, `procedures` or `providers`. JSON, or CSV (audited as
 * `finance.report.export` with the period and the row count).
 */
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  try {
    const { report } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "finance:read");
    if (!isFinanceReport(report)) return notFound("report");
    const query = Object.fromEntries(new URL(req.url).searchParams);
    const scope = await reportScope(ctx.tenantId, query);
    if (query.format !== "csv") return ok(await financeReport(scope, report));
    const { filename, csv } = await financeReportCsv(scope, report);
    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      ip: clientIp(req),
      action: "finance.report.export",
      entity: "Finance",
      entityId: report,
      patientId: null,
      after: { report, from: scope.period.fromKey, to: scope.period.toKey, clinicId: scope.clinicId, rows: csvRowCount(csv) },
    });
    return csvResponse(filename, csv);
  } catch (err) {
    return handleApiError(err);
  }
}
