import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { dateKeyInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { payOverview } from "@/modules/finance/doctor-pay";
import { isMonthKey, monthLabel, monthOfKey, shiftMonth } from "@/modules/finance/doctor-pay-calc";
import { Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { StatementStatusBadge } from "@/components/clinicmind/doctor-pay-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Doctor pay" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/dashboard/finance/doctor-pay` — for the owner (`finance:read`): each
 * paid doctor's statement for a month (last month by default, until it is
 * closed and paid): what their work billed and collected, its costs, what it
 * earned and what is to be paid, and where the statement stands.
 */
export default async function DoctorPayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "finance:read")) {
    return <NotForRole title="Not available for your role" hint="Doctor pay is for the clinic owner. Doctors see their own statements under My pay." />;
  }
  const timezone = await getTenantTimezone(ctx.tenantId);
  const thisMonth = monthOfKey(dateKeyInTz(new Date(), timezone));
  const asked = first(sp.month);
  const month = asked && isMonthKey(asked) && asked <= thisMonth ? asked : shiftMonth(thisMonth, -1);
  const overview = await payOverview(ctx.tenantId, month);
  const rows = overview.rows;
  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const toPay = rows.filter((r) => r.statement.status === "CLOSED").reduce((s, r) => s + r.statement.payable, 0);
  const href = (m: string) => `/dashboard/finance/doctor-pay?month=${m}`;
  const canManage = can(ctx.role, "tenant:manage");

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Doctor pay"
        description="Each doctor's statement for the month under their pay rules: a share of what their work billed or collected, the lab and material costs taken off first, or a fee per session. Close a month once it is over; then mark it paid."
        action={
          canManage ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard/finance/doctor-pay/rules">Pay rules</Link>
            </Button>
          ) : null
        }
      />

      <nav aria-label="Months" className="flex flex-wrap items-center gap-3 text-sm">
        <Link href={href(shiftMonth(month, -1))} className="text-accent underline-offset-2 hover:underline">
          ← {monthLabel(shiftMonth(month, -1))}
        </Link>
        <span className="font-display text-base font-semibold">{overview.monthLabel}</span>
        {month < thisMonth ? (
          <Link href={href(shiftMonth(month, 1))} className="text-accent underline-offset-2 hover:underline">
            {monthLabel(shiftMonth(month, 1))} →
          </Link>
        ) : null}
        {month === thisMonth ? <span className="text-xs text-muted-foreground">So far this month</span> : null}
      </nav>

      <Bento>
        <Metric label="Billed · EGP" value={formatNumber(sum((r) => r.statement.billed))} hint="Their work, after discounts" />
        <Metric label="Collected · EGP" value={formatNumber(sum((r) => r.statement.collected))} hint="Put towards their work in the month" />
        <Metric label="Earned · EGP" value={formatNumber(sum((r) => r.statement.earned))} hint="Under the pay rules, costs taken off" tone="accent" />
        <Metric label="To pay · EGP" value={formatNumber(toPay)} hint={toPay ? "Closed, not marked paid yet" : "Nothing closed is waiting"} tone={toPay ? "warning" : "default"} />
      </Bento>

      <Card className="overflow-hidden p-0">
        {rows.length ? (
          <Table aria-label={`Statements for ${overview.monthLabel}`} data-testid="pay-overview">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Doctor</TH>
                <TH className="hidden text-right md:table-cell">Billed</TH>
                <TH className="hidden text-right md:table-cell">Collected</TH>
                <TH className="hidden text-right lg:table-cell">Costs</TH>
                <TH className="text-right">Earned</TH>
                <TH className="text-right">To pay</TH>
                <TH className="text-right">Statement</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.doctor.id}>
                  <TD>
                    <Link href={`/dashboard/finance/doctor-pay/${r.doctor.id}?month=${month}`} className="font-medium underline-offset-2 hover:underline">
                      {r.doctor.fullName}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {r.rules} rule{r.rules === 1 ? "" : "s"}
                      {r.statement.unruled ? <span className="text-warning"> · {r.statement.unruled} with no rule</span> : null}
                    </div>
                  </TD>
                  <TD className="hidden text-right font-mono tabular-nums md:table-cell">{formatNumber(r.statement.billed)}</TD>
                  <TD className="hidden text-right font-mono tabular-nums md:table-cell">{formatNumber(r.statement.collected)}</TD>
                  <TD className="hidden text-right font-mono tabular-nums lg:table-cell">{formatNumber(r.statement.costs)}</TD>
                  <TD className="text-right font-mono tabular-nums">{formatNumber(r.statement.earned)}</TD>
                  <TD className="text-right font-mono tabular-nums">
                    {formatNumber(r.statement.payable)}
                    {r.statement.carriedForward ? <div className="text-xs text-danger">{formatNumber(-r.statement.carriedForward)} owed back</div> : null}
                  </TD>
                  <TD className="text-right">
                    <StatementStatusBadge status={r.statement.status} payable={r.statement.payable} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title="No doctor's pay is set" hint={canManage ? "Set each doctor's pay rules: their statements start from that month." : "The owner sets each doctor's pay rules."} />
          </div>
        )}
      </Card>
      {overview.withoutRules.length ? (
        <p className="text-sm text-muted-foreground">
          Work this month by {overview.withoutRules.map((d) => d.fullName).join(", ")}, who {overview.withoutRules.length === 1 ? "has" : "have"} no pay rules: {canManage ? <Link href="/dashboard/finance/doctor-pay/rules" className="text-accent underline-offset-2 hover:underline">set them</Link> : "the owner sets them"} to pay for it.
        </p>
      ) : null}
    </div>
  );
}
