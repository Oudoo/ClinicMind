import Link from "next/link";
import { ArrowLeft, OctagonAlert, TriangleAlert } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { parsePaging } from "@/lib/validation";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { SafetyOverrideFilters } from "@/components/clinicmind/consultation-safety-filters";
import { ruleLabel, SEVERITY_LABEL } from "@/modules/consultations/safety/labels";
import {
  listOverrideDoctors,
  listSafetyOverrides,
  OverrideListQuery,
  overrideScope,
} from "@/modules/consultations/safety/overrides";
import type { SafetyOverrideRow } from "@/modules/consultations/types";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const FILTER_KEYS = ["doctorId", "severity", "period", "from", "to"] as const;

/**
 * `/dashboard/safety` — prescribing-safety overrides for review: every stop a
 * clinician signed through, with the reason they typed, and every warning
 * they acknowledged. The clinic owner sees all clinicians; a doctor sees
 * their own. Filters (doctor, severity, period) live in the URL; CSV export
 * carries the same filters.
 */
export default async function SafetyOverridesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  if (!can(ctx.role, "reports:read") || (!can(ctx.role, "audit:read") && !ctx.userId)) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Safety overrides" description="Prescribing-safety stops signed through with a reason, and acknowledged warnings." />
        <Card>
          <EmptyState
            title="Safety overrides are not available for your role"
            hint="The clinic owner reviews every override; doctors see their own."
          />
        </Card>
      </div>
    );
  }

  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === "string" && value) flat[k] = value.slice(0, 64);
  }
  const parsed = OverrideListQuery.safeParse(flat);
  const query = parsed.success ? parsed.data : {};
  const params: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = query[key];
    if (value) params[key] = value;
  }
  const { page, pageSize } = parsePaging(new URLSearchParams(flat), { pageSize: 25, maxPageSize: 100 });
  const scope = overrideScope(ctx);
  const [result, doctors] = await Promise.all([
    listSafetyOverrides(ctx.tenantId, scope, query, { page, pageSize }),
    scope.kind === "all" ? listOverrideDoctors(ctx.tenantId) : Promise.resolve([]),
  ]);
  const { overrides, total, period, timezone, counts } = result;
  const when = (iso: string) => {
    const d = new Date(iso);
    return { date: formatDateInTz(d, timezone), time: formatTimeInTz(d, timezone) };
  };

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Safety overrides"
        description={
          scope.kind === "all"
            ? "Every prescribing-safety stop a clinician signed through, with their reason, and every warning they acknowledged."
            : "Your prescribing-safety overrides: stops you signed through with a reason, and warnings you acknowledged."
        }
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/consultations">
              <ArrowLeft className="h-4 w-4" />
              Consultations
            </Link>
          </Button>
        }
      />

      <Card className="space-y-4">
        <SafetyOverrideFilters params={params} doctors={doctors} preset={period.preset} fromKey={period.fromKey} toKey={period.toKey} />
        <div className="grid grid-cols-2 gap-3 border-t border-border pt-4 sm:max-w-md">
          <div className="space-y-1">
            <span className="data-label flex items-center gap-1.5">
              <OctagonAlert className="h-3.5 w-3.5 text-danger" aria-hidden="true" /> Stops overridden
            </span>
            <span className="metric-value text-danger">{counts.stop}</span>
          </div>
          <div className="space-y-1">
            <span className="data-label flex items-center gap-1.5">
              <TriangleAlert className="h-3.5 w-3.5 text-warning" aria-hidden="true" /> Warnings acknowledged
            </span>
            <span className="metric-value text-warning">{counts.warn}</span>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        {overrides.length ? (
          <>
            {/* Phones: one card per override, nothing wider than the screen. */}
            <ul className="divide-y divide-border md:hidden" aria-label="Safety overrides">
              {overrides.map((o) => {
                const at = when(o.createdAt);
                return (
                  <li key={o.id} className="space-y-1.5 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <SeverityBadge severity={o.severity} />
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {at.date} · {at.time}
                      </span>
                    </div>
                    <p className="break-words font-medium">
                      {o.medication ?? "—"} <span className="text-xs font-normal text-muted-foreground">· {ruleLabel(o.rule)}</span>
                    </p>
                    <p className="break-words text-xs text-muted-foreground">{o.message}</p>
                    <Reason reason={o.reason} severity={o.severity} />
                    <p className="text-xs text-muted-foreground">
                      <PatientLink row={o} /> · {o.doctor.fullName ?? "—"}
                    </p>
                  </li>
                );
              })}
            </ul>
            <div className="hidden md:block">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="px-3 sm:px-3">Date</TH>
                    <TH className="px-3 sm:px-3">Medication · finding</TH>
                    <TH className="px-3 sm:px-3">Patient</TH>
                    <TH className="hidden px-3 sm:px-3 lg:table-cell">Doctor</TH>
                    <TH className="px-3 sm:px-3">Reason</TH>
                  </TR>
                </THead>
                <TBody>
                  {overrides.map((o) => {
                    const at = when(o.createdAt);
                    return (
                      <TR key={o.id} className="align-top">
                        <TD className="whitespace-nowrap px-3 align-top font-mono text-xs tabular-nums text-muted-foreground sm:px-3">
                          {at.date}
                          <div>{at.time}</div>
                          <div className="mt-1.5">
                            <SeverityBadge severity={o.severity} />
                          </div>
                        </TD>
                        <TD className="max-w-[22rem] px-3 align-top sm:px-3">
                          <p className="break-words font-medium">{o.medication ?? "—"}</p>
                          <p className="text-xs text-accent">{ruleLabel(o.rule)}</p>
                          <p className="mt-1 break-words text-xs text-muted-foreground">{o.message}</p>
                        </TD>
                        <TD className="px-3 align-top text-sm sm:px-3">
                          <PatientLink row={o} />
                          <div className="text-xs text-muted-foreground lg:hidden">{o.doctor.fullName ?? "—"}</div>
                          {o.consultationId ? (
                            <Link href={`/dashboard/consultations?id=${o.consultationId}`} className="block text-xs text-muted-foreground underline-offset-2 hover:text-accent hover:underline">
                              Consultation
                            </Link>
                          ) : null}
                        </TD>
                        <TD className="hidden px-3 align-top text-sm sm:px-3 lg:table-cell">{o.doctor.fullName ?? "—"}</TD>
                        <TD className="max-w-[20rem] px-3 align-top sm:px-3">
                          <Reason reason={o.reason} severity={o.severity} />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            <Pagination page={page} pageSize={pageSize} total={total} basePath="/dashboard/safety" query={params} className="border-t border-border" />
          </>
        ) : (
          <div className="p-6">
            <EmptyState
              title="No safety overrides in this period"
              hint={
                scope.kind === "all"
                  ? "When a clinician signs a prescription despite a safety stop, it appears here with their reason."
                  : "When you sign a prescription despite a safety stop, it appears here with your reason."
              }
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: SafetyOverrideRow["severity"] }) {
  return <Badge tone={severity === "stop" ? "danger" : "warning"}>{SEVERITY_LABEL[severity]}</Badge>;
}

function Reason({ reason, severity }: { reason: string; severity: SafetyOverrideRow["severity"] }) {
  const acknowledgedOnly = severity === "warn" && reason === "acknowledged";
  return (
    <p className={cn("break-words text-sm", acknowledgedOnly ? "text-muted-foreground" : "font-medium")} dir="auto">
      {acknowledgedOnly ? "Acknowledged" : `“${reason}”`}
    </p>
  );
}

function PatientLink({ row }: { row: SafetyOverrideRow }) {
  return (
    <Link href={`/dashboard/patients/${row.patient.id}`} className="font-medium underline-offset-2 hover:text-accent hover:underline">
      {row.patient.fullName ?? "Patient"}
    </Link>
  );
}
