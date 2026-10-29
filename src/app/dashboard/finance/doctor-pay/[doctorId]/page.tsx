import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { dateKeyInTz, formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { TenantScopeError } from "@/lib/tenant-scope";
import { getTenantTimezone } from "@/modules/appointments/service";
import { statementFor } from "@/modules/finance/doctor-pay";
import { isMonthKey, monthLabel, monthOfKey, shiftMonth } from "@/modules/finance/doctor-pay-calc";
import { METHOD_LABELS } from "@/modules/finance/constants";
import { Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { PrintButton } from "@/components/clinicmind/invoice-actions";
import { CloseStatementButton, MarkPaidButton, StatementStatusBadge } from "@/components/clinicmind/doctor-pay-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pay statement" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/dashboard/finance/doctor-pay/[doctorId]?month=YYYY-MM` — a doctor's pay
 * statement for a month, for the owner (`finance:read`) and for the doctor
 * themself: each piece of work with what it billed and collected (in the
 * month and to date), its costs, its rule, what it earned to date, what
 * earlier statements paid for it and what this one pays; the month's totals
 * with anything owed back from before. The owner closes a month that is over
 * and marks it paid.
 */
export default async function StatementPage({ params, searchParams }: { params: Promise<{ doctorId: string }>; searchParams: Promise<SearchParams> }) {
  const { doctorId } = await params;
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  const own = ctx.userId === doctorId;
  if (!own && !can(ctx.role, "finance:read")) {
    return <NotForRole title="Not available for your role" hint="A pay statement is for the clinic owner and the doctor it pays." />;
  }
  const timezone = await getTenantTimezone(ctx.tenantId);
  const thisMonth = monthOfKey(dateKeyInTz(new Date(), timezone));
  const asked = first(sp.month);
  const month = asked && isMonthKey(asked) && asked <= thisMonth ? asked : shiftMonth(thisMonth, -1);
  const s = await statementFor(ctx.tenantId, doctorId, month).catch((err: unknown) => {
    if (err instanceof TenantScopeError) return null;
    throw err;
  });
  if (!s) notFound();
  const manage = can(ctx.role, "tenant:manage");
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });
  const short = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short" });
  const lastDay = new Date(new Date(s.periodEnd).getTime() - 1).toISOString();
  const href = (m: string) => `/dashboard/finance/doctor-pay/${doctorId}?month=${m}`;
  const open = s.status === "OPEN";

  return (
    <div className="space-y-6">
      <div className="no-print flex flex-wrap items-center gap-3 text-sm">
        {can(ctx.role, "finance:read") ? (
          <Link href={`/dashboard/finance/doctor-pay?month=${month}`} className="text-accent underline-offset-2 hover:underline">
            ← Doctor pay
          </Link>
        ) : null}
        <Link href={href(shiftMonth(month, -1))} className="text-accent underline-offset-2 hover:underline">
          ← {monthLabel(shiftMonth(month, -1))}
        </Link>
        {month < thisMonth ? (
          <Link href={href(shiftMonth(month, 1))} className="text-accent underline-offset-2 hover:underline">
            {monthLabel(shiftMonth(month, 1))} →
          </Link>
        ) : null}
      </div>

      <SectionTitle
        title={`${s.doctor.fullName} · ${s.monthLabel}`}
        description={
          s.status === "COVERED"
            ? `Paid in the statement of ${monthLabel(s.coveredBy!)}, which covers this month.`
            : !s.payFrom || month < s.payFrom
              ? "No pay was set for this month."
              : `Work and money from ${day(s.periodStart)} to ${day(lastDay)}.${open && !s.ended ? " So far: it changes until the month is closed." : ""}`
        }
        action={
          <div className="no-print flex flex-wrap items-center gap-2">
            <StatementStatusBadge status={s.status} payable={s.payable} />
            {manage && open && s.ended && s.payFrom && month >= s.payFrom ? <CloseStatementButton doctorId={doctorId} doctorName={s.doctor.fullName} month={month} payable={s.payable} carriedForward={s.carriedForward} /> : null}
            {manage && s.status === "CLOSED" && s.payable > 0 ? <MarkPaidButton doctorId={doctorId} doctorName={s.doctor.fullName} month={month} payable={s.payable} timezone={timezone} /> : null}
            {s.status !== "COVERED" ? <PrintButton label="Print" /> : null}
          </div>
        }
      />

      {s.status === "COVERED" ? (
        <Card className="p-6">
          <EmptyState title={`See ${monthLabel(s.coveredBy!)}`} hint="A later month was closed first: its statement paid for this month's work too." />
        </Card>
      ) : (
        <>
          <Bento>
            <Metric label="Billed · EGP" value={formatNumber(s.billed)} hint="Their work in the month, after discounts" />
            <Metric label="Collected · EGP" value={formatNumber(s.collected)} hint="Put towards their work in the month" />
            <Metric label="Costs · EGP" value={formatNumber(s.costs)} hint="Lab and materials that came in" />
            <Metric label="To pay · EGP" value={formatNumber(s.payable)} hint={s.broughtForward ? `${formatNumber(s.earned)} earned, ${formatNumber(-s.broughtForward)} owed back from before` : `Earned in the month`} tone="accent" />
          </Bento>
          {s.carriedForward ? (
            <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
              {formatNumber(-s.carriedForward)} EGP is owed back (work paid for before was cancelled, refunded or cost more): it comes off the next statement.
            </p>
          ) : null}
          {s.unruled ? (
            <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
              {s.unruled} piece{s.unruled === 1 ? "" : "s"} of work {s.unruled === 1 ? "has" : "have"} no rule and earn nothing.{" "}
              {manage ? (
                <Link href="/dashboard/finance/doctor-pay/rules" className="text-accent underline-offset-2 hover:underline">
                  Set a rule
                </Link>
              ) : (
                "The owner sets the rules."
              )}
            </p>
          ) : null}

          <Card className="overflow-hidden p-0">
            {s.lines.length ? (
              <Table aria-label={`Statement of ${s.doctor.fullName} for ${s.monthLabel}`} data-testid="pay-statement">
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Work</TH>
                    <TH className="hidden text-right md:table-cell">Billed</TH>
                    <TH className="hidden text-right md:table-cell">Collected</TH>
                    <TH className="hidden text-right lg:table-cell">Costs</TH>
                    <TH className="hidden text-right lg:table-cell">Earned to date</TH>
                    <TH className="hidden text-right lg:table-cell">Paid before</TH>
                    <TH className="text-right">This month</TH>
                  </TR>
                </THead>
                <TBody>
                  {s.lines.map((l) => (
                    <TR key={l.key}>
                      <TD>
                        <div className="text-xs text-muted-foreground">{short(l.workAt)}</div>
                        <div className="font-medium">{l.patientName}</div>
                        <div className="text-xs">{l.description}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.categoryLabel} · {l.terms ? l.terms.label : <span className="text-warning">no rule</span>}
                          {l.sessionsToDate > 1 ? ` · ${l.sessionsToDate} sessions` : ""}
                        </div>
                      </TD>
                      <TD className="hidden text-right font-mono tabular-nums md:table-cell">
                        {formatNumber(l.billedInMonth)}
                        {l.billedToDate !== l.billedInMonth ? <div className="text-xs text-muted-foreground">{formatNumber(l.billedToDate)} to date</div> : null}
                      </TD>
                      <TD className="hidden text-right font-mono tabular-nums md:table-cell">
                        {formatNumber(l.collectedInMonth)}
                        {l.collectedToDate !== l.collectedInMonth ? <div className="text-xs text-muted-foreground">{formatNumber(l.collectedToDate)} to date</div> : null}
                      </TD>
                      <TD className="hidden text-right font-mono tabular-nums lg:table-cell">{l.costsToDate ? formatNumber(l.costsToDate) : "—"}</TD>
                      <TD className="hidden text-right font-mono tabular-nums lg:table-cell">{formatNumber(l.earnedToDate)}</TD>
                      <TD className="hidden text-right font-mono tabular-nums lg:table-cell">{l.paidBefore ? formatNumber(l.paidBefore) : "—"}</TD>
                      <TD className={`text-right font-mono tabular-nums ${l.due < 0 ? "text-danger" : ""}`}>{formatNumber(l.due)}</TD>
                    </TR>
                  ))}
                  <TR className="hover:bg-transparent">
                    <TD className="font-medium">Earned in the month</TD>
                    <TD className="hidden md:table-cell" />
                    <TD className="hidden md:table-cell" />
                    <TD className="hidden lg:table-cell" />
                    <TD className="hidden lg:table-cell" />
                    <TD className="hidden lg:table-cell" />
                    <TD className="text-right font-mono font-medium tabular-nums">{formatNumber(s.earned)}</TD>
                  </TR>
                </TBody>
              </Table>
            ) : (
              <div className="p-6">
                <EmptyState title="No work this month" hint={!s.payFrom || month < s.payFrom ? "Their pay counts from the month their first rule was set." : "Work billed, money collected and costs for their work appear here."} />
              </div>
            )}
          </Card>
          {s.closedAt ? (
            <p className="text-xs text-muted-foreground">
              Closed {day(s.closedAt)}
              {s.closedBy ? ` by ${s.closedBy}` : ""}
              {s.paidAt ? ` · paid ${day(s.paidAt)}${s.paidMethod ? ` by ${METHOD_LABELS[s.paidMethod].toLowerCase()}` : ""}${s.paidReference ? ` (${s.paidReference})` : ""}${s.paidBy ? `, recorded by ${s.paidBy}` : ""}` : ""}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
