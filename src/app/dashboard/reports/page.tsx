import Link from "next/link";
import { ArrowRight, Users } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { dateKeyInTz, formatDateInTz, startOfWeekInTz } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { buildWeeklyBrief, getBriefState } from "@/modules/reporting/brief";
import { METRIC_DEFINITIONS, type MetricId } from "@/modules/reporting/definitions";
import { listAlertRules } from "@/modules/reporting/alerts";
import type { PeriodPreset } from "@/modules/reporting/period";
import { LEAD_SOURCES, SOURCE_LABELS, parseReportQuery, queryEntries, toSearch, type ReportQuery } from "@/modules/reporting/query";
import { getReport, listReportDoctors, type Report } from "@/modules/reporting/service";
import { reportTables, type TableSpec } from "@/modules/reporting/tables";
import { listTargets, targetRows, type TargetView } from "@/modules/reporting/targets";
import { listTreatments } from "@/modules/treatments/service";
import { Card, SectionTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Columns, DeltaChip, HBars, Kpi } from "@/components/ui/kpi";
import { ReportAlertRules } from "@/components/clinicmind/report-alert-rules";
import { ReportBriefCard } from "@/components/clinicmind/report-brief-card";
import { ReportFilters } from "@/components/clinicmind/report-filters";
import { PeriodPicker } from "@/components/clinicmind/report-period-picker";
import { ReportReviewsCard } from "@/components/clinicmind/report-reviews-card";
import { ReportTable } from "@/components/clinicmind/report-table";
import { ReportTargets } from "@/components/clinicmind/report-targets";
import { CsvLink, MetricBadge, MetricBlock, NotForRole, OwnerOnly, Stat, fmtCount, fmtEgp, fmtPct, fmtScore, fmtSeconds, fmtUnit } from "@/components/clinicmind/report-shared";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "funnel", label: "Funnel & marketing" },
  { key: "doctors", label: "Doctors" },
  { key: "revenue", label: "Revenue" },
  { key: "patients", label: "Patients & satisfaction" },
  { key: "response", label: "Response & follow-ups" },
  { key: "targets", label: "Targets" },
  { key: "definitions", label: "Definitions" },
  { key: "alerts", label: "Alerts" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/** Which filters each metric honours (shown on the Definitions tab). */
const FILTERS: Record<MetricId, string> = {
  M1: "treatment (interest), source",
  M2: "source",
  M3: "doctor, treatment",
  M4: "doctor, treatment",
  M5: "none",
  M6: "doctor, source",
  M7: "source",
  M8: "source",
  M9: "source",
  M10: "treatment (first treatment)",
  M11: "treatment",
  M12: "none (as of now)",
  M13: "source, treatment",
};

interface Ctx {
  report: Report;
  tables: Map<string, TableSpec>;
  query: ReportQuery;
  timezone: string;
  userId: string | null;
  targets: Map<string, TargetView>;
}

/**
 * `/dashboard/reports` — the thirteen metrics (M1–M13) for a period against
 * the period before, with filters (doctor, treatment, lead source) and the tab
 * in the URL. Every metric block names its id and every table has a CSV
 * export of exactly its rows. Revenue figures need finance:read ("owner
 * only" otherwise). Targets and alert rules are edited by the owner.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "reports:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Reports" />
        <NotForRole title="Not available for your role" hint="Reports are for the clinic owner and the doctors." />
      </div>
    );
  }

  const timezone = await getTenantTimezone(ctx.tenantId);
  const query = parseReportQuery(sp);
  const tab: TabKey = TABS.some((t) => t.key === query.tab) ? (query.tab as TabKey) : "overview";
  const canSeeRevenue = can(ctx.role, "finance:read");
  const canManage = can(ctx.role, "tenant:manage");
  const now = new Date();

  const [report, doctors, treatments, targetList, rules, brief, briefState] = await Promise.all([
    getReport(ctx.tenantId, query, { now, canSeeRevenue }),
    listReportDoctors(ctx.tenantId),
    listTreatments(ctx.tenantId, { includeInactive: true }),
    listTargets(ctx.tenantId),
    tab === "alerts" ? listAlertRules(ctx.tenantId, { canSeeRevenue }) : Promise.resolve([]),
    tab === "overview" ? buildWeeklyBrief(ctx.tenantId, now, { canSeeRevenue }) : Promise.resolve(null),
    tab === "overview" ? getBriefState(ctx.tenantId) : Promise.resolve(null),
  ]);
  const tables = new Map(reportTables(report).map((t) => [t.id, t]));
  const targets = new Map(targetRows(targetList, report).map((t) => [t.metric, t]));
  const c: Ctx = { report, tables, query, timezone, userId: ctx.userId, targets };

  const params = queryEntries(query, { tab: tab === "overview" ? undefined : tab });
  const tabHref = (key: TabKey) => `/dashboard/reports${toSearch(queryEntries(query, { tab: key === "overview" ? undefined : key }))}`;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Reports"
        description="The thirteen clinic metrics for the period, against the period before."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/reports/patients">
              <Users className="h-4 w-4" aria-hidden="true" />
              Patient data
            </Link>
          </Button>
        }
      />

      <Card className="space-y-4 p-4 sm:p-5">
        <PeriodPicker
          basePath="/dashboard/reports"
          preset={report.period.preset as PeriodPreset}
          fromKey={report.period.fromKey}
          toKey={report.period.toKey}
          previous={{ fromKey: report.previous.fromKey, toKey: report.previous.toKey }}
          keep={Object.fromEntries(Object.entries(params).filter(([k]) => k !== "period" && k !== "from" && k !== "to"))}
        />
        <ReportFilters
          basePath="/dashboard/reports"
          params={params}
          doctors={doctors.map((d) => ({ value: d.id, label: d.fullName }))}
          treatments={treatments.map((t) => ({ value: t.key, label: t.name }))}
          sources={LEAD_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))}
        />
        {report.redacted ? <p className="text-xs text-muted-foreground">Revenue and campaign cost figures are owner only.</p> : null}
      </Card>

      <nav aria-label="Report sections" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex w-max gap-1 rounded-lg bg-muted p-1 sm:w-auto sm:flex-wrap">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={tabHref(t.key)}
                scroll={false}
                aria-current={t.key === tab ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors",
                  t.key === tab ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "overview" ? <Overview c={c} brief={brief} sentAt={briefState?.sentAt ?? null} /> : null}
      {tab === "funnel" ? <Funnel c={c} /> : null}
      {tab === "doctors" ? <Doctors c={c} isDoctor={ctx.role === "DOCTOR"} /> : null}
      {tab === "revenue" ? <Revenue c={c} /> : null}
      {tab === "patients" ? <Patients c={c} canEnterReviews={canManage} /> : null}
      {tab === "response" ? <Response c={c} /> : null}
      {tab === "targets" ? (
        <MetricBlockPlain title="Targets" description="The clinic's success metrics: baseline, target and due date, next to the value for this period.">
          <ReportTargets
            rows={[...targets.values()].map((t) => ({ ...t, dueAt: t.dueAt ? t.dueAt.toISOString().slice(0, 10) : null }))}
            canEdit={canManage}
            redacted={report.redacted}
            periodLabel={`${report.period.fromKey} → ${report.period.toKey}`}
          />
        </MetricBlockPlain>
      ) : null}
      {tab === "definitions" ? <Definitions /> : null}
      {tab === "alerts" ? (
        <MetricBlockPlain title="Alert rules" description="Thresholds on the metrics, checked every hour; a rule that is over the line notifies the roles it names, at most once a day.">
          <ReportAlertRules
            rules={rules.map((r) => ({
              id: r.id,
              name: r.name,
              metric: r.metric,
              comparator: r.comparator,
              threshold: r.threshold,
              windowDays: r.windowDays,
              notifyRoles: r.notifyRoles,
              enabled: r.enabled,
              lastValue: r.lastValue,
              lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null,
              lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
            }))}
            canEdit={canManage}
            timezone={timezone}
          />
        </MetricBlockPlain>
      ) : null}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function exportHref(c: Ctx, table: TableSpec): string {
  return `/api/reports/export${toSearch({ ...queryEntries(c.query, { tab: undefined }), metric: table.metric, part: table.part })}`;
}

function T({ c, id, highlight, limit, empty }: { c: Ctx; id: string; highlight?: boolean; limit?: number; empty?: string }) {
  const table = c.tables.get(id);
  if (!table) return null;
  return <ReportTable table={table} exportHref={exportHref(c, table)} timezone={c.timezone} highlightKey={highlight ? c.userId : null} limit={limit} emptyText={empty} />;
}

function targetChip(t: TargetView | undefined): { ok: boolean; text: string } | undefined {
  if (!t || t.target === null || t.onTrack === null) return undefined;
  return { ok: t.onTrack, text: `target ${t.goodWhen === "up" ? "≥" : "≤"} ${fmtUnit(t.unit, t.target)}` };
}

function MetricBlockPlain({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="min-w-0 space-y-4 p-4 sm:p-6">
      <SectionTitle title={title} description={description} />
      {children}
    </Card>
  );
}

/** "1 lead", "3 leads". */
const plural = (n: number, one: string, many: string) => `${fmtCount(n)} ${n === 1 ? one : many}`;

/** Rates (formatted with fmtPct) move in percentage points, counts and money relatively. */
const Delta = ({ cur, prev, good, fmt }: { cur: number | null; prev: number | null; good: "up" | "down"; fmt: (v: number) => string }) =>
  cur === null ? null : <DeltaChip current={cur} previous={prev} goodWhen={good} format={fmt} mode={fmt === fmtPct ? "points" : "relative"} />;

// ── Tabs ─────────────────────────────────────────────────────────────────────

function Overview({ c, brief, sentAt }: { c: Ctx; brief: Awaited<ReturnType<typeof buildWeeklyBrief>> | null; sentAt: string | null }) {
  const { m1, m2, m3, m5, m6, m12, m13 } = c.report;
  const cpp = (f: typeof m13.current) => (f.totals.procedures ? Math.round(f.totals.cost / f.totals.procedures) : null);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi
          label="M1 · New enquiries"
          value={fmtCount(m1.current.leads)}
          tone="accent"
          delta={<Delta cur={m1.current.leads} prev={m1.previous.leads} good="up" fmt={fmtCount} />}
          hint={m1.current.multiInterest ? `${m1.current.multiInterest} asked about two or more treatments` : "new leads in the period"}
          target={targetChip(c.targets.get("M1"))}
        />
        <Kpi
          label="M2 · Lead → consultation"
          value={fmtPct(m2.current.rate)}
          delta={<Delta cur={m2.current.rate} prev={m2.previous.rate} good="up" fmt={fmtPct} />}
          hint={`${m2.current.converted} of ${plural(m2.current.leads, "lead", "leads")} within 30 days`}
          target={targetChip(c.targets.get("M2"))}
        />
        <Kpi
          label="M3 · Consultation → procedure"
          value={fmtPct(m3.current.rate)}
          delta={<Delta cur={m3.current.rate} prev={m3.previous.rate} good="up" fmt={fmtPct} />}
          hint={`${m3.current.converted} of ${plural(m3.current.consultations, "consultation", "consultations")} within 60 days`}
          target={targetChip(c.targets.get("M3"))}
        />
        <Kpi
          label="M5 · First response (median)"
          value={fmtSeconds(m5.current.p50)}
          delta={<Delta cur={m5.current.p50} prev={m5.previous.p50} good="down" fmt={fmtSeconds} />}
          hint={`AI ${fmtSeconds(m5.current.ai.p50)} · human ${fmtSeconds(m5.current.human.p50)} · 90th ${fmtSeconds(m5.current.p90)}`}
          target={targetChip(c.targets.get("M5"))}
        />
        <Kpi
          label="M6 · No-show rate"
          value={fmtPct(m6.current.rate)}
          tone={m6.current.rate !== null && m6.current.rate > 0.1 ? "warning" : "default"}
          delta={<Delta cur={m6.current.rate} prev={m6.previous.rate} good="down" fmt={fmtPct} />}
          hint={`${m6.current.noShows} of ${m6.current.booked} booked`}
          target={targetChip(c.targets.get("M6"))}
        />
        <Kpi
          label="M12 · Overdue now"
          value={fmtCount(m12.followUps + m12.escalations)}
          tone={m12.followUps + m12.escalations > 0 ? "warning" : "default"}
          hint={`${plural(m12.followUps, "follow-up", "follow-ups")} · ${plural(m12.escalations, "escalation", "escalations")}`}
          target={targetChip(c.targets.get("M12"))}
        />
        {c.report.redacted ? (
          <Kpi
            label="M13 · Procedures from campaigns"
            value={fmtCount(m13.current.totals.procedures)}
            delta={<Delta cur={m13.current.totals.procedures} prev={m13.previous.totals.procedures} good="up" fmt={fmtCount} />}
            hint={`from ${plural(m13.current.totals.leads, "campaign lead", "campaign leads")} · cost owner only`}
          />
        ) : (
          <Kpi
            label="M13 · Cost per procedure (ads)"
            value={fmtEgp(cpp(m13.current))}
            delta={<Delta cur={cpp(m13.current)} prev={cpp(m13.previous)} good="down" fmt={fmtEgp} />}
            hint={`${plural(m13.current.totals.procedures, "procedure", "procedures")} from ${plural(m13.current.totals.leads, "campaign lead", "campaign leads")} · ${fmtEgp(m13.current.totals.cost)} spent`}
            target={targetChip(c.targets.get("M13"))}
          />
        )}
        <Card className="flex min-w-0 flex-col justify-between gap-2 p-4 sm:p-5">
          <span className="data-label">More</span>
          <ul className="space-y-1 text-sm">
            <li>
              <Link href={`/dashboard/reports${toSearch(queryEntries(c.query, { tab: "funnel" }))}`} className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
                Funnel & marketing <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </li>
            <li>
              <Link href={`/dashboard/reports${toSearch(queryEntries(c.query, { tab: "response" }))}`} className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
                Response & follow-ups <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </li>
            <li>
              <Link href="/dashboard/reports/patients" className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
                Patient data <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </li>
          </ul>
        </Card>
      </div>
      {brief ? <ReportBriefCard brief={brief} sentAt={sentAt} timezone={c.timezone} /> : null}
    </div>
  );
}

