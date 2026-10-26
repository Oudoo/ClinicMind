import Link from "next/link";
import { ArrowLeft, ArrowRight, CalendarPlus } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { dateKeyInTz, formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { ACTIVE_DAYS, getPatientPopulation, type Split } from "@/modules/reporting/population";
import { periodQuery, resolvePeriod } from "@/modules/reporting/period";
import { parseReportQuery } from "@/modules/reporting/query";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Columns, DeltaChip, HBars, Kpi } from "@/components/ui/kpi";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PeriodPicker } from "@/components/clinicmind/report-period-picker";
import { MetricBadge, NotForRole, fmtCount, fmtPct } from "@/components/clinicmind/report-shared";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/dashboard/reports/patients` — the patient data dashboard: who the
 * clinic's patients are (totals, activity, new registrations, gender, age,
 * city, language, source), what they come for, whether they come back (M10)
 * and who has nothing booked after their last signed procedure. The period
 * (90 days by default) drives the new-patient count, the top treatments, the
 * follow-up gap and the repeat cohort; the rest is the whole population.
 */
export default async function PatientDataPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "reports:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Patient data" />
        <NotForRole title="Not available for your role" hint="The patient data dashboard is for the clinic owner and the doctors." />
      </div>
    );
  }

  const timezone = await getTenantTimezone(ctx.tenantId);
  const query = parseReportQuery(sp);
  const preset = query.period ?? (query.from && query.to ? "custom" : undefined);
  const period = resolvePeriod({ period: preset ?? "90d", from: query.from, to: query.to }, timezone, new Date(), "90d");
  const pop = await getPatientPopulation(ctx.tenantId, period, timezone);
  const previous = { fromKey: dateKeyInTz(period.previous.from, timezone), toKey: dateKeyInTz(new Date(period.previous.to.getTime() - 1), timezone) };
  const date = (d: Date) => formatDateInTz(d, timezone);
  const share = (n: number) => (pop.total ? ` · ${fmtPct(n / pop.total)}` : "");
  const reportsQuery = new URLSearchParams({ ...periodQuery(period), tab: "patients" }).toString();

  return (
    <div className="space-y-6">
      <Link href="/dashboard/reports" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Reports
      </Link>
      <SectionTitle title="Patient data" description="Who the clinic's patients are, what they come for, and who needs a follow-up booked." />
      <PeriodPicker basePath="/dashboard/reports/patients" preset={period.preset} fromKey={period.fromKey} toKey={period.toKey} previous={previous} />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Patients" value={fmtCount(pop.total)} tone="accent" hint="registered, not archived" />
        <Kpi label="Active" value={fmtCount(pop.active)} hint={`a visit in the last ${ACTIVE_DAYS} days${share(pop.active)}`} />
        <Kpi
          label="New in the period"
          value={fmtCount(pop.newInPeriod)}
          delta={<DeltaChip current={pop.newInPeriod} previous={pop.newInPrevious} goodWhen="up" />}
          hint={`previous ${fmtCount(pop.newInPrevious)}`}
        />
        <Kpi label="Visits per patient" value={pop.averageVisits === null ? "—" : (Math.round(pop.averageVisits * 10) / 10).toFixed(1)} hint={`${formatNumber(pop.visits)} signed visits in all`} />
        <Kpi
          label="M10 · Repeat-patient rate"
          value={fmtPct(pop.repeat.rate)}
          hint={
            <Link href={`/dashboard/reports?${reportsQuery}`} className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
              {pop.repeat.returned} of {pop.repeat.cohort} came back <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          }
        />
        <Kpi label="No follow-up booked" value={fmtCount(pop.followUpGaps.count)} tone={pop.followUpGaps.count ? "warning" : "default"} hint="after their last signed procedure" />
      </div>

      <Card className="min-w-0 space-y-3">
        <SectionTitle title="New patients per month" description="Registrations over the last twelve months (clinic clock)." />
        {pop.newPerMonth.some((m) => m.count) ? <Columns items={pop.newPerMonth.map((m) => ({ label: m.label, value: m.count }))} height="h-36" /> : <EmptyState title="No registrations in the last twelve months" />}
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <SplitCard title="Gender" items={pop.gender} total={pop.total} />
        <SplitCard title="Age" items={pop.ageBands.filter((a) => a.count > 0 || a.key !== "unknown")} total={pop.total} />
        <SplitCard title="Top cities" description="From the city, else the first part of the address." items={pop.cities} total={pop.total} />
        <SplitCard title="Language" items={pop.languages} total={pop.total} />
        <SplitCard title="Source" description="First-touch source of patients who came through the CRM." items={pop.sources} total={pop.total} />
        <Card className="min-w-0 space-y-3">
          <SectionTitle title="Top treatments" description="Patients with a signed procedure in the period." />
          {pop.topTreatments.length ? (
            <div className="-mx-6 overflow-hidden">
              <Table className="relative text-[13px]">
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="py-2">Treatment</TH>
                    <TH className="py-2 text-right">Patients</TH>
                    <TH className="py-2 text-right">Procedures</TH>
                  </TR>
                </THead>
                <TBody>
                  {pop.topTreatments.map((t) => (
                    <TR key={t.key}>
                      <TD className="py-2 font-medium">{t.label}</TD>
                      <TD className="py-2 text-right font-mono tabular-nums">{t.count}</TD>
                      <TD className="py-2 text-right font-mono tabular-nums">{t.procedures}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="No signed procedures in this period" />
          )}
        </Card>
      </div>

      <Card className="min-w-0 overflow-hidden p-0">
        <div className="space-y-1 px-4 py-4 sm:px-6">
          <SectionTitle
            title="No follow-up booked"
            description="Patients whose last signed procedure falls in the period and who have nothing booked on a later day. Oldest first."
            action={<Badge tone={pop.followUpGaps.count ? "warning" : "success"}>{pop.followUpGaps.count}</Badge>}
          />
        </div>
        {pop.followUpGaps.items.length ? (
          <Table className="relative">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Patient</TH>
                <TH className="hidden md:table-cell">Last procedure</TH>
                <TH className="text-right">Days since</TH>
                <TH className="hidden lg:table-cell">Doctor</TH>
                <TH className="w-10">
                  <span className="sr-only">Book</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {pop.followUpGaps.items.map((g) => (
                <TR key={g.patientId}>
                  <TD>
                    <Link href={`/dashboard/patients/${g.patientId}`} className="font-medium underline-offset-2 hover:text-accent hover:underline">
                      {g.fullName}
                    </Link>
                    <div className="text-xs text-muted-foreground md:hidden">
                      {g.treatment} · {date(g.performedAt)}
                    </div>
                  </TD>
                  <TD className="hidden text-sm md:table-cell">
                    {g.treatment} · <span className="font-mono text-xs">{date(g.performedAt)}</span>
                  </TD>
                  <TD className="text-right font-mono tabular-nums">{g.daysSince}</TD>
                  <TD className="hidden text-sm text-muted-foreground lg:table-cell">{g.doctor ?? "—"}</TD>
                  <TD>
                    <Link href={`/dashboard/patients/${g.patientId}`} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted" aria-label={`Book a follow-up for ${g.fullName}`} title="Open the patient to book a follow-up">
                      <CalendarPlus className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="px-4 pb-6 sm:px-6">
            <EmptyState title="Everyone has a follow-up booked" hint="Patients appear here when their last procedure has nothing booked after it." />
          </div>
        )}
        {pop.followUpGaps.count > pop.followUpGaps.items.length ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground sm:px-6">
            The {pop.followUpGaps.items.length} oldest of {pop.followUpGaps.count}.
          </p>
        ) : null}
      </Card>

      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <MetricBadge id="M10" /> The repeat-patient rate uses the cohort whose first paid visit fell in this period twelve months ago; see Reports → Patients &amp; satisfaction for the breakdown by first treatment.
      </p>
    </div>
  );
}

function SplitCard({ title, description, items, total }: { title: string; description?: string; items: Split[]; total: number }) {
  const shown = items.filter((i) => i.count > 0);
  return (
    <Card className="min-w-0 space-y-3">
      <SectionTitle title={title} description={description} />
      {shown.length ? (
        <HBars items={shown.map((i) => ({ label: `${i.label} · ${total ? Math.round((i.count / total) * 100) : 0}%`, value: i.count }))} labelWidth="w-32 sm:w-40" />
      ) : (
        <EmptyState title="No data" />
      )}
    </Card>
  );
}
