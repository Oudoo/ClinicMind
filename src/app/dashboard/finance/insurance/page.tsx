import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { dateKeyInTz, formatDateInTz } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { INSURANCE_VIEWS, type InsuranceView } from "@/modules/insurance/constants";
import { insuranceKpis, listPayers, owedByPayer } from "@/modules/insurance/payers";
import { listBatches, listClaims } from "@/modules/insurance/batches";
import { listApprovals } from "@/modules/insurance/covers";
import { Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Badge } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { AgingTable, ApprovalStatusBadge, ClaimStatusBadge } from "@/components/clinicmind/insurance-shared";
import { AnswerApprovalButton, PayerButton, RecordAnswerButton, SendClaimsButton } from "@/components/clinicmind/insurance-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Insurance" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const VIEW_LABELS: Record<InsuranceView, string> = { owed: "Owed", open: "To send", sent: "Sent", approvals: "Approvals", payers: "Payers" };
const NUM = "whitespace-nowrap text-right font-mono tabular-nums";

/**
 * `/dashboard/finance/insurance` — insurers and companies (`insurance:read`):
 * what each owes by how long ago it was claimed, the claims not sent yet (a
 * batch for each payer, by the desk), the batches sent and what is still owed
 * on them (the owner records the payer's answer), the approvals waiting for an
 * answer, and the payers with their contracts.
 */