function Funnel({ c }: { c: Ctx }) {
  const { m1, m2, m3, m7, m8, m9, m13 } = c.report;
  return (
    <div className="space-y-4">
      <MetricBlock id="M1" title="Enquiries by treatment" description="New leads in the period by the treatment they asked about; a lead with two interests counts once per interest.">
        <div className="flex flex-wrap gap-6">
          <Stat label="New leads" value={<span className="inline-flex items-center gap-2">{fmtCount(m1.current.leads)} <Delta cur={m1.current.leads} prev={m1.previous.leads} good="up" fmt={fmtCount} /></span>} hint={`previous ${fmtCount(m1.previous.leads)}`} />
          <Stat label="Two or more interests" value={fmtCount(m1.current.multiInterest)} hint="counted once per interest below" />
        </div>
        {m1.current.items.length ? <HBars items={m1.current.items.map((i) => ({ label: i.label, value: i.count }))} labelWidth="w-28 sm:w-48" /> : null}
        <T c={c} id="M1.treatment" />
      </MetricBlock>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <MetricBlock id="M2" title="Lead to consultation" description="Leads created in the period with an attended consultation within 30 days.">
          <Stat label="Converted" value={<span className="inline-flex items-center gap-2">{fmtPct(m2.current.rate)} <Delta cur={m2.current.rate} prev={m2.previous.rate} good="up" fmt={fmtPct} /></span>} hint={`${m2.current.converted} of ${m2.current.leads} leads · previous ${fmtPct(m2.previous.rate)}`} />
          <T c={c} id="M2.source" />
        </MetricBlock>
        <MetricBlock id="M3" title="Consultation to procedure" description="Attended consultations followed by a signed procedure within 60 days.">
          <Stat label="Converted" value={<span className="inline-flex items-center gap-2">{fmtPct(m3.current.rate)} <Delta cur={m3.current.rate} prev={m3.previous.rate} good="up" fmt={fmtPct} /></span>} hint={`${m3.current.converted} of ${m3.current.consultations} consultations · previous ${fmtPct(m3.previous.rate)}`} />
          <T c={c} id="M3.doctor" highlight />
          <T c={c} id="M3.treatment" />
          <T c={c} id="M3.procedure" />
        </MetricBlock>
      </div>

      <MetricBlock id="M9" title="Hair-transplant enquiries by source" description="Leads with the hair-transplant interest, by first-touch source and by campaign.">
        <Stat label="Hair-transplant enquiries" value={<span className="inline-flex items-center gap-2">{fmtCount(m9.current.leads)} <Delta cur={m9.current.leads} prev={m9.previous.leads} good="up" fmt={fmtCount} /></span>} hint={`previous ${fmtCount(m9.previous.leads)}`} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <T c={c} id="M9.source" />
          <T c={c} id="M9.campaign" />
        </div>
      </MetricBlock>

      <MetricBlock id="M13" title="Campaign to procedure" description="Per campaign: leads, consultations, procedures within 60 days, revenue, cost from the ads platform and cost per procedure.">
        <div className="flex flex-wrap gap-6">
          <Stat label="Campaign leads" value={fmtCount(m13.current.totals.leads)} hint={`previous ${fmtCount(m13.previous.totals.leads)}`} />
          <Stat label="Consultations" value={fmtCount(m13.current.totals.consultations)} />
          <Stat label="Procedures" value={fmtCount(m13.current.totals.procedures)} hint={`previous ${fmtCount(m13.previous.totals.procedures)}`} />
          {c.report.redacted ? null : (
            <>
              <Stat label="Revenue" value={fmtEgp(m13.current.totals.revenue)} />
              <Stat label="Cost" value={fmtEgp(m13.current.totals.cost)} hint={m13.current.totals.procedures ? `${fmtEgp(Math.round(m13.current.totals.cost / m13.current.totals.procedures))} per procedure` : "no procedures yet"} />
            </>
          )}
        </div>
        <T c={c} id="M13.campaign" empty="No campaign leads or spend in this period." />
      </MetricBlock>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <MetricBlock id="M7" title="Lost leads and reasons" description="Leads marked lost in the period, by reason and by the stage they were lost at.">
          <Stat label="Lost" value={<span className="inline-flex items-center gap-2">{fmtCount(m7.current.lost)} <Delta cur={m7.current.lost} prev={m7.previous.lost} good="down" fmt={fmtCount} /></span>} hint={`previous ${fmtCount(m7.previous.lost)}`} />
          <T c={c} id="M7.reason" />
          <T c={c} id="M7.stage" />
        </MetricBlock>
        <MetricBlock id="M8" title="Objections" description="Set by the AI on conversations, next to those staff confirmed on closed leads.">
          <T c={c} id="M8.objections" />
          {m8.current.conversations + m8.current.closedLeads === 0 ? <p className="text-xs text-muted-foreground">No conversations or closed leads in this period.</p> : null}
        </MetricBlock>
      </div>
    </div>
  );
}

