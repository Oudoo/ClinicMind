import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, formatDateInTz, fromDateKey } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { PROCEDURE_STATUSES, PROCEDURE_STATUS_LABELS } from "@/modules/finance/constants";
import {
  ADJUSTMENT_LABELS,
  ADJUSTMENT_TYPES,
  AGING,
  FINANCE_REPORTS,
  FINANCE_REPORT_LABELS,
  adjustmentsReport,
  balancesReport,
  branchReport,
  incomeReport,
  isFinanceReport,
  productionReport,
  proceduresReport,
  providersReport,
  reportScope,
  type FinanceReportKey,
  type ProductionTotals,
  type ReportScope,
} from "@/modules/finance/reports";
import { listReportDoctors } from "@/modules/reporting/service";
import { periodQuery } from "@/modules/reporting/period";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Kpi } from "@/components/ui/kpi";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PeriodPicker } from "@/components/clinicmind/report-period-picker";
import { CsvLink, NotForRole } from "@/components/clinicmind/report-shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Finance reports" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Whole EGP, a true minus sign for money that went the other way. */
const egp = (v: number) => (v < 0 ? `−${formatNumber(-v)}` : formatNumber(v));
const NUM = "text-right font-mono tabular-nums whitespace-nowrap";

const DESCRIPTIONS: Record<FinanceReportKey, string> = {
  income: "The money that came in each day, by kind and method, less refunds, and whether the drawer was signed off.",
  production: "The work done each day: its price before any discount, the discounts, work cancelled, consultation fees and what was charged.",
  branches: "Each branch side by side: its production, the money it took and what it wrote off.",
  adjustments: "Every discount, write-off, cancellation, refund, voided payment and credit note, with who made it and why.",
  balances: "What every patient owes now, what is due on invoices by age, and the invoices issued in the period.",
  procedures: "The procedures of the period and every course still under way: how far along, charged and invoiced.",
  providers: "Each doctor's production, the money collected for their work and what was written off on it.",
};

/**
 * `/dashboard/finance/reports?report=income|production|branches|adjustments|balances|procedures|providers
 * &period=28d|…&clinicId=` — the owner's financial reports, Dentalore's set, on the clinic's books
 * (see modules/finance/reports.ts for how each figure is counted), each with its CSV.
 */
