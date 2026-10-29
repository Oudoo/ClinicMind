import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, formatDateInTz } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { CATEGORY_LABELS } from "@/modules/finance/constants";
import { getPayer, owedByPayer, type ContractDTO } from "@/modules/insurance/payers";
import { listBatches, listPayerPayments } from "@/modules/insurance/batches";
import { payerMembers } from "@/modules/insurance/covers";
import { Badge, Bento, Card, EmptyState, Metric } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { AgingTable } from "@/components/clinicmind/insurance-shared";
import { ContractButton, PayerButton, RecordAnswerButton, VoidPayerPaymentButton } from "@/components/clinicmind/insurance-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payer" };

const NUM = "whitespace-nowrap text-right font-mono tabular-nums";

/**
 * `/dashboard/finance/insurance/payers/[id]` — one insurer or company: its
 * contract today and the others, what it owes by age, its batches and its
 * answers (the owner records and voids them), and its members.
 */
export default async function PayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "insurance:read")) return <NotForRole title="Not available for your role" hint="Insurance is for the front desk, the nurses and the clinic owner." />;
  const payer = await getPayer(ctx.tenantId, id).catch((err: unknown) => {
    if (err instanceof TenantScopeError) return null;
    throw err;
  });
  if (!payer) notFound();
  const canManage = can(ctx.role, "insurance:manage");
  const timezone = await getTenantTimezone(ctx.tenantId);
  const now = new Date();
  const today = dateKeyInTz(now, timezone);
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });
  const dayKey = (key: string) => formatDateInTz(new Date(`${key}T12:00:00Z`), "UTC", { day: "numeric", month: "short", year: "numeric" });
  const [aging, batches, payments, members, priceItems] = await Promise.all([
    owedByPayer(ctx.tenantId, now),
    listBatches(ctx.tenantId, { payerId: id }, now),
    listPayerPayments(ctx.tenantId, { payerId: id }),
    payerMembers(ctx.tenantId, id, now),
    canManage ? db.priceItem.findMany({ where: { tenantId: ctx.tenantId, active: true }, orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, category: true } }) : [],
  ]);
  const row = aging.rows.find((r) => r.payerId === id);
  const others = payer.contracts.filter((c) => !c.current);

  return (
    <div className="space-y-6" data-testid="payer-page">
      <div className="text-sm">
        <Link href="/dashboard/finance/insurance?view=payers" className="text-accent underline-offset-2 hover:underline">
          ← Insurance
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight">{payer.name}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {[payer.kindLabel, `pays a batch in ${payer.paymentDays} days`, payer.contactName, payer.phone, payer.email].filter(Boolean).join(" · ")}
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {payer.owed > 0 ? <RecordAnswerButton payerId={payer.id} payerName={payer.name} today={today} /> : null}
            <PayerButton payer={payer} />
          </div>
        ) : null}
      </div>
      {payer.archived ? <Badge>No longer works with the clinic</Badge> : null}

      <Bento>
        <Metric label="Owed" value={formatNumber(payer.owed)} hint="EGP on its claims" tone="accent" />
        <Metric label="Late" value={formatNumber(row?.overdue ?? 0)} hint={`EGP past its ${payer.paymentDays} days`} tone={row?.overdue ? "warning" : "default"} />
        <Metric label="Not sent yet" value={formatNumber(payer.toSend)} hint="EGP on claims to send" />
        <Metric label="Members" value={payer.members} hint="Covered today" />
      </Bento>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3" data-testid="payer-contract">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-semibold">The contract today</h3>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                {payer.contract ? <ContractButton payerId={payer.id} today={today} contract={payer.contract} priceItems={priceItems} /> : null}
                <ContractButton payerId={payer.id} today={today} priceItems={priceItems} label={payer.contract ? "A new contract" : "Add the contract"} />
              </div>
            ) : null}
          </div>
          {payer.contract ? <ContractTerms contract={payer.contract} dayKey={dayKey} /> : <p className="text-sm text-warning">No contract in force today: its patients' work is not claimed.</p>}
          {others.length ? (
            <div className="space-y-1 border-t border-border pt-3">
              <p className="data-label">Other contracts</p>
              <ul className="space-y-1 text-sm">
                {others.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {dayKey(c.validFrom)} – {c.validTo ? dayKey(c.validTo) : "open"}: {c.discountPct}% off, the patient pays {c.copayPct}%
                    </span>
                    {canManage ? <ContractButton payerId={payer.id} today={today} contract={c} priceItems={priceItems} label="Edit" /> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
        <Card className="overflow-hidden p-0">
          <div className="p-4 pb-2">
            <h3 className="font-display text-base font-semibold">Owed by age</h3>
          </div>
          {row ? <AgingTable aging={{ rows: [row], totals: { notSent: row.notSent, buckets: row.buckets, total: row.total, overdue: row.overdue, claims: row.claims } }} linkPayers={false} /> : <p className="px-4 pb-4 text-sm text-muted-foreground">It owes nothing.</p>}
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="p-4 pb-2">
          <h3 className="font-display text-base font-semibold">Batches</h3>
        </div>
        {batches.length ? (
          <Table aria-label="Batches" data-testid="payer-batches">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Batch</TH>
                <TH className="hidden sm:table-cell">Sent</TH>
                <TH className="hidden text-right md:table-cell">Claimed</TH>
                <TH className="text-right">Owed</TH>
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
                      {b.claims} claim{b.claims === 1 ? "" : "s"} · {b.clinicName}
                    </span>
                  </TD>
                  <TD className="hidden whitespace-nowrap text-xs sm:table-cell">
                    {day(b.sentAt)}
                    <span className={cn("block", b.overdue ? "text-danger" : "text-muted-foreground")}>{b.owed > 0 ? `${b.overdue ? "Was due" : "Due by"} ${day(b.dueBy)}` : "Answered"}</span>
                  </TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(b.amount)}</TD>
                  <TD className={cn(NUM, "font-medium", b.overdue && "text-danger")}>{formatNumber(b.owed)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-4 pt-0">
            <EmptyState title="No batch sent yet" hint="Its claims are sent from Insurance › To send." />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="p-4 pb-2">
          <h3 className="font-display text-base font-semibold">Its answers</h3>
        </div>
        {payments.length ? (
          <Table aria-label="The payer's answers" data-testid="payer-payments">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Paid on</TH>
                <TH className="hidden sm:table-cell">How</TH>
                <TH className="hidden text-right md:table-cell">Refused</TH>
                <TH className="text-right">Paid</TH>
                {canManage ? <TH className="text-right">Act</TH> : null}
              </TR>
            </THead>
            <TBody>
              {payments.map((p) => (
                <TR key={p.id} className={cn(p.voided && "text-muted-foreground line-through")}>
                  <TD>
                    <span className="whitespace-nowrap">{day(p.paidAt)}</span>
                    <span className="block text-xs text-muted-foreground no-underline">
                      {[p.batchNumber, p.reference].filter(Boolean).join(" · ") || "—"}
                      {p.voided ? ` · voided: ${p.voidReason}` : ""}
                    </span>
                  </TD>
                  <TD className="hidden text-sm sm:table-cell">{p.methodLabel}</TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(p.refused)}</TD>
                  <TD className={cn(NUM, "font-medium")}>{formatNumber(p.amount)}</TD>
                  {canManage ? <TD className="text-right">{p.voided ? null : <VoidPayerPaymentButton paymentId={p.id} label={`the answer of ${day(p.paidAt)}`} />}</TD> : null}
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-4 pt-0">
            <EmptyState title="No answer yet" hint="The owner records what the payer paid and refused when its remittance comes." />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="p-4 pb-2">
          <h3 className="font-display text-base font-semibold">Members</h3>
        </div>
        {members.length ? (
          <Table aria-label="Members" data-testid="payer-members">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Patient</TH>
                <TH className="hidden sm:table-cell">Card</TH>
                <TH className="text-right">Valid</TH>
              </TR>
            </THead>
            <TBody>
              {members.map((m) => (
                <TR key={m.coverId}>
                  <TD>
                    <Link href={`/dashboard/patients/${m.patientId}`} className="font-medium underline-offset-2 hover:underline">
                      {m.patientName}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{m.relationLabel}</span>
                  </TD>
                  <TD className="hidden text-sm sm:table-cell">
                    <span className="font-mono">{m.memberNumber}</span>
                    {m.plan ? <span className="block text-xs text-muted-foreground">{m.plan}</span> : null}
                  </TD>
                  <TD className="whitespace-nowrap text-right text-xs">
                    {m.active ? <Badge tone="success">Covered</Badge> : <Badge>Not today</Badge>}
                    <span className="block text-muted-foreground">
                      {dayKey(m.validFrom)}
                      {m.validTo ? ` – ${dayKey(m.validTo)}` : " on"}
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-4 pt-0">
            <EmptyState title="No member yet" hint="Add a cover from a patient's page." />
          </div>
        )}
      </Card>
    </div>
  );
}

function ContractTerms({ contract, dayKey }: { contract: ContractDTO; dayKey: (key: string) => string }) {
  const covered = contract.rules.filter((r) => r.category);
  const items = contract.rules.filter((r) => r.priceItemId);
  return (
    <div className="space-y-2 text-sm">
      <p>
        {dayKey(contract.validFrom)} – {contract.validTo ? dayKey(contract.validTo) : "open"}
        {contract.reference ? <span className="text-muted-foreground"> · no. {contract.reference}</span> : null}
      </p>
      <dl className="grid grid-cols-2 gap-2 rounded-lg bg-muted/60 p-3">
        <div>
          <dt className="data-label">Off our prices</dt>
          <dd className="font-mono tabular-nums">{contract.discountPct}%</dd>
        </div>
        <div>
          <dt className="data-label">The patient pays</dt>
          <dd className="font-mono tabular-nums">{contract.copayPct}%</dd>
        </div>
        <div>
          <dt className="data-label">Yearly limit</dt>
          <dd className="font-mono tabular-nums">{contract.annualLimit ? `${formatNumber(contract.annualLimit)} EGP` : "None"}</dd>
        </div>
        <div>
          <dt className="data-label">Approval first</dt>
          <dd className="font-mono tabular-nums">{contract.approvalAbove !== null ? `Above ${formatNumber(contract.approvalAbove)} EGP` : "Where a rule says"}</dd>
        </div>
      </dl>
      <ul className="space-y-0.5">
        {covered.map((r) => (
          <li key={r.category}>
            <span className="font-medium">{CATEGORY_LABELS[r.category as keyof typeof CATEGORY_LABELS] ?? r.category}:</span>{" "}
            {r.covered ? `covered${r.needsApproval ? ", approval first" : ""}${r.copayPct !== null ? `, the patient pays ${r.copayPct}%` : ""}` : "not covered"}
          </li>
        ))}
        {items.map((r) => (
          <li key={r.priceItemId}>
            <span className="font-medium">{r.priceItemName}:</span> {r.covered ? `covered${r.copayPct !== null ? `, the patient pays ${r.copayPct}%` : ""}` : "not covered"}
          </li>
        ))}
        <li className="text-muted-foreground">Anything else: {contract.coveredByDefault ? "covered" : "not covered"}.</li>
      </ul>
    </div>
  );
}