function Doctors({ c, isDoctor }: { c: Ctx; isDoctor: boolean }) {
  const { m3, m4, m6 } = c.report;
  const mine = c.userId ? { m3: m3.current.byDoctor.find((d) => d.key === c.userId), m6: m6.current.byDoctor.find((d) => d.key === c.userId), m4: m4?.current.byDoctor.find((d) => d.key === c.userId) } : null;
  return (
    <div className="space-y-4">
      {isDoctor && mine ? (
        <Card className="space-y-2 border-accent/40 p-4 sm:p-5">
          <p className="data-label">Your numbers in this period</p>
          <div className="flex flex-wrap gap-6">
            <Stat label="M3 · Consultation → procedure" value={fmtPct(mine.m3?.rate ?? null)} hint={mine.m3 ? `${mine.m3.converted} of ${mine.m3.total}` : "no consultations"} />
            <Stat label="M6 · No-show rate" value={fmtPct(mine.m6?.rate ?? null)} hint={mine.m6 ? `${mine.m6.converted} of ${mine.m6.total} booked` : "no bookings"} />
          </div>
          <p className="text-xs text-muted-foreground">Your row is highlighted in each table.</p>
        </Card>
      ) : null}
      <MetricBlock id="M3" title="Consultation to procedure, by doctor" description="The consulting doctor's attended consultations followed by a signed procedure within 60 days.">
        <T c={c} id="M3.doctor" highlight />
      </MetricBlock>
      <MetricBlock id="M4" title="Revenue by doctor" description="Signed procedures by the date performed, net of discount.">
        {m4 ? (
          <>
            {m4.current.byDoctor.length ? <HBars items={m4.current.byDoctor.map((d) => ({ label: d.label, value: d.revenue }))} format={(v) => (v >= 10_000 ? `${Math.round(v / 1000)}k` : formatNumber(v))} labelWidth="w-28 sm:w-48" /> : null}
            <T c={c} id="M4.doctor" highlight />
            <T c={c} id="M4.matrix" highlight />
          </>
        ) : (
          <OwnerOnly />
        )}
      </MetricBlock>
      <MetricBlock id="M6" title="No-show rate, by doctor" description="No-shows divided by booked past appointments.">
        <T c={c} id="M6.doctor" highlight />
      </MetricBlock>
    </div>
  );
}

