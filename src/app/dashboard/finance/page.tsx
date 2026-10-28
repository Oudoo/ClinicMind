import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { db, notDeleted } from "@/lib/db";
import { dateKeyInTz, formatDateInTz, formatTimeInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { KIND_LABELS, METHOD_LABELS } from "@/modules/finance/constants";
import { listPayments } from "@/modules/finance/payments";
import { getFinanceSummary, getPatientOutstanding } from "@/modules/finance/service";
import { periodQuery } from "@/modules/reporting/period";
import { parseReportQuery, periodFromQuery } from "@/modules/reporting/query";
import { listReportDoctors } from "@/modules/reporting/service";
import { listTreatments } from "@/modules/treatments/service";
import { listPriceList } from "@/modules/finance/prices";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Columns, DeltaChip, HBars, Kpi } from "@/components/ui/kpi";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { FinanceActions, RecordPaymentForPatient } from "@/components/clinicmind/finance-actions";
import { KIND_TONE, toPriceOptions } from "@/components/clinicmind/finance-shared";
import { PaymentVoidButton } from "@/components/clinicmind/payment-void-button";
import { PeriodPicker } from "@/components/clinicmind/report-period-picker";
import { CsvLink, NotForRole, fmtEgp, fmtPct } from "@/components/clinicmind/report-shared";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const PAGE_SIZE = 15;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** Tile values: whole EGP up to a million, then "1.23M". */
const tile = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : formatNumber(Math.round(v)));
/** Bar labels must stay short on a phone. */
const short = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : Math.abs(v) >= 10_000 ? `${Math.round(v / 1_000)}k` : formatNumber(Math.round(v)));

/**
 * `/dashboard/finance` — revenue from signed procedures, money in and out,
 * outstanding balances with a per-patient drill-down, recent payments, CSV
 * exports, and the front desk's actions (record a payment or a procedure,
 * import the POS export). Owner view (`finance:read`); recording needs
 * `payments:write`.
 */