export default async function FinanceReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "finance:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Finance reports" />
        <NotForRole title="Not available for your role" hint="The financial reports are for the clinic owner." />
      </div>
    );
  }
  const raw = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, first(v)]));
  const report: FinanceReportKey = isFinanceReport(raw.report) ? raw.report : "income";
  const scope = await reportScope(ctx.tenantId, raw).catch((err: unknown) => {
    if (err instanceof TenantScopeError) return reportScope(ctx.tenantId, { ...raw, clinicId: undefined });
    throw err;
  });
  const period = scope.period;
  const tz = scope.timezone;
  const keep: Record<string, string> = { ...periodQuery(period), ...(scope.clinicId ? { clinicId: scope.clinicId } : {}) };
  const href = (entries: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...keep, report, ...entries })) if (v) params.set(k, v);
    return `/dashboard/finance/reports?${params.toString()}`;
  };
  const filterEntries = { status: scope.filters.status, doctorId: scope.filters.doctorId, type: scope.filters.type };
  const csvQuery = new URLSearchParams(Object.entries({ ...keep, ...filterEntries, format: "csv" }).filter((e): e is [string, string] => Boolean(e[1])));
  const day = (key: string) => formatDateInTz(fromDateKey(key, tz)!, tz, { weekday: "short", day: "numeric", month: "short" });
  const previous = { fromKey: dateKeyInTz(period.previous.from, tz), toKey: dateKeyInTz(new Date(period.previous.to.getTime() - 1), tz) };

  return (
    <div className="space-y-6">
      <SectionTitle title="Finance reports" description="Dentalore's daily reports on the clinic's books: the money in, the work done, the adjustments and what patients owe." />

      <nav aria-label="Reports" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex w-max gap-1 rounded-lg bg-muted p-1 sm:w-auto sm:flex-wrap">
          {FINANCE_REPORTS.map((key) => (
            <li key={key}>
              <Link
                href={`/dashboard/finance/reports?${new URLSearchParams({ ...keep, report: key }).toString()}`}
                scroll={false}
                aria-current={key === report ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors",
                  key === report ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {FINANCE_REPORT_LABELS[key]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <h2 className="font-display text-lg font-semibold tracking-tight">{FINANCE_REPORT_LABELS[report]}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{DESCRIPTIONS[report]}</p>
          </div>
          <CsvLink href={`/api/finance/reports/${report}?${csvQuery.toString()}`} label="Download CSV" />
        </div>
        <PeriodPicker basePath="/dashboard/finance/reports" preset={period.preset} fromKey={period.fromKey} toKey={period.toKey} previous={previous} keep={{ report, ...(scope.clinicId ? { clinicId: scope.clinicId } : {}), ...Object.fromEntries(Object.entries(filterEntries).filter((e): e is [string, string] => Boolean(e[1]))) }} />
        {scope.clinics.length > 1 && report !== "branches" ? (
          <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Branch">
            <input type="hidden" name="report" value={report} />
            {Object.entries(periodQuery(period)).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <Select name="clinicId" defaultValue={scope.clinicId ?? ""} aria-label="Branch" className="w-56">
              <option value="">Every branch</option>
              {scope.clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="outline" className="h-10">
              Show
            </Button>
          </form>
        ) : null}
        {report === "balances" ? <p className="text-xs text-muted-foreground">Balances are as they stand now, at every branch; the period and the branch choose the invoices listed.</p> : null}
      </Card>

      {report === "income" ? <Income scope={scope} day={day} /> : null}
      {report === "production" ? <Production scope={scope} day={day} /> : null}
      {report === "branches" ? <Branches scope={scope} /> : null}
      {report === "adjustments" ? <Adjustments scope={scope} day={day} href={href} /> : null}
      {report === "balances" ? <Balances scope={scope} /> : null}
      {report === "procedures" ? <Procedures scope={scope} href={href} /> : null}
      {report === "providers" ? <Providers scope={scope} /> : null}

      <Card className="space-y-2 text-sm" aria-label="How these are counted">
        <h2 className="font-display text-base font-semibold tracking-tight">How these are counted</h2>
        <ul className="list-disc space-y-1 ps-5 text-muted-foreground">
          <li>Production is the work charged to patients, on the day it was done. Gross is its price before any discount; net is gross less discounts and work cancelled, plus consultation fees. It equals what the patients&apos; accounts were charged.</li>
          <li>A course&apos;s own discount is spread over its sessions as its price is. A cancellation is counted on the day it is made; the day the work was done keeps its figures.</li>
          <li>Income is the money that came in (payments, deposits, consultation fees) less refunds, on the day it was taken. Voided payments never count.</li>
          <li>A doctor&apos;s collections are the money put towards their invoiced work, each payment shared over the invoice&apos;s lines, plus their consultation fees.</li>
          <li>Days run on the clinic&apos;s clock ({tz}).</li>
        </ul>
      </Card>
    </div>
  );
}

function ProductionKpis({ t }: { t: ProductionTotals }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      <Kpi label="Net production · EGP" value={egp(t.net)} tone="accent" hint={`${formatNumber(t.procedures)} procedures and sessions`} />
      <Kpi label="Gross production · EGP" value={egp(t.gross)} hint="before any discount" />
      <Kpi label="Discounts · EGP" value={egp(t.discounts)} hint="on procedures and invoices" />
      <Kpi label="Cancelled work · EGP" value={egp(t.cancelled)} hint="reversed after it was charged" />
      <Kpi label="Consultation fees · EGP" value={egp(t.fees)} hint="charged and paid at once" />
    </div>
  );
}

async function Income({ scope, day }: { scope: ReportScope; day: (key: string) => string }) {
  const r = await incomeReport(scope);
  const days = r.days.filter((d) => d.receipts > 0);
  const t = r.totals;
  const drawer = (date: string) => `/dashboard/finance/cash?${new URLSearchParams({ date, ...(scope.clinicId ? { clinicId: scope.clinicId } : {}) }).toString()}`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <Kpi label="Net income · EGP" value={egp(t.net)} tone="accent" hint={`${formatNumber(t.receipts)} receipts`} />
        <Kpi label="Payments · EGP" value={egp(t.payments)} hint="towards invoices and credit" />
        <Kpi label="Deposits · EGP" value={egp(t.deposits)} hint="taken ahead of procedures" />
        <Kpi label="Consultation fees · EGP" value={egp(t.fees)} hint="paid at the visit" />
        <Kpi label="Refunds · EGP" value={egp(t.refunds)} tone={t.refunds < 0 ? "warning" : "default"} hint="money paid back" />
      </div>
      <Card className="overflow-hidden p-0">
        {days.length ? (
          <Table aria-label="Daily income">
            <THead>
              <TR>
                <TH>Day</TH>
                <TH className="hidden text-right sm:table-cell">Payments</TH>
                <TH className="hidden text-right md:table-cell">Deposits</TH>
                <TH className="hidden text-right md:table-cell">Fees</TH>
                <TH className="hidden text-right md:table-cell">Refunds</TH>
                {r.methods.map((m) => (
                  <TH key={m.method} className="hidden text-right 2xl:table-cell">
                    {m.label}
                  </TH>
                ))}
                <TH className="text-right">Net</TH>
                <TH className="hidden sm:table-cell">Drawer</TH>
              </TR>
            </THead>
            <TBody>
              {days.map((d) => (
                <TR key={d.date}>
                  <TD className="whitespace-nowrap">
                    {day(d.date)}
                    <span className="block text-xs text-muted-foreground">
                      {d.receipts} receipt{d.receipts === 1 ? "" : "s"}
                      <span className="sm:hidden"> · {d.signedOff === "yes" ? "signed off" : d.signedOff === "partly" ? "partly signed off" : "not signed off"}</span>
                    </span>
                  </TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{egp(d.payments)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(d.deposits)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(d.fees)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(d.refunds)}</TD>
                  {r.methods.map((m) => (
                    <TD key={m.method} className={cn(NUM, "hidden 2xl:table-cell")}>
                      {egp(d.methods[m.method] ?? 0)}
                    </TD>
                  ))}
                  <TD className={cn(NUM, "font-medium")}>{egp(d.net)}</TD>
                  <TD className="hidden sm:table-cell">
                    <Link href={drawer(d.date)} className="underline-offset-2 hover:underline">
                      {d.signedOff === "yes" ? <Badge tone="success">Signed off</Badge> : d.signedOff === "partly" ? <Badge tone="warning">Partly signed off</Badge> : <Badge tone="warning">Not signed off</Badge>}
                    </Link>
                  </TD>
                </TR>
              ))}
              <TR className="bg-muted/40 font-medium">
                <TD>Total</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{egp(t.payments)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{egp(t.deposits)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{egp(t.fees)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{egp(t.refunds)}</TD>
                {r.methods.map((m) => (
                  <TD key={m.method} className={cn(NUM, "hidden 2xl:table-cell")}>
                    {egp(t.methods[m.method] ?? 0)}
                  </TD>
                ))}
                <TD className={NUM}>{egp(t.net)}</TD>
                <TD className="hidden sm:table-cell" />
              </TR>
            </TBody>
          </Table>
        ) : (
          <EmptyState title="No money in this period" hint="Pick a longer period, or another branch." />
        )}
      </Card>
      {r.methods.length ? (
        <Card className="overflow-hidden p-0">
          <Table aria-label="Income by method">
            <THead>
              <TR>
                <TH>Method</TH>
                <TH className="text-right">Net income</TH>
                <TH className="text-right">Share</TH>
              </TR>
            </THead>
            <TBody>
              {r.methods.map((m) => (
                <TR key={m.method}>
                  <TD>{m.label}</TD>
                  <TD className={NUM}>{egp(t.methods[m.method] ?? 0)}</TD>
                  <TD className={NUM}>{t.net ? `${Math.round(((t.methods[m.method] ?? 0) * 100) / t.net)}%` : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}
      {days.length < r.days.length ? <p className="text-xs text-muted-foreground">Days with no money are left out.</p> : null}
    </div>
  );
}

async function Production({ scope, day }: { scope: ReportScope; day: (key: string) => string }) {
  const r = await productionReport(scope);
  const days = r.days.filter((d) => d.gross || d.discounts || d.cancelled || d.fees || d.procedures);
  return (
    <div className="space-y-4">
      <ProductionKpis t={r.totals} />
      <Card className="overflow-hidden p-0">
        {days.length ? (
          <Table aria-label="Daily production">
            <THead>
              <TR>
                <TH>Day</TH>
                <TH className="hidden text-right sm:table-cell">Gross</TH>
                <TH className="hidden text-right md:table-cell">Discounts</TH>
                <TH className="hidden text-right md:table-cell">Cancelled</TH>
                <TH className="hidden text-right md:table-cell">Fees</TH>
                <TH className="text-right">Net</TH>
                <TH className="hidden text-right lg:table-cell">Procedures</TH>
              </TR>
            </THead>
            <TBody>
              {days.map((d) => (
                <TR key={d.date}>
                  <TD className="whitespace-nowrap">{day(d.date)}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{egp(d.gross)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(d.discounts)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(d.cancelled)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(d.fees)}</TD>
                  <TD className={cn(NUM, "font-medium")}>{egp(d.net)}</TD>
                  <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(d.procedures)}</TD>
                </TR>
              ))}
              <TotalsRow t={r.totals} />
            </TBody>
          </Table>
        ) : (
          <EmptyState title="No work charged in this period" hint="Pick a longer period, or another branch." />
        )}
      </Card>
      {r.byTreatment.length ? (
        <Card className="overflow-hidden p-0">
          <Table aria-label="Production by treatment">
            <THead>
              <TR>
                <TH>Treatment</TH>
                <TH className="hidden text-right sm:table-cell">Procedures</TH>
                <TH className="text-right">Net production</TH>
              </TR>
            </THead>
            <TBody>
              {r.byTreatment.map((t) => (
                <TR key={t.name}>
                  <TD>{t.name}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{t.procedures ? formatNumber(t.procedures) : "—"}</TD>
                  <TD className={NUM}>{egp(t.net)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

function TotalsRow({ t }: { t: ProductionTotals }) {
  return (
    <TR className="bg-muted/40 font-medium">
      <TD>Total</TD>
      <TD className={cn(NUM, "hidden sm:table-cell")}>{egp(t.gross)}</TD>
      <TD className={cn(NUM, "hidden md:table-cell")}>{egp(t.discounts)}</TD>
      <TD className={cn(NUM, "hidden md:table-cell")}>{egp(t.cancelled)}</TD>
      <TD className={cn(NUM, "hidden md:table-cell")}>{egp(t.fees)}</TD>
      <TD className={NUM}>{egp(t.net)}</TD>
      <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(t.procedures)}</TD>
    </TR>
  );
}

async function Branches({ scope }: { scope: ReportScope }) {
  const r = await branchReport(scope);
  const rows = [...r.rows, { clinicId: "total", name: "Total", ...r.totals }];
  return (
    <Card className="overflow-hidden p-0">
      <Table aria-label="Branch production">
        <THead>
          <TR>
            <TH>Branch</TH>
            <TH className="hidden text-right md:table-cell">Gross</TH>
            <TH className="hidden text-right lg:table-cell">Discounts</TH>
            <TH className="hidden text-right lg:table-cell">Cancelled</TH>
            <TH className="hidden text-right lg:table-cell">Fees</TH>
            <TH className="text-right">Net production</TH>
            <TH className="hidden text-right sm:table-cell">Income</TH>
            <TH className="hidden text-right md:table-cell">Written off</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((b) => (
            <TR key={b.clinicId} className={b.clinicId === "total" ? "bg-muted/40 font-medium" : undefined}>
              <TD>{b.name}</TD>
              <TD className={cn(NUM, "hidden md:table-cell")}>{egp(b.gross)}</TD>
              <TD className={cn(NUM, "hidden lg:table-cell")}>{egp(b.discounts)}</TD>
              <TD className={cn(NUM, "hidden lg:table-cell")}>{egp(b.cancelled)}</TD>
              <TD className={cn(NUM, "hidden lg:table-cell")}>{egp(b.fees)}</TD>
              <TD className={cn(NUM, "font-medium")}>{egp(b.net)}</TD>
              <TD className={cn(NUM, "hidden sm:table-cell")}>{egp(b.income)}</TD>
              <TD className={cn(NUM, "hidden md:table-cell")}>{egp(b.writtenOff)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

async function Adjustments({ scope, day, href }: { scope: ReportScope; day: (key: string) => string; href: (e: Record<string, string | undefined>) => string }) {
  const r = await adjustmentsReport(scope);
  const type = scope.filters.type;
  const all = ADJUSTMENT_TYPES.reduce((s, k) => s + r.totals[k].count, 0);
  return (
    <div className="space-y-4">
      <nav aria-label="Adjustment types">
        <ul className="flex flex-wrap gap-2">
          <li>
            <Link href={href({ type: undefined })} aria-current={!type ? "page" : undefined} className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm", !type ? "border-accent bg-accent-muted" : "border-border hover:bg-muted")}>
              All <span className="font-mono text-xs tabular-nums text-muted-foreground">{all}</span>
            </Link>
          </li>
          {ADJUSTMENT_TYPES.map((k) => (
            <li key={k}>
              <Link href={href({ type: k })} aria-current={type === k ? "page" : undefined} className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm", type === k ? "border-accent bg-accent-muted" : "border-border hover:bg-muted")}>
                {ADJUSTMENT_LABELS[k]}
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {r.totals[k].count} · {egp(r.totals[k].amount)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Card className="overflow-hidden p-0">
        {r.rows.length ? (
          <Table aria-label="Daily adjustments">
            <THead>
              <TR>
                <TH>Day</TH>
                <TH>Adjustment</TH>
                <TH className="text-right">Amount</TH>
                <TH className="hidden lg:table-cell">Reason</TH>
                <TH className="hidden md:table-cell">By</TH>
              </TR>
            </THead>
            <TBody>
              {r.rows.map((a) => (
                <TR key={a.id} className="align-top">
                  <TD className="whitespace-nowrap">{day(a.date)}</TD>
                  <TD className="min-w-0">
                    <span className="font-medium">{ADJUSTMENT_LABELS[a.type]}</span>
                    {" · "}
                    <Link href={`/dashboard/patients/${a.patientId}?tab=account`} className="underline-offset-2 hover:underline">
                      {a.patientName}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {a.description}
                      {a.reference ? <span className="font-mono"> · {a.reference}</span> : null}
                    </span>
                    {a.reason ? <span className="block text-xs text-muted-foreground lg:hidden">Why: {a.reason}</span> : null}
                  </TD>
                  <TD className={NUM}>{egp(a.amount)}</TD>
                  <TD className="hidden max-w-xs text-sm lg:table-cell">{a.reason ?? "—"}</TD>
                  <TD className="hidden whitespace-nowrap text-sm md:table-cell">{a.by ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState title={type ? `No ${ADJUSTMENT_LABELS[type].toLowerCase()} in this period` : "No adjustments in this period"} hint="Pick a longer period, or another type." />
        )}
      </Card>
    </div>
  );
}

async function Balances({ scope }: { scope: ReportScope }) {
  const r = await balancesReport(scope);
  const t = r.totals;
  const tz = scope.timezone;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Owed · EGP" value={egp(t.owed)} tone={t.owed ? "warning" : "default"} hint={`${t.owing} patient${t.owing === 1 ? "" : "s"} owing`} />
        <Kpi label="In credit · EGP" value={egp(t.credit)} hint={`${t.inCredit} patient${t.inCredit === 1 ? "" : "s"} paid ahead`} />
        <Kpi label="Due on invoices · EGP" value={egp(t.dueOnInvoices)} hint="issued and not paid" />
        <Kpi label="Not invoiced · EGP" value={egp(t.notInvoiced)} hint="charged, on no issued invoice yet" />
      </div>
      <Card className="overflow-hidden p-0">
        <Table aria-label="Due on invoices by age">
          <THead>
            <TR>
              {AGING.map((a) => (
                <TH key={a} className="text-right">
                  {a}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            <TR>
              {t.aging.map((v, k) => (
                <TD key={AGING[k]} className={cn(NUM, k === 3 && v > 0 && "text-danger")}>
                  {egp(v)}
                </TD>
              ))}
            </TR>
          </TBody>
        </Table>
      </Card>
      <Card className="overflow-hidden p-0">
        {r.rows.length ? (
          <Table aria-label="Patients' balances">
            <THead>
              <TR>
                <TH>Patient</TH>
                <TH className="text-right">Balance</TH>
                <TH className="hidden text-right sm:table-cell">Due on invoices</TH>
                <TH className="hidden text-right md:table-cell">Not invoiced</TH>
                <TH className="hidden text-right md:table-cell">Credit</TH>
                {AGING.map((a) => (
                  <TH key={a} className="hidden text-right xl:table-cell">
                    {a}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {r.rows.map((b) => (
                <TR key={b.patientId}>
                  <TD>
                    <Link href={`/dashboard/patients/${b.patientId}?tab=account`} className="font-medium underline-offset-2 hover:underline">
                      {b.patientName}
                    </Link>
                    {b.phone ? <span className="block font-mono text-xs text-muted-foreground">{b.phone}</span> : null}
                  </TD>
                  <TD className={cn(NUM, "font-medium", b.balance < 0 && "text-success")}>{b.balance < 0 ? `${egp(-b.balance)} credit` : egp(b.balance)}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{egp(b.dueOnInvoices)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(b.notInvoiced)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(b.credit)}</TD>
                  {b.aging.map((v, k) => (
                    <TD key={AGING[k]} className={cn(NUM, "hidden xl:table-cell")}>
                      {v ? egp(v) : "—"}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState title="Every account is settled" hint="No patient owes the clinic or is in credit." />
        )}
      </Card>
      <Card className="space-y-3 p-0">
        <div className="px-4 pt-4 sm:px-5">
          <h3 className="font-display text-base font-semibold tracking-tight">Invoices issued in the period</h3>
          <p className="text-sm text-muted-foreground">
            {r.invoices.issued} issued · {egp(r.invoices.issuedTotal)} EGP · paid {egp(r.invoices.paid)} · written off {egp(r.invoices.writtenOff)} · due {egp(r.invoices.due)}
            {r.invoices.cancelled ? ` · ${r.invoices.cancelled} cancelled by credit note` : ""}
          </p>
        </div>
        {r.invoices.rows.length ? (
          <Table aria-label="Invoices issued">
            <THead>
              <TR>
                <TH>Invoice</TH>
                <TH className="hidden sm:table-cell">Issued</TH>
                <TH className="hidden text-right md:table-cell">Total</TH>
                <TH className="hidden text-right md:table-cell">Paid</TH>
                <TH className="text-right">Due</TH>
                <TH className="hidden sm:table-cell">Status</TH>
              </TR>
            </THead>
            <TBody>
              {[...r.invoices.rows].reverse().map((i) => (
                <TR key={i.id}>
                  <TD>
                    <Link href={`/dashboard/finance/invoices/${i.id}`} className="font-mono text-xs font-medium underline-offset-2 hover:underline">
                      {i.number}
                    </Link>
                    <span className="block text-sm">{i.patientName}</span>
                  </TD>
                  <TD className="hidden whitespace-nowrap sm:table-cell">{formatDateInTz(new Date(i.issuedAt), tz)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(i.total)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{egp(i.paid)}</TD>
                  <TD className={cn(NUM, "font-medium")}>{egp(i.due)}</TD>
                  <TD className="hidden sm:table-cell">
                    <Badge tone={i.status === "PAID" ? "success" : i.status === "CANCELLED" ? "default" : "warning"}>
                      {i.status === "PAID" ? (i.writtenOff ? "Closed: written off" : "Paid") : i.status === "PART_PAID" ? "Part paid" : i.status === "CANCELLED" ? "Cancelled" : "Issued"}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="px-4 pb-4 text-sm text-muted-foreground sm:px-5">No invoice was issued in this period.</div>
        )}
      </Card>
    </div>
  );
}

async function Procedures({ scope, href }: { scope: ReportScope; href: (e: Record<string, string | undefined>) => string }) {
  const [r, doctors] = await Promise.all([proceduresReport(scope), listReportDoctors(scope.tenantId)]);
  const { status, doctorId } = scope.filters;
  const tz = scope.timezone;
  const all = PROCEDURE_STATUSES.reduce((s, k) => s + r.counts[k], 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <nav aria-label="Procedure status">
          <ul className="flex flex-wrap gap-2">
            <li>
              <Link href={href({ status: undefined, doctorId })} aria-current={!status ? "page" : undefined} className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm", !status ? "border-accent bg-accent-muted" : "border-border hover:bg-muted")}>
                All <span className="font-mono text-xs tabular-nums text-muted-foreground">{all}</span>
              </Link>
            </li>
            {PROCEDURE_STATUSES.map((k) => (
              <li key={k}>
                <Link href={href({ status: k, doctorId })} aria-current={status === k ? "page" : undefined} className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm", status === k ? "border-accent bg-accent-muted" : "border-border hover:bg-muted")}>
                  {k === "STARTED" ? "Under way" : k === "SIGNED" ? "Done" : PROCEDURE_STATUS_LABELS[k]}
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{r.counts[k]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Doctor">
          {Object.entries({ report: "procedures", ...periodQuery(scope.period), ...(scope.clinicId ? { clinicId: scope.clinicId } : {}), ...(status ? { status } : {}) }).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <Select name="doctorId" defaultValue={doctorId ?? ""} aria-label="Doctor" className="w-48">
            <option value="">Every doctor</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fullName}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline" className="h-10">
            Show
          </Button>
        </form>
      </div>
      <Card className="overflow-hidden p-0">
        {r.rows.length ? (
          <Table aria-label="Procedures">
            <THead>
              <TR>
                <TH>Procedure</TH>
                <TH className="hidden md:table-cell">Doctor</TH>
                <TH>Status</TH>
                <TH className="hidden text-right lg:table-cell">Price</TH>
                <TH className="hidden text-right sm:table-cell">Charged</TH>
                <TH className="hidden text-right lg:table-cell">Invoiced</TH>
                <TH className="hidden text-right md:table-cell">Not invoiced</TH>
              </TR>
            </THead>
            <TBody>
              {r.rows.map((p) => (
                <TR key={p.id} className="align-top">
                  <TD className="min-w-0">
                    <span className="font-medium">{p.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      <Link href={`/dashboard/patients/${p.patientId}`} className="underline-offset-2 hover:underline">
                        {p.patientName}
                      </Link>
                      {" · "}
                      {formatDateInTz(new Date(p.performedAt), tz)}
                    </span>
                  </TD>
                  <TD className="hidden whitespace-nowrap text-sm md:table-cell">{p.doctorName ?? "—"}</TD>
                  <TD className="whitespace-nowrap">
                    <Badge tone={p.status === "SIGNED" ? "success" : p.status === "STARTED" ? "accent" : p.status === "CANCELLED" ? "default" : "warning"}>
                      {p.status === "STARTED" ? "Under way" : p.status === "SIGNED" ? "Done" : PROCEDURE_STATUS_LABELS[p.status]}
                    </Badge>
                    {p.stages > 1 ? (
                      <span className="block text-xs text-muted-foreground">
                        {p.stagesDone} of {p.stages} sessions
                      </span>
                    ) : null}
                  </TD>
                  <TD className={cn(NUM, "hidden lg:table-cell")}>{egp(p.net)}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{egp(p.charged)}</TD>
                  <TD className={cn(NUM, "hidden lg:table-cell")}>{egp(p.invoiced)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell", p.notInvoiced > 0 && "text-warning")}>{egp(p.notInvoiced)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState title="No procedure matches" hint="Pick a longer period, another status or another doctor." />
        )}
      </Card>
    </div>
  );
}

async function Providers({ scope }: { scope: ReportScope }) {
  const r = await providersReport(scope);
  const rows = [...r.rows, { doctorId: "total", name: "Total", ...r.totals }];
  return (
    <Card className="overflow-hidden p-0">
      {r.rows.length ? (
        <Table aria-label="Provider financials">
          <THead>
            <TR>
              <TH>Doctor</TH>
              <TH className="hidden text-right lg:table-cell">Procedures</TH>
              <TH className="hidden text-right md:table-cell">Gross</TH>
              <TH className="hidden text-right lg:table-cell">Discounts</TH>
              <TH className="hidden text-right xl:table-cell">Cancelled</TH>
              <TH className="hidden text-right xl:table-cell">Fees</TH>
              <TH className="text-right">Net production</TH>
              <TH className="hidden text-right sm:table-cell">Collected</TH>
              <TH className="hidden text-right md:table-cell">Written off</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((p) => (
              <TR key={p.doctorId ?? "none"} className={p.doctorId === "total" ? "bg-muted/40 font-medium" : undefined}>
                <TD>{p.name}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(p.procedures)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{egp(p.gross)}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{egp(p.discounts)}</TD>
                <TD className={cn(NUM, "hidden xl:table-cell")}>{egp(p.cancelled)}</TD>
                <TD className={cn(NUM, "hidden xl:table-cell")}>{egp(p.fees)}</TD>
                <TD className={cn(NUM, "font-medium")}>{egp(p.net)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{egp(p.collected)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{egp(p.writtenOff)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <EmptyState title="No doctor's work in this period" hint="Pick a longer period, or another branch." />
      )}
    </Card>
  );
}
