import Link from "next/link";
import { formatDateInTz, fromDateKey } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import {
  acceptanceReport,
  collectionReport,
  INSTALMENT_MONTHS_AHEAD,
  instalmentsDueReport,
  OWED_AGES,
  owedByAgeReport,
  profitAndLossReport,
  sourcesReport,
  type InstalmentLine,
} from "@/modules/finance/monthly-reports";
import type { ReportScope } from "@/modules/finance/reports";
import { INSTALMENT_STATE_LABELS } from "@/modules/finance/instalment-schedule";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Columns, HBars, Kpi } from "@/components/ui/kpi";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

/**
 * The month-by-month finance reports (modules/finance/monthly-reports.ts):
 * profit and loss, owed by age, collection rate, case acceptance,
 * instalments due and revenue by marketing source. Server components; the
 * finance reports page shows the one asked for.
 */

/** Whole EGP, a true minus sign for money that went the other way. */
const egp = (v: number) => (v < 0 ? `−${formatNumber(-v)}` : formatNumber(v));
const pct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`);
const NUM = "text-right font-mono tabular-nums whitespace-nowrap";
const short = (label: string) => label.replace(/ \d{2}(\d{2})$/, " ’$1");

export async function ProfitAndLoss({ scope }: { scope: ReportScope }) {
  const r = await profitAndLossReport(scope);
  const t = r.totals;
  const open = r.months.some((m) => m.doctorPayOpen);
  const costs = [...r.categories.map((c) => ({ label: c.label, value: t.byCategory[c.key] ?? 0 })), ...(t.doctorPay ? [{ label: "Doctors' pay", value: t.doctorPay }] : [])].sort((a, b) => b.value - a.value);
  return (
    <div className="space-y-4" data-testid="pnl-report">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Revenue · EGP" value={egp(t.revenue)} tone="accent" hint={`${egp(t.production)} of work done, ${egp(t.writtenOff)} written off`} />
        <Kpi label="Expenses · EGP" value={egp(t.expenses)} hint={`${r.categories.length} categor${r.categories.length === 1 ? "y" : "ies"}`} />
        <Kpi label="Doctors' pay · EGP" value={egp(t.doctorPay)} hint={open ? "as the statements stand; a month is open" : "as their statements have it"} />
        <Kpi label="Profit · EGP" value={egp(t.profit)} tone={t.profit < 0 ? "warning" : "default"} hint={t.margin === null ? "no revenue" : `${pct(t.margin)} of revenue`} />
      </div>

      <Card className="space-y-3">
        <SectionTitle title="Revenue and costs, month by month" description="Revenue (accent) against expenses and the doctors' pay (grey)." />
        <Columns items={r.months.map((m) => ({ label: short(m.label), value: Math.max(0, m.revenue), compare: Math.max(0, m.expenses + m.doctorPay) }))} format={(v) => `${formatNumber(v)} EGP`} />
      </Card>

      <Card className="overflow-hidden p-0">
        <Table aria-label="Profit and loss by month" data-testid="pnl-table">
          <THead>
            <TR>
              <TH>Month</TH>
              <TH className="hidden text-right md:table-cell">Work done</TH>
              <TH className="hidden text-right lg:table-cell">Written off</TH>
              <TH className="text-right">Revenue</TH>
              <TH className="hidden text-right sm:table-cell">Expenses</TH>
              <TH className="hidden text-right sm:table-cell">Doctors&apos; pay</TH>
              <TH className="text-right">Profit</TH>
              <TH className="hidden text-right md:table-cell">Margin</TH>
            </TR>
          </THead>
          <TBody>
            {[...r.months, { month: "total", label: "Total", doctorPayOpen: false, ...t }].map((m) => (
              <TR key={m.month} className={m.month === "total" ? "bg-muted/40 font-medium" : undefined}>
                <TD className="whitespace-nowrap">{m.label}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{egp(m.production)}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{m.writtenOff ? egp(-m.writtenOff) : "0"}</TD>
                <TD className={NUM}>{egp(m.revenue)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{m.expenses ? egp(-m.expenses) : "0"}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>
                  {m.doctorPay ? egp(-m.doctorPay) : "0"}
                  {m.doctorPayOpen ? <span title="The month's statement is not closed yet: the pay as it stands">*</span> : null}
                </TD>
                <TD className={cn(NUM, "font-medium", m.profit < 0 && "text-danger")}>{egp(m.profit)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{pct(m.margin)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {open ? <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">* A doctor&apos;s statement for the month is not closed yet: their pay is as it stands today.</p> : null}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="space-y-3">
          <SectionTitle title="Where the money went" description="Expenses by category, and the doctors' pay, over the months shown." />
          {costs.length ? <HBars items={costs} format={(v) => formatNumber(v)} labelWidth="w-32 sm:w-44" /> : <EmptyState title="No expense in these months" />}
        </Card>
        <Card className="overflow-hidden p-0">
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <SectionTitle title="The cash side" description="Money in (patients, insurers and companies, less refunds) and out (expenses and doctors paid), on the day it moved." />
          </div>
          <Table aria-label="Money in and out by month" data-testid="pnl-cash">
            <THead>
              <TR>
                <TH>Month</TH>
                <TH className="text-right">In</TH>
                <TH className="text-right">Out</TH>
                <TH className="hidden text-right sm:table-cell">Net</TH>
              </TR>
            </THead>
            <TBody>
              {[...r.months, { month: "total", label: "Total", ...t }].map((m) => (
                <TR key={m.month} className={m.month === "total" ? "bg-muted/40 font-medium" : undefined}>
                  <TD className="whitespace-nowrap">{m.label}</TD>
                  <TD className={NUM}>{egp(m.moneyIn)}</TD>
                  <TD className={NUM}>{m.moneyOut ? egp(-m.moneyOut) : "0"}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell", m.moneyIn - m.moneyOut < 0 && "text-danger")}>{egp(m.moneyIn - m.moneyOut)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

export async function OwedByAge({ scope }: { scope: ReportScope }) {
  const r = await owedByAgeReport(scope);
  const t = r.totals;
  const tz = scope.timezone;
  const day = (iso: string) => formatDateInTz(new Date(iso), tz, { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="space-y-4" data-testid="owed-report">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Owed to the clinic · EGP" value={egp(t.total)} tone="accent" hint="by patients and by payers, now" />
        <Kpi label="Over 90 days · EGP" value={egp(t.buckets[3])} tone={t.buckets[3] ? "warning" : "default"} hint={t.total ? `${pct(Math.round((t.buckets[3] / t.total) * 1000) / 10)} of it` : "nothing owed"} />
        <Kpi label="Payers late · EGP" value={egp(t.late)} tone={t.late ? "warning" : "default"} hint="past their days to pay" />
        <Kpi label="Not invoiced yet · EGP" value={egp(r.notInvoiced)} hint={`patients' credit held: ${egp(r.credit)}`} />
      </div>

      <Card className="overflow-hidden p-0">
        <Table aria-label="Owed by age" data-testid="owed-table">
          <THead>
            <TR>
              <TH>Who</TH>
              {OWED_AGES.map((a, i) => (
                <TH key={a} className={cn("text-right", i === 3 ? "" : i === 0 ? "hidden sm:table-cell" : "hidden md:table-cell")}>
                  {a}
                </TH>
              ))}
              <TH className="text-right">Owed</TH>
              <TH className="hidden text-right lg:table-cell">Late</TH>
            </TR>
          </THead>
          <TBody>
            {[...r.rows, { key: "total", name: "Total", kind: "TOTAL" as const, ...t, notSent: t.notSent, count: 0 }].map((row) => (
              <TR key={row.key} className={row.key === "total" ? "bg-muted/40 font-medium" : undefined}>
                <TD>
                  {row.kind === "INSURER" || row.kind === "COMPANY" ? (
                    <Link href={`/dashboard/finance/insurance/payers/${row.key}`} className="underline-offset-2 hover:underline">
                      {row.name}
                    </Link>
                  ) : (
                    row.name
                  )}
                  {row.kind !== "TOTAL" ? (
                    <span className="block text-xs text-muted-foreground">
                      {row.kind === "PATIENTS" ? `${row.count} invoice${row.count === 1 ? "" : "s"}` : `${row.kind === "INSURER" ? "Insurer" : "Company"} · ${row.count} claim${row.count === 1 ? "" : "s"}${row.notSent ? ` · ${formatNumber(row.notSent)} not sent yet` : ""}`}
                    </span>
                  ) : null}
                </TD>
                {row.buckets.map((v, i) => (
                  <TD key={i} className={cn(NUM, i === 3 ? (v ? "text-danger" : "") : i === 0 ? "hidden sm:table-cell" : "hidden md:table-cell")}>
                    {formatNumber(v)}
                  </TD>
                ))}
                <TD className={cn(NUM, "font-medium")}>{formatNumber(row.total)}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell", row.late > 0 && "text-danger")}>{formatNumber(row.late)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="p-4 pb-2 sm:p-5 sm:pb-2">
          <SectionTitle title="Patients who owe the most" description="On their invoices, now; the CSV has every one." />
        </div>
        {r.patients.length ? (
          <Table aria-label="Patients who owe the most" data-testid="owed-patients">
            <THead>
              <TR>
                <TH>Patient</TH>
                <TH className="hidden sm:table-cell">Oldest invoice</TH>
                <TH className="hidden text-right md:table-cell">Over 90 days</TH>
                <TH className="text-right">Owed</TH>
              </TR>
            </THead>
            <TBody>
              {r.patients.slice(0, 15).map((p) => (
                <TR key={p.patientId}>
                  <TD>
                    <Link href={`/dashboard/patients/${p.patientId}`} className="font-medium underline-offset-2 hover:underline">
                      {p.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {p.invoices} invoice{p.invoices === 1 ? "" : "s"}
                      <span className="sm:hidden"> · since {day(p.oldestIssuedAt)}</span>
                    </span>
                  </TD>
                  <TD className="hidden whitespace-nowrap text-sm sm:table-cell">{day(p.oldestIssuedAt)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell", p.buckets[3] > 0 && "text-danger")}>{formatNumber(p.buckets[3])}</TD>
                  <TD className={cn(NUM, "font-medium")}>{formatNumber(p.total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-4 pt-0">
            <EmptyState title="No patient owes on an invoice" />
          </div>
        )}
      </Card>
    </div>
  );
}

export async function Collection({ scope }: { scope: ReportScope }) {
  const r = await collectionReport(scope);
  const t = r.totals;
  return (
    <div className="space-y-4" data-testid="collection-report">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Collection rate" value={pct(t.rate)} tone="accent" hint={`of ${formatNumber(t.invoices)} invoices issued`} />
        <Kpi label="Collected · EGP" value={egp(t.collected)} hint={`${egp(t.fromPatients)} from patients, ${egp(t.fromPayers)} from payers`} />
        <Kpi label="Still owed · EGP" value={egp(t.payersOwe + t.patientsOwe)} tone={t.payersOwe + t.patientsOwe ? "warning" : "default"} hint={`${egp(t.payersOwe)} by payers, ${egp(t.patientsOwe)} by patients`} />
        <Kpi label="Written off · EGP" value={egp(t.writtenOff)} hint={`of ${egp(t.billed)} billed`} />
      </div>
      <Card className="space-y-3">
        <SectionTitle title="Collected of what was billed, by month of issue" description="An older month has had longer to be paid." />
        <Columns items={r.months.map((m) => ({ label: short(m.label), value: m.rate ?? 0 }))} format={(v) => `${v}%`} />
      </Card>
      <Card className="overflow-hidden p-0">
        <Table aria-label="Collection rate by month" data-testid="collection-table">
          <THead>
            <TR>
              <TH>Month issued</TH>
              <TH className="hidden text-right lg:table-cell">Invoices</TH>
              <TH className="text-right">Billed</TH>
              <TH className="hidden text-right sm:table-cell">Collected</TH>
              <TH className="hidden text-right md:table-cell">Written off</TH>
              <TH className="hidden text-right lg:table-cell">Payers owe</TH>
              <TH className="hidden text-right md:table-cell">Patients owe</TH>
              <TH className="text-right">Rate</TH>
            </TR>
          </THead>
          <TBody>
            {[...r.months, { month: "total", label: "Total", ...t }].map((m) => (
              <TR key={m.month} className={m.month === "total" ? "bg-muted/40 font-medium" : undefined}>
                <TD className="whitespace-nowrap">{m.label}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(m.invoices)}</TD>
                <TD className={NUM}>{formatNumber(m.billed)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(m.collected)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(m.writtenOff)}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(m.payersOwe)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(m.patientsOwe)}</TD>
                <TD className={cn(NUM, "font-medium")}>{pct(m.rate)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

export async function Acceptance({ scope }: { scope: ReportScope }) {
  const r = await acceptanceReport(scope);
  const t = r.totals;
  return (
    <div className="space-y-4" data-testid="acceptance-report">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Acceptance" value={pct(t.rate)} tone="accent" hint={`${formatNumber(t.accepted)} of ${formatNumber(t.presented)} plans given`} />
        <Kpi label="By value" value={pct(t.valueRate)} hint={`${egp(t.acceptedValue)} of ${egp(t.presentedValue)} EGP`} />
        <Kpi label="Declined or expired" value={formatNumber(t.declined + t.expired)} hint={`${formatNumber(t.declined)} declined, ${formatNumber(t.expired)} expired`} />
        <Kpi label="Waiting" value={formatNumber(t.open)} hint="given, still valid, no answer yet" />
      </div>
      <Card className="overflow-hidden p-0">
        <Table aria-label="Case acceptance by month" data-testid="acceptance-table">
          <THead>
            <TR>
              <TH>Month given</TH>
              <TH className="text-right">Given</TH>
              <TH className="hidden text-right sm:table-cell">Accepted</TH>
              <TH className="hidden text-right md:table-cell">Declined</TH>
              <TH className="hidden text-right md:table-cell">Expired</TH>
              <TH className="hidden text-right lg:table-cell">Waiting</TH>
              <TH className="hidden text-right lg:table-cell">Value given</TH>
              <TH className="hidden text-right sm:table-cell">Value accepted</TH>
              <TH className="text-right">Rate</TH>
            </TR>
          </THead>
          <TBody>
            {[...r.months, { month: "total", label: "Total", ...t }].map((m) => (
              <TR key={m.month} className={m.month === "total" ? "bg-muted/40 font-medium" : undefined}>
                <TD className="whitespace-nowrap">{m.label}</TD>
                <TD className={NUM}>{formatNumber(m.presented)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(m.accepted)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(m.declined)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(m.expired)}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(m.open)}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(m.presentedValue)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(m.acceptedValue)}</TD>
                <TD className={cn(NUM, "font-medium")}>{pct(m.rate)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <Card className="overflow-hidden p-0">
        <div className="p-4 pb-2 sm:p-5 sm:pb-2">
          <SectionTitle title="By doctor" description="The plans each doctor gave in these months." />
        </div>
        {r.byDoctor.length ? (
          <Table aria-label="Case acceptance by doctor" data-testid="acceptance-doctors">
            <THead>
              <TR>
                <TH>Doctor</TH>
                <TH className="text-right">Given</TH>
                <TH className="hidden text-right sm:table-cell">Accepted</TH>
                <TH className="hidden text-right md:table-cell">Value accepted</TH>
                <TH className="text-right">Rate</TH>
                <TH className="hidden text-right sm:table-cell">By value</TH>
              </TR>
            </THead>
            <TBody>
              {r.byDoctor.map((d) => (
                <TR key={d.doctorId ?? "none"}>
                  <TD>{d.name}</TD>
                  <TD className={NUM}>{formatNumber(d.presented)}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(d.accepted)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(d.acceptedValue)}</TD>
                  <TD className={cn(NUM, "font-medium")}>{pct(d.rate)}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{pct(d.valueRate)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-4 pt-0">
            <EmptyState title="No treatment plan given in these months" />
          </div>
        )}
      </Card>
    </div>
  );
}

function InstalmentList({ lines, tz, label, testId }: { lines: InstalmentLine[]; tz: string; label: string; testId: string }) {
  const day = (key: string) => formatDateInTz(fromDateKey(key, tz)!, tz, { day: "numeric", month: "short", year: "numeric" });
  return (
    <Table aria-label={label} data-testid={testId}>
      <THead>
        <TR>
          <TH>Patient and plan</TH>
          <TH className="hidden sm:table-cell">Due</TH>
          <TH className="text-right">Owed</TH>
        </TR>
      </THead>
      <TBody>
        {lines.slice(0, 20).map((l) => (
          <TR key={`${l.planId}-${l.number}`}>
            <TD>
              <Link href={`/dashboard/patients/${l.patientId}`} className="font-medium underline-offset-2 hover:underline">
                {l.patientName}
              </Link>
              <span className="block text-xs text-muted-foreground">
                {l.title} · {l.number ? `instalment ${l.number}` : "down payment"}
                <span className="sm:hidden"> · {day(l.dueKey)}</span>
              </span>
            </TD>
            <TD className="hidden whitespace-nowrap text-sm sm:table-cell">
              {day(l.dueKey)}
              {l.daysLate ? <span className="block text-xs text-danger">{l.daysLate} days late</span> : <span className="block text-xs text-muted-foreground">{INSTALMENT_STATE_LABELS[l.state]}</span>}
            </TD>
            <TD className={cn(NUM, "font-medium", l.daysLate > 0 && "text-danger")}>{formatNumber(l.owed)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export async function InstalmentsDue({ scope }: { scope: ReportScope }) {
  const r = await instalmentsDueReport(scope);
  const t = r.totals;
  const next30 = r.next.reduce((s, l) => s + l.owed, 0);
  const lateNow = r.late.reduce((s, l) => s + l.owed, 0);
  return (
    <div className="space-y-4" data-testid="instalments-report">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Left to collect · EGP" value={egp(r.leftToCollect)} tone="accent" hint={`on ${r.activePlans} active plan${r.activePlans === 1 ? "" : "s"}`} />
        <Kpi label="Late now · EGP" value={egp(lateNow)} tone={lateNow ? "warning" : "default"} hint={`${r.late.length} instalment${r.late.length === 1 ? " past its" : "s past their"} day`} />
        <Kpi label="Next 30 days · EGP" value={egp(next30)} hint={`${r.next.length} instalment${r.next.length === 1 ? "" : "s"} falling due`} />
        <Kpi label="Paid in these months · EGP" value={egp(t.paid)} hint={`of ${egp(t.due)} due`} />
      </div>
      <Card className="overflow-hidden p-0">
        <Table aria-label="Instalments due by month" data-testid="instalments-table">
          <THead>
            <TR>
              <TH>Month</TH>
              <TH className="hidden text-right sm:table-cell">Instalments</TH>
              <TH className="text-right">Due</TH>
              <TH className="hidden text-right sm:table-cell">Paid</TH>
              <TH className="text-right">Still owed</TH>
              <TH className="hidden text-right md:table-cell">Late</TH>
            </TR>
          </THead>
          <TBody>
            {r.months.map((m) => (
              <TR key={m.month} className={m.ahead ? "text-muted-foreground" : undefined}>
                <TD className="whitespace-nowrap">
                  {m.label}
                  {m.ahead ? <span className="ms-2 text-xs">to come</span> : null}
                </TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(m.instalments)}</TD>
                <TD className={NUM}>{formatNumber(m.due)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(m.paid)}</TD>
                <TD className={cn(NUM, "font-medium")}>{formatNumber(m.owed)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell", m.late > 0 && "text-danger")}>{formatNumber(m.late)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">The months shown and the next {INSTALMENT_MONTHS_AHEAD}; a stopped plan counts only what was paid.</p>
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <SectionTitle title="Late" description="Still owed after their day, the latest first." />
          </div>
          {r.late.length ? <InstalmentList lines={r.late} tz={scope.timezone} label="Late instalments" testId="instalments-late" /> : <div className="p-4 pt-0"><EmptyState title="Nothing late" /></div>}
        </Card>
        <Card className="overflow-hidden p-0">
          <div className="p-4 pb-2 sm:p-5 sm:pb-2">
            <SectionTitle title="Falling due in the next 30 days" description="The soonest first." />
          </div>
          {r.next.length ? <InstalmentList lines={r.next} tz={scope.timezone} label="Instalments falling due" testId="instalments-next" /> : <div className="p-4 pt-0"><EmptyState title="Nothing falls due in the next 30 days" /></div>}
        </Card>
      </div>
    </div>
  );
}

export async function Sources({ scope }: { scope: ReportScope }) {
  const r = await sourcesReport(scope);
  const t = r.totals;
  return (
    <div className="space-y-4" data-testid="sources-report">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Work done · EGP" value={egp(t.production)} tone="accent" hint={`for ${formatNumber(t.seen)} patients seen`} />
        <Kpi label="New patients" value={formatNumber(t.newPatients)} hint="registered in these months" />
        <Kpi label="Campaign cost · EGP" value={egp(t.cost)} hint="spread over the days each ran" />
        <Kpi label="Money in · EGP" value={egp(t.collected)} hint="from these patients, and their payers" />
      </div>
      <Card className="space-y-3">
        <SectionTitle title="Work done by source" description="Where the patients first came from." />
        {r.rows.some((s) => s.production > 0) ? <HBars items={r.rows.filter((s) => s.production > 0).map((s) => ({ label: s.label, value: s.production }))} format={(v) => formatNumber(v)} labelWidth="w-32 sm:w-44" /> : <EmptyState title="No work done in these months" />}
      </Card>
      <Card className="overflow-hidden p-0">
        <Table aria-label="Revenue by marketing source" data-testid="sources-table">
          <THead>
            <TR>
              <TH>Source</TH>
              <TH className="hidden text-right md:table-cell">Patients</TH>
              <TH className="hidden text-right sm:table-cell">New</TH>
              <TH className="text-right">Work done</TH>
              <TH className="hidden text-right lg:table-cell">Money in</TH>
              <TH className="hidden text-right md:table-cell">Cost</TH>
              <TH className="hidden text-right lg:table-cell">Per new patient</TH>
              <TH className="hidden text-right sm:table-cell">Per EGP of cost</TH>
            </TR>
          </THead>
          <TBody>
            {r.rows.map((s) => (
              <TR key={s.source}>
                <TD>
                  {s.label}
                  <span className="block text-xs text-muted-foreground md:hidden">
                    {formatNumber(s.patients)} patients{s.cost ? ` · cost ${formatNumber(s.cost)}` : ""}
                  </span>
                </TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(s.patients)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(s.newPatients)}</TD>
                <TD className={cn(NUM, "font-medium")}>{formatNumber(s.production)}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(s.collected)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{s.cost ? formatNumber(s.cost) : "—"}</TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{s.perNewPatient === null ? "—" : formatNumber(s.perNewPatient)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{s.returnOnCost === null ? "—" : `${s.returnOnCost.toLocaleString("en-US")}×`}</TD>
              </TR>
            ))}
            <TR className="bg-muted/40 font-medium">
              <TD>Total</TD>
              <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(t.patients)}</TD>
              <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(t.newPatients)}</TD>
              <TD className={NUM}>{formatNumber(t.production)}</TD>
              <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(t.collected)}</TD>
              <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(t.cost)}</TD>
              <TD className={cn(NUM, "hidden lg:table-cell")} />
              <TD className={cn(NUM, "hidden sm:table-cell")} />
            </TR>
          </TBody>
        </Table>
      </Card>
      <Card className="overflow-hidden p-0">
        <div className="p-4 pb-2 sm:p-5 sm:pb-2">
          <SectionTitle title="By campaign" description="Patients whose first lead came from the campaign, and what it cost in these months." />
        </div>
        {r.campaigns.length ? (
          <Table aria-label="Revenue by campaign" data-testid="sources-campaigns">
            <THead>
              <TR>
                <TH>Campaign</TH>
                <TH className="hidden text-right sm:table-cell">Patients</TH>
                <TH className="text-right">Work done</TH>
                <TH className="hidden text-right md:table-cell">Cost</TH>
                <TH className="hidden text-right sm:table-cell">Per EGP of cost</TH>
              </TR>
            </THead>
            <TBody>
              {r.campaigns.map((c) => (
                <TR key={c.campaignId}>
                  <TD>
                    {c.name}
                    <Badge className="ms-2 hidden md:inline-flex">{r.rows.find((s) => s.source === c.source)?.label ?? c.source}</Badge>
                  </TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(c.patients)}</TD>
                  <TD className={cn(NUM, "font-medium")}>{formatNumber(c.production)}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{c.cost ? formatNumber(c.cost) : "—"}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{c.returnOnCost === null ? "—" : `${c.returnOnCost.toLocaleString("en-US")}×`}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-4 pt-0">
            <EmptyState title="No campaign brought a patient or cost anything in these months" />
          </div>
        )}
      </Card>
    </div>
  );
}