function Revenue({ c }: { c: Ctx }) {
  const m4 = c.report.m4;
  if (!m4) {
    return (
      <MetricBlock id="M4" title="Revenue by doctor and treatment">
        <OwnerOnly />
      </MetricBlock>
    );
  }
  const cur = m4.current;
  const prev = m4.previous;
  const short = (v: number) => (v >= 10_000 ? `${Math.round(v / 1000)}k` : formatNumber(v));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <Kpi label="M4 · Revenue · EGP" value={formatNumber(cur.revenue)} tone="accent" delta={<Delta cur={cur.revenue} prev={prev.revenue} good="up" fmt={fmtEgp} />} hint={`${cur.procedures} signed procedures`} target={targetChip(c.targets.get("M4"))} />
        <Kpi label="Procedures" value={formatNumber(cur.procedures)} delta={<Delta cur={cur.procedures} prev={prev.procedures} good="up" fmt={fmtCount} />} />
        <Kpi label="Deposits · EGP" value={formatNumber(cur.deposits)} delta={<Delta cur={cur.deposits} prev={prev.deposits} good="up" fmt={fmtEgp} />} hint="by the date paid" />
        <Kpi label="Refunds · EGP" value={formatNumber(cur.refunds)} tone={cur.refunds ? "warning" : "default"} delta={<Delta cur={cur.refunds} prev={prev.refunds} good="down" fmt={fmtEgp} />} hint="by the date paid" />
        <Kpi label="Consultation fees · EGP" value={formatNumber(cur.consultationFees)} delta={<Delta cur={cur.consultationFees} prev={prev.consultationFees} good="up" fmt={fmtEgp} />} hint="their own line" />
      </div>
      <MetricBlock id="M4" title="Revenue by doctor and treatment" description="Signed procedures by the date performed (price minus discount). Deposits and refunds by the date paid; consultation fees their own line.">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="data-label">By doctor</p>
            {cur.byDoctor.length ? <HBars items={cur.byDoctor.map((d) => ({ label: d.label, value: d.revenue }))} format={short} labelWidth="w-28 sm:w-44" /> : <p className="text-sm text-muted-foreground">No signed procedures.</p>}
          </div>
          <div className="space-y-2">
            <p className="data-label">By treatment</p>
            {cur.byTreatment.length ? <HBars items={cur.byTreatment.map((d) => ({ label: d.label, value: d.revenue }))} format={short} labelWidth="w-28 sm:w-44" /> : <p className="text-sm text-muted-foreground">No signed procedures.</p>}
          </div>
        </div>
        <T c={c} id="M4.lines" />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <T c={c} id="M4.doctor" highlight />
          <T c={c} id="M4.treatment" />
        </div>
        <T c={c} id="M4.matrix" highlight />
      </MetricBlock>
    </div>
  );
}