export default async function InsurancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "insurance:read")) return <NotForRole title="Not available for your role" hint="Insurance is for the front desk, the nurses and the clinic owner." />;
  const asked = first(sp.view);
  const view: InsuranceView = asked && (INSURANCE_VIEWS as readonly string[]).includes(asked) ? (asked as InsuranceView) : "owed";
  const canWrite = can(ctx.role, "insurance:write");
  const canManage = can(ctx.role, "insurance:manage");
  const timezone = await getTenantTimezone(ctx.tenantId);
  const now = new Date();
  const today = dateKeyInTz(now, timezone);
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });
  const [kpis, aging, open, batches, approvals, payers] = await Promise.all([
    insuranceKpis(ctx.tenantId, now),
    view === "owed" ? owedByPayer(ctx.tenantId, now) : null,
    view === "open" ? listClaims(ctx.tenantId, { view: "open", pageSize: 200 }, now) : null,
    view === "sent" ? listBatches(ctx.tenantId, {}, now) : null,
    view === "approvals" ? listApprovals(ctx.tenantId, { waiting: true, now }) : null,
    view === "payers" ? listPayers(ctx.tenantId, { archived: true }) : null,
  ]);
  const counts: Partial<Record<InsuranceView, number>> = { open: kpis.toSend.claims, approvals: kpis.approvalsWaiting };

  // The claims to send, by payer.
  const toSend = open
    ? [...open.rows.reduce((m, c) => m.set(c.payerId, [...(m.get(c.payerId) ?? []), c]), new Map<string, typeof open.rows>()).values()].map((rows) => ({
        payerId: rows[0]!.payerId,
        payerName: rows[0]!.payerName,
        rows,
        amount: rows.reduce((s, c) => s + c.owed, 0),
      }))
    : [];

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Insurance and companies"
        description="Covered patients' invoices claim the payer's share when they are issued. Claims go to each payer in a batch; its answer pays them or refuses them, and what it refuses the patient owes again unless written off."
        action={canManage ? <PayerButton /> : undefined}
      />

      <Bento>
        <Metric label="Owed by payers" value={`${formatNumber(kpis.owed)}`} hint="EGP on claims not answered yet" tone="accent" />
        <Metric label="Late" value={formatNumber(kpis.overdue)} hint="EGP past the payers' days to pay" tone={kpis.overdue ? "warning" : "default"} />
        <Metric label="To send" value={kpis.toSend.claims} hint={`${formatNumber(kpis.toSend.amount)} EGP not sent yet`} tone={kpis.toSend.claims ? "warning" : "default"} />
        <Metric label="Approvals waiting" value={kpis.approvalsWaiting} hint="Asked of a payer, no answer yet" />
      </Bento>

      <nav aria-label="Insurance lists" className="-mx-1 overflow-x-auto px-1">
        <ul className="inline-flex h-auto min-w-max items-center gap-0.5 rounded-lg bg-muted p-1 sm:gap-1">
          {INSURANCE_VIEWS.map((v) => {
            const current = v === view;
            const count = counts[v];
            return (
              <li key={v}>
                <Link
                  href={`/dashboard/finance/insurance?view=${v}`}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                    current ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {VIEW_LABELS[v]}
                  {count ? <span className="rounded-md bg-card px-1.5 font-mono text-[10px] text-muted-foreground">{count}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {aging ? (
        <Card className="overflow-hidden p-0">
          {aging.rows.length ? <AgingTable aging={aging} /> : <div className="p-6"><EmptyState title="No payer owes anything" hint="Claims show here once covered patients' invoices are issued." /></div>}
        </Card>
      ) : null}

      {open ? (
        toSend.length ? (
          <div className="space-y-4">
            {toSend.map((g) => (
              <Card key={g.payerId} className="overflow-hidden p-0" data-testid="to-send">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
                  <div>
                    <Link href={`/dashboard/finance/insurance/payers/${g.payerId}`} className="font-medium underline-offset-2 hover:underline">
                      {g.payerName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {g.rows.length} claim{g.rows.length === 1 ? "" : "s"} · {formatNumber(g.amount)} EGP
                    </p>
                  </div>
                  {canWrite ? <SendClaimsButton payerId={g.payerId} payerName={g.payerName} claims={g.rows.length} amount={g.amount} today={today} /> : null}
                </div>
                <ClaimTable rows={g.rows} day={day} />
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState title="Nothing to send" hint="A covered patient's invoice makes its claim when it is issued; it waits here until it is sent." />
          </Card>
        )
      ) : null}

      {batches ? (
        <Card className="overflow-hidden p-0">
          {batches.length ? (
            <Table aria-label="Batches sent" data-testid="batch-table">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Batch</TH>
                  <TH className="hidden md:table-cell">Sent</TH>
                  <TH className="hidden text-right sm:table-cell">Claimed</TH>
                  <TH className="hidden text-right lg:table-cell">Paid</TH>
                  <TH className="hidden text-right lg:table-cell">Refused</TH>
                  <TH className="text-right">Owed</TH>
                  {canManage ? <TH className="hidden text-right sm:table-cell">Act</TH> : null}
                </TR>
              </THead>
              <TBody>
                {batches.map((b) => (
                  <TR key={b.id}>
                    <TD>
                      <Link href={`/dashboard/finance/insurance/batches/${b.id}`} className="font-mono text-sm underline-offset-2 hover:underline">
                        {b.number}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {b.payerName} · {b.claims} claim{b.claims === 1 ? "" : "s"}
                      </span>
                      <span className="text-xs text-muted-foreground md:hidden">Sent {day(b.sentAt)}</span>
                    </TD>
                    <TD className="hidden whitespace-nowrap text-xs md:table-cell">
                      {day(b.sentAt)}
                      <span className={cn("block", b.overdue ? "text-danger" : "text-muted-foreground")}>{b.owed > 0 ? `${b.overdue ? "Was due" : "Due by"} ${day(b.dueBy)}` : "Answered"}</span>
                    </TD>
                    <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(b.amount)}</TD>
                    <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(b.paid)}</TD>
                    <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(b.refused)}</TD>
                    <TD className={cn(NUM, "font-medium", b.overdue && "text-danger")}>{formatNumber(b.owed)}</TD>
                    {canManage ? (
                      <TD className="hidden text-right sm:table-cell">{b.owed > 0 ? <RecordAnswerButton payerId={b.payerId} payerName={b.payerName} batchId={b.id} today={today} label="Answer" /> : null}</TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <div className="p-6">
              <EmptyState title="No batch sent yet" hint="Send the claims of a payer from To send." />
            </div>
          )}
        </Card>
      ) : null}

      {approvals ? (
        <Card className="overflow-hidden p-0">
          {approvals.length ? (
            <Table aria-label="Approvals waiting" data-testid="approval-table">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Patient and what for</TH>
                  <TH className="hidden md:table-cell">Asked of</TH>
                  <TH className="hidden text-right sm:table-cell">Amount</TH>
                  <TH className="hidden sm:table-cell">Asked on</TH>
                  {canWrite ? <TH className="text-right">Act</TH> : null}
                </TR>
              </THead>
              <TBody>
                {approvals.map((a) => (
                  <TR key={a.id}>
                    <TD>
                      <Link href={`/dashboard/patients/${a.patientId}`} className="font-medium underline-offset-2 hover:underline">
                        {a.patientName}
                      </Link>
                      <span className="block text-sm">{a.description}</span>
                      <span className="block text-xs text-muted-foreground md:hidden">
                        {a.payerName} · {formatNumber(a.amount)} EGP
                      </span>
                    </TD>
                    <TD className="hidden text-sm md:table-cell">
                      {a.payerName}
                      <span className="block font-mono text-xs text-muted-foreground">{a.memberNumber}</span>
                    </TD>
                    <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(a.amount)}</TD>
                    <TD className="hidden whitespace-nowrap text-xs sm:table-cell">
                      <ApprovalStatusBadge status={a.status} label={a.statusLabel} />
                      <span className="block text-muted-foreground">{day(a.requestedAt)}</span>
                    </TD>
                    {canWrite ? (
                      <TD className="text-right">
                        <AnswerApprovalButton approval={a} today={today} />
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <div className="p-6">
              <EmptyState title="No approval waiting" hint="Ask for one from the patient's page when the work needs it; record the payer's answer here." />
            </div>
          )}
        </Card>
      ) : null}

      {payers ? (
        <Card className="overflow-hidden p-0">
          {payers.length ? (
            <Table aria-label="Payers" data-testid="payer-table">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Payer</TH>
                  <TH className="hidden md:table-cell">Contract today</TH>
                  <TH className="hidden text-right sm:table-cell">Members</TH>
                  <TH className="text-right">Owed</TH>
                </TR>
              </THead>
              <TBody>
                {payers.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <Link href={`/dashboard/finance/insurance/payers/${p.id}`} className="font-medium underline-offset-2 hover:underline">
                        {p.name}
                      </Link>
                      {p.archived ? <Badge className="ml-2">No longer used</Badge> : null}
                      <span className="block text-xs text-muted-foreground">
                        {p.kindLabel} · pays in {p.paymentDays} days
                      </span>
                    </TD>
                    <TD className="hidden text-sm md:table-cell">
                      {p.contract ? (
                        <>
                          {p.contract.discountPct}% off · the patient pays {p.contract.copayPct}%
                          <span className="block text-xs text-muted-foreground">
                            {p.contract.annualLimit ? `${formatNumber(p.contract.annualLimit)} EGP a year` : "No yearly limit"}
                            {p.contract.approvalAbove !== null ? ` · approval above ${formatNumber(p.contract.approvalAbove)}` : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-warning">No contract today</span>
                      )}
                    </TD>
                    <TD className={cn(NUM, "hidden sm:table-cell")}>{p.members}</TD>
                    <TD className={cn(NUM, "font-medium")}>{formatNumber(p.owed)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <div className="p-6">
              <EmptyState title="No payer yet" hint={canManage ? "Add an insurer or a company with New payer, then its contract." : "The owner adds insurers and companies and their contracts."} />
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}

function ClaimTable({ rows, day }: { rows: Awaited<ReturnType<typeof listClaims>>["rows"]; day: (iso: string) => string }) {
  return (
    <Table aria-label="Claims">
      <THead>
        <TR className="hover:bg-transparent">
          <TH>Claim</TH>
          <TH className="hidden md:table-cell">Invoice</TH>
          <TH className="hidden sm:table-cell">Made</TH>
          <TH className="text-right">Claimed</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((c) => (
          <TR key={c.id}>
            <TD>
              <Link href={`/dashboard/finance/insurance/claims/${c.id}`} className="font-mono text-sm underline-offset-2 hover:underline">
                {c.number}
              </Link>{" "}
              <ClaimStatusBadge status={c.status} label={c.statusLabel} overdue={c.overdue} />
              <span className="block text-sm">
                <Link href={`/dashboard/patients/${c.patientId}`} className="underline-offset-2 hover:underline">
                  {c.patientName}
                </Link>{" "}
                <span className="font-mono text-xs text-muted-foreground">{c.memberNumber}</span>
              </span>
            </TD>
            <TD className="hidden font-mono text-xs md:table-cell">
              <Link href={`/dashboard/finance/invoices/${c.invoiceId}`} className="underline-offset-2 hover:underline">
                {c.invoiceNumber}
              </Link>
            </TD>
            <TD className="hidden whitespace-nowrap text-xs sm:table-cell">{day(c.claimedAt)}</TD>
            <TD className={NUM}>{formatNumber(c.owed)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