export default async function FinancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "finance:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Finance" />
        <NotForRole title="Not available for your role" hint="The finance dashboard is for the clinic owner. Payments are recorded from each patient's page." />
      </div>
    );
  }

  const timezone = await getTenantTimezone(ctx.tenantId);
  const query = parseReportQuery(sp);
  const period = periodFromQuery(query, timezone);
  const page = Math.max(1, Number.parseInt(first(sp.page) ?? "1", 10) || 1);
  const owingId = first(sp.owing)?.slice(0, 64) || null;
  const canPay = can(ctx.role, "payments:write");
  const canRecordProcedure = can(ctx.role, "patients:write");
  const canVoid = can(ctx.role, "tenant:manage");

  const [summary, recent, treatments, doctors, owingPatient, owingRows, prices] = await Promise.all([
    getFinanceSummary(ctx.tenantId, period, timezone),
    listPayments(ctx.tenantId, { from: period.from, to: period.to, includeVoided: false, page, pageSize: PAGE_SIZE }),
    listTreatments(ctx.tenantId),
    listReportDoctors(ctx.tenantId),
    owingId ? db.patient.findFirst({ where: { id: owingId, tenantId: ctx.tenantId, ...notDeleted }, select: { id: true, fullName: true, phone: true } }) : Promise.resolve(null),
    owingId ? getPatientOutstanding(ctx.tenantId, owingId) : Promise.resolve([]),
    listPriceList(ctx.tenantId),
  ]);

  const pq = periodQuery(period);
  const exportQuery = new URLSearchParams(pq).toString();
  const previous = { fromKey: dateKeyInTz(period.previous.from, timezone), toKey: dateKeyInTz(new Date(period.previous.to.getTime() - 1), timezone) };
  const date = (d: Date) => formatDateInTz(d, timezone);
  const s = summary;
  const methodTotal = s.methodMix.reduce((t, m) => t + m.amount, 0);
  const revenueTotal = s.byDoctor.reduce((t, d) => t + d.amount, 0);
  const owingHref = (patientId: string | null) => `/dashboard/finance?${new URLSearchParams({ ...pq, ...(patientId ? { owing: patientId } : {}) }).toString()}#outstanding`;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Finance"
        description="Revenue from signed procedures, money in and out, and what patients still owe."
        action={
          <FinanceActions
            timezone={timezone}
            treatments={treatments.map((t) => ({ id: t.id, key: t.key, name: t.name, priceFrom: t.priceFrom, priceTo: t.priceTo, depositAmount: t.depositAmount }))}
            priceItems={toPriceOptions(prices.items)}
            doctors={doctors}
            canPay={canPay}
            canRecordProcedure={canRecordProcedure}
            canRefund={canVoid}
          />
        }
      />

      <PeriodPicker basePath="/dashboard/finance" preset={period.preset} fromKey={period.fromKey} toKey={period.toKey} previous={previous} />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="Revenue · EGP"
          value={tile(s.revenue.current)}
          tone="accent"
          delta={<DeltaChip current={s.revenue.current} previous={s.revenue.previous} goodWhen="up" format={fmtEgp} />}
          hint={`${formatNumber(s.procedures.current)} signed procedures`}
        />
        <Kpi
          label="Collected · EGP"
          value={tile(s.collected.current)}
          delta={<DeltaChip current={s.collected.current} previous={s.collected.previous} goodWhen="up" format={fmtEgp} />}
          hint="all money in, net of refunds"
        />
        <Kpi
          label="Deposits · EGP"
          value={tile(s.deposits.current)}
          delta={<DeltaChip current={s.deposits.current} previous={s.deposits.previous} goodWhen="up" format={fmtEgp} />}
          hint="taken ahead of procedures"
        />
        <Kpi
          label="Refunds · EGP"
          value={tile(s.refunds.current)}
          tone={s.refunds.current > 0 ? "warning" : "default"}
          delta={<DeltaChip current={s.refunds.current} previous={s.refunds.previous} goodWhen="down" format={fmtEgp} />}
          hint="money paid back"
        />
        <Kpi
          label="Consultation fees · EGP"
          value={tile(s.consultationFees.current)}
          delta={<DeltaChip current={s.consultationFees.current} previous={s.consultationFees.previous} goodWhen="up" format={fmtEgp} />}
          hint="their own line, not revenue"
        />
        <Kpi
          label="Outstanding · EGP"
          value={tile(s.outstanding.amount)}
          tone={s.outstanding.amount > 0 ? "warning" : "default"}
          delta={<DeltaChip current={s.outstanding.amount} previous={s.outstanding.previousAmount} goodWhen="down" format={fmtEgp} />}
          hint={`${s.outstanding.patients} patients · ${s.outstanding.procedures} procedures · was ${fmtEgp(s.outstanding.previousAmount)}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="min-w-0 space-y-4">
          <SectionTitle title="Revenue by doctor" description="Signed procedures by the date performed, net of discounts." />
          {s.byDoctor.length ? (
            <>
              <HBars items={s.byDoctor.map((d) => ({ label: d.label, value: d.amount }))} format={short} labelWidth="w-28 sm:w-44" />
              <BreakdownTable rows={s.byDoctor} total={revenueTotal} first="Doctor" />
            </>
          ) : (
            <EmptyState title="No signed procedures in this period" hint="Revenue counts once a clinician signs the procedure." />
          )}
        </Card>
        <Card className="min-w-0 space-y-4">
          <SectionTitle title="Revenue by treatment" description="The same revenue, by what was done." />
          {s.byTreatment.length ? (
            <>
              <HBars items={s.byTreatment.map((d) => ({ label: d.label, value: d.amount }))} format={short} labelWidth="w-28 sm:w-44" />
              <BreakdownTable rows={s.byTreatment} total={revenueTotal} first="Treatment" />
            </>
          ) : (
            <EmptyState title="No signed procedures in this period" />
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="min-w-0 space-y-4 lg:col-span-2">
          <SectionTitle
            title={s.bucketStep === "day" ? "Collected per day" : "Collected per week"}
            description="Money in net of refunds. Grey: the same day of the comparison period."
          />
          {s.collectedPerBucket.some((b) => b.value || b.compare) ? (
            <Columns items={s.collectedPerBucket.map((b) => ({ label: b.label, value: Math.max(0, b.value), compare: b.compare === undefined ? undefined : Math.max(0, b.compare) }))} format={fmtEgp} />
          ) : (
            <EmptyState title="Nothing collected in this period" />
          )}
        </Card>
        <Card className="min-w-0 space-y-4">
          <SectionTitle title="Payment methods" description="Money received, by how it was paid." />
          {s.methodMix.length ? (
            <ul className="space-y-2">
              {s.methodMix
                .slice()
                .sort((a, b) => b.amount - a.amount)
                .map((m) => (
                  <li key={m.method} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span>{m.label}</span>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {fmtEgp(m.amount)} · {fmtPct(methodTotal ? m.amount / methodTotal : null)}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded bg-muted">
                      <div className="h-full rounded bg-accent" style={{ width: `${methodTotal ? Math.round((m.amount / methodTotal) * 100) : 0}%` }} />
                    </div>
                  </li>
                ))}
            </ul>
          ) : (
            <EmptyState title="No payments in this period" />
          )}
        </Card>
      </div>

      <Card id="outstanding" className="min-w-0 space-y-4 p-0">
        <div className="px-4 pt-4 sm:px-6 sm:pt-6">
          <SectionTitle
            title="Outstanding balances"
            description="Signed procedures not yet paid in full, by patient (all time). Open a patient for the procedures and to take a payment."
            action={<Badge tone={s.outstanding.amount ? "warning" : "success"}>{fmtEgp(s.outstanding.amount)}</Badge>}
          />
        </div>
        {owingId ? (
          <div className="mx-4 rounded-lg border border-accent/40 bg-accent-muted/30 p-4 sm:mx-6">
            {owingPatient ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Link href={`/dashboard/patients/${owingPatient.id}`} className="font-medium underline-offset-2 hover:text-accent hover:underline">
                      {owingPatient.fullName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      Owes {fmtEgp(owingRows.reduce((t, r) => t + r.balance, 0))} on {owingRows.length} {owingRows.length === 1 ? "procedure" : "procedures"}
                      {owingPatient.phone ? <span className="font-mono"> · {owingPatient.phone}</span> : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canPay && owingRows.length ? (
                      <RecordPaymentForPatient
                        timezone={timezone}
                        patient={{ id: owingPatient.id, fullName: owingPatient.fullName }}
                        procedures={owingRows.map((r) => ({ id: r.id, balance: r.balance, label: `${r.treatment} · ${date(r.performedAt)} · owes ${formatNumber(r.balance)} EGP` }))}
                      />
                    ) : null}
                    <Link href={owingHref(null)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                      Close
                    </Link>
                  </div>
                </div>
                {owingRows.length ? (
                  <ul className="divide-y divide-border rounded-md border border-border bg-card">
                    {owingRows.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <div className="truncate">{r.treatment}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {date(r.performedAt)} · {fmtEgp(r.net)}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono tabular-nums text-warning">{fmtEgp(r.balance)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-success">Nothing owed any more.</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">That patient was not found.</p>
            )}
          </div>
        ) : null}
        {s.outstandingPatients.length ? (
          <Table className="relative">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Patient</TH>
                <TH className="text-right">Owes</TH>
                <TH className="hidden md:table-cell">Procedures</TH>
                <TH className="hidden lg:table-cell">Oldest procedure</TH>
                <TH className="w-10">
                  <span className="sr-only">Details</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {s.outstandingPatients.map((o) => (
                <TR key={o.patientId} className={o.patientId === owingId ? "bg-accent-muted/40" : undefined}>
                  <TD>
                    <Link href={`/dashboard/patients/${o.patientId}`} className="font-medium underline-offset-2 hover:text-accent hover:underline">
                      {o.fullName}
                    </Link>
                    <div className="text-xs text-muted-foreground lg:hidden">since {date(o.oldestAt)}</div>
                  </TD>
                  <TD className="whitespace-nowrap text-right font-mono tabular-nums text-warning">{fmtEgp(o.amount)}</TD>
                  <TD className="hidden font-mono tabular-nums md:table-cell">{o.procedures}</TD>
                  <TD className="hidden text-sm lg:table-cell">
                    <span className="font-mono text-xs">{date(o.oldestAt)}</span> · {o.oldestTreatment}
                  </TD>
                  <TD>
                    <Link href={owingHref(o.patientId)} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted" aria-label={`Details for ${o.fullName}`} scroll={false}>
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="px-4 pb-6 sm:px-6">
            <EmptyState title="Nothing outstanding" hint="Every signed procedure is paid in full." />
          </div>
        )}
        {s.outstanding.patients > s.outstandingPatients.length ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground sm:px-6">
            The {s.outstandingPatients.length} largest balances of {s.outstanding.patients}.
          </p>
        ) : null}
      </Card>

      <Card className="min-w-0 overflow-hidden p-0">
        <div className="px-4 py-4 sm:px-6">
          <SectionTitle
            title="Payments in this period"
            description="Newest first. Voided payments are left out of every total."
            action={
              <div className="flex flex-wrap justify-end gap-2">
                <CsvLink href={`/api/finance/export?kind=payments&${exportQuery}`} label="Payments CSV" />
                <CsvLink href={`/api/finance/export?kind=procedures&${exportQuery}`} label="Procedures CSV" />
              </div>
            }
          />
        </div>
        {recent.payments.length ? (
          <Table className="relative">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Date</TH>
                <TH>Patient</TH>
                <TH className="hidden md:table-cell">Kind</TH>
                <TH className="hidden md:table-cell">Method</TH>
                <TH className="text-right">Amount</TH>
                <TH className="hidden lg:table-cell">Reference</TH>
                {canVoid ? (
                  <TH className="w-10">
                    <span className="sr-only">Void</span>
                  </TH>
                ) : null}
              </TR>
            </THead>
            <TBody>
              {recent.payments.map((p) => (
                <TR key={p.id}>
                  <TD className="whitespace-nowrap font-mono text-xs">
                    {date(p.paidAt)}
                    <div className="text-muted-foreground">{formatTimeInTz(p.paidAt, timezone)}</div>
                  </TD>
                  <TD>
                    <Link href={`/dashboard/patients/${p.patientId}`} className="underline-offset-2 hover:text-accent hover:underline">
                      {p.patient.fullName}
                    </Link>
                    <div className="text-xs text-muted-foreground md:hidden">
                      {KIND_LABELS[p.kind]} · {METHOD_LABELS[p.method]}
                    </div>
                    {p.procedure ? <div className="hidden text-xs text-muted-foreground md:block">{p.procedure.treatment.name}</div> : null}
                  </TD>
                  <TD className="hidden md:table-cell">
                    <Badge tone={KIND_TONE[p.kind]}>{KIND_LABELS[p.kind]}</Badge>
                    {p.importBatchId ? <Badge className="ml-1">POS</Badge> : null}
                  </TD>
                  <TD className="hidden text-sm md:table-cell">{METHOD_LABELS[p.method]}</TD>
                  <TD className={p.kind === "REFUND" ? "whitespace-nowrap text-right font-mono tabular-nums text-danger" : "whitespace-nowrap text-right font-mono tabular-nums"}>
                    {p.kind === "REFUND" ? "−" : ""}
                    {formatNumber(p.amount)}
                  </TD>
                  <TD className="hidden font-mono text-xs text-muted-foreground lg:table-cell">{p.reference ?? "—"}</TD>
                  {canVoid ? (
                    <TD>
                      <PaymentVoidButton paymentId={p.id} label={`${KIND_LABELS[p.kind]} of ${formatNumber(p.amount)} EGP from ${p.patient.fullName}`} />
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="px-4 pb-6 sm:px-6">
            <EmptyState title="No payments in this period" hint={canPay ? "Record one, or import the day's POS export." : undefined} />
          </div>
        )}
        {recent.total > 0 ? (
          <Pagination page={recent.page} pageSize={recent.pageSize} total={recent.total} basePath="/dashboard/finance" query={pq} className="border-t border-border" />
        ) : null}
      </Card>
    </div>
  );
}

function BreakdownTable({ rows, total, first }: { rows: { id: string; label: string; amount: number; count: number }[]; total: number; first: string }) {
  const cell = "px-3 py-2 sm:px-3";
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table className="relative text-[13px]">
        <THead>
          <TR className="hover:bg-transparent">
            <TH className={cell}>{first}</TH>
            <TH className={`${cell} hidden text-right sm:table-cell`}>Count</TH>
            <TH className={`${cell} text-right`}>Revenue</TH>
            <TH className={`${cell} hidden text-right md:table-cell`}>Share</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.id}>
              <TD className={`${cell} max-w-[9rem] truncate sm:max-w-[12rem]`} title={r.label}>
                {r.label}
              </TD>
              <TD className={`${cell} hidden text-right font-mono tabular-nums sm:table-cell`}>{r.count}</TD>
              <TD className={`${cell} whitespace-nowrap text-right font-mono tabular-nums`}>{fmtEgp(r.amount)}</TD>
              <TD className={`${cell} hidden text-right font-mono tabular-nums text-muted-foreground md:table-cell`}>{fmtPct(total ? r.amount / total : null)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