function Patients({ c, canEnterReviews }: { c: Ctx; canEnterReviews: boolean }) {
  const { m10, m11 } = c.report;
  const thisWeek = dateKeyInTz(startOfWeekInTz(new Date(), c.timezone), c.timezone);
  const cohortTo = new Date(m10.current.cohortTo.getTime() - 1);
  return (
    <div className="space-y-4">
      <MetricBlock
        id="M10"
        title="Repeat-patient rate"
        description="Patients whose first paid visit fell in the cohort window, and the share back for a second paid visit within 12 months."
        action={
          <Link href="/dashboard/reports/patients" className="inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline">
            Patient data <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        }
      >
        <div className="flex flex-wrap gap-6">
          <Stat label="Came back" value={<span className="inline-flex items-center gap-2">{fmtPct(m10.current.rate)} <Delta cur={m10.current.rate} prev={m10.previous.rate} good="up" fmt={fmtPct} /></span>} hint={`${m10.current.returned} of ${m10.current.cohort} patients · previous ${fmtPct(m10.previous.rate)}`} />
          <Stat label="Cohort window" value={<span className="font-mono text-sm">{formatDateInTz(m10.current.cohortFrom, c.timezone)} → {formatDateInTz(cohortTo, c.timezone)}</span>} hint="this period, 12 months earlier" />
        </div>
        <T c={c} id="M10.treatment" />
      </MetricBlock>
      <MetricBlock id="M11" title="Patient satisfaction" description="Check-in scores (1–5): month 1 and month 12 after a transplant, day 14 after other treatments; public reviews weekly.">
        <div className="flex flex-wrap gap-6">
          <Stat label="All check-ins" value={m11.current.overall.avg === null ? "—" : `${fmtScore(m11.current.overall.avg)}/5`} hint={`${m11.current.overall.n} answers · previous ${m11.previous.overall.avg === null ? "—" : fmtScore(m11.previous.overall.avg)}`} />
          <Stat label="Transplant · month 1" value={m11.current.hairMonth1.avg === null ? "—" : `${fmtScore(m11.current.hairMonth1.avg)}/5`} hint={`${m11.current.hairMonth1.n} answers`} />
          <Stat label="Other treatments · day 14" value={m11.current.othersDay14.avg === null ? "—" : `${fmtScore(m11.current.othersDay14.avg)}/5`} hint={`${m11.current.othersDay14.n} answers`} />
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <T c={c} id="M11.buckets" />
          <T c={c} id="M11.treatment" empty="No check-in answers in this period." />
        </div>
        <ReportReviewsCard
          trend={m11.reviews.trend.map((r) => ({ weekStart: r.weekStart.toISOString().slice(0, 10), count: r.count, rating: r.rating, source: r.source }))}
          canEnter={canEnterReviews}
          thisWeek={thisWeek}
        />
        <T c={c} id="M11.reviews" />
      </MetricBlock>
    </div>
  );
}

function Response({ c }: { c: Ctx }) {
  const { m5, m6, m12 } = c.report;
  const hours = m5.current.byHour.filter((h) => h.n > 0);
  return (
    <div className="space-y-4">
      <MetricBlock id="M5" title="First-response time" description="Seconds from an inbound message to the first reply (AI or human), by channel and by the hour the message arrived.">
        <div className="flex flex-wrap gap-6">
          <Stat label="Median" value={<span className="inline-flex items-center gap-2">{fmtSeconds(m5.current.p50)} <Delta cur={m5.current.p50} prev={m5.previous.p50} good="down" fmt={fmtSeconds} /></span>} hint={`previous ${fmtSeconds(m5.previous.p50)}`} />
          <Stat label="90th percentile" value={fmtSeconds(m5.current.p90)} />
          <Stat label="AI · human (median)" value={`${fmtSeconds(m5.current.ai.p50)} · ${fmtSeconds(m5.current.human.p50)}`} hint={`${m5.current.ai.n} AI · ${m5.current.human.n} human replies`} />
          <Stat label="Waiting for a reply" value={fmtCount(m5.current.unanswered)} />
        </div>
        {hours.length ? (
          <div>
            <p className="data-label mb-1">Median by hour of arrival</p>
            <Columns items={hours.map((h) => ({ label: String(h.hour).padStart(2, "0"), value: h.p50 ?? 0 }))} height="h-28" format={fmtSeconds} />
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <T c={c} id="M5.who" />
          <T c={c} id="M5.channel" />
        </div>
        <T c={c} id="M5.hour" />
      </MetricBlock>

      <MetricBlock id="M6" title="No-show rate" description="No-shows divided by booked past appointments, by doctor, type, weekday, lead source and deposit.">
        <Stat label="No-show rate" value={<span className="inline-flex items-center gap-2">{fmtPct(m6.current.rate)} <Delta cur={m6.current.rate} prev={m6.previous.rate} good="down" fmt={fmtPct} /></span>} hint={`${m6.current.noShows} of ${m6.current.booked} booked · previous ${fmtPct(m6.previous.rate)}`} />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <T c={c} id="M6.doctor" highlight />
          <T c={c} id="M6.kind" />
          <T c={c} id="M6.weekday" />
          <T c={c} id="M6.source" />
          <T c={c} id="M6.deposit" />
        </div>
      </MetricBlock>

      <MetricBlock id="M12" title="Follow-ups overdue" description="Open lead follow-ups and concierge escalations past their target, by owner, as of now.">
        <div className="flex flex-wrap gap-6">
          <Stat label="Follow-ups" value={fmtCount(m12.followUps)} />
          <Stat label="Escalations" value={fmtCount(m12.escalations)} />
        </div>
        <T c={c} id="M12.owner" empty="Nothing overdue." />
        {m12.items.length ? (
          <section aria-label="Oldest overdue items" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="data-label">Oldest first</p>
              {c.tables.get("M12.items") ? <CsvLink href={exportHref(c, c.tables.get("M12.items")!)} label="All items CSV" /> : null}
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {m12.items.slice(0, 10).map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    {i.href ? (
                      <Link href={i.href} className="underline-offset-2 hover:text-accent hover:underline">
                        {i.subject}
                      </Link>
                    ) : (
                      i.subject
                    )}
                    <div className="text-xs text-muted-foreground">
                      {i.kind === "follow_up" ? "Follow-up" : "Escalation"} · {i.ownerLabel}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-warning">{i.overdueHours >= 72 ? `${Math.floor(i.overdueHours / 24)} d` : `${i.overdueHours} h`} late</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </MetricBlock>
    </div>
  );
}

function Definitions() {
  return (
    <Card className="min-w-0 space-y-4 p-4 sm:p-6">
      <SectionTitle title="Definitions" description="Exactly how each number is counted, where it comes from, and the filters it honours." />
      <dl className="space-y-4">
        {METRIC_DEFINITIONS.map((d) => (
          <div key={d.id} className="rounded-lg border border-border p-4">
            <dt className="flex flex-wrap items-center gap-2">
              <MetricBadge id={d.id} />
              <span className="font-medium">{d.name}</span>
              {d.finance ? <span className="text-xs text-muted-foreground">· money is owner only</span> : null}
            </dt>
            <dd className="mt-2 space-y-1 text-sm">
              <p>{d.definition}</p>
              <p className="text-xs text-muted-foreground">
                <span className="data-label">Source</span> {d.source} · <span className="data-label">Filters</span> {FILTERS[d.id]} · <span className="data-label">Better when</span> {d.goodWhen === "up" ? "higher" : "lower"}
              </p>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
