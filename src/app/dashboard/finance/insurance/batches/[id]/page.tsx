import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, formatDateInTz } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { getBatch } from "@/modules/insurance/batches";
import { Bento, Card, Metric } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { ClaimStatusBadge } from "@/components/clinicmind/insurance-shared";
import { RecordAnswerButton, VoidPayerPaymentButton } from "@/components/clinicmind/insurance-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Claims batch" };

const NUM = "whitespace-nowrap text-right font-mono tabular-nums";

/**
 * `/dashboard/finance/insurance/batches/[id]` — claims sent to a payer
 * together: each claim's work with the patient's and the payer's shares, what
 * the payer paid and refused, the file for the payer, and (the owner) its
 * answers.
 */
export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "insurance:read")) return <NotForRole title="Not available for your role" hint="Insurance is for the front desk, the nurses and the clinic owner." />;
  const batch = await getBatch(ctx.tenantId, id).catch((err: unknown) => {
    if (err instanceof TenantScopeError) return null;
    throw err;
  });
  if (!batch) notFound();
  const canManage = can(ctx.role, "insurance:manage");
  const timezone = await getTenantTimezone(ctx.tenantId);
  const today = dateKeyInTz(new Date(), timezone);
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="space-y-6" data-testid="batch-page">
      <div className="text-sm">
        <Link href="/dashboard/finance/insurance?view=sent" className="text-accent underline-offset-2 hover:underline">
          ← Batches sent
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight">Batch {batch.number}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {batch.payerName} · {batch.clinicName} · sent {day(batch.sentAt)}
            {batch.reference ? ` · their ref. ${batch.reference}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/api/claim-batches/${batch.id}/csv`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted" download>
            <Download className="h-4 w-4" aria-hidden="true" />
            The file for the payer
          </a>
          {canManage && batch.owed > 0 ? <RecordAnswerButton payerId={batch.payerId} payerName={batch.payerName} batchId={batch.id} today={today} /> : null}
        </div>
      </div>

      <Bento>
        <Metric label="Claimed" value={formatNumber(batch.amount)} hint={`EGP in ${batch.claims} claim${batch.claims === 1 ? "" : "s"}`} />
        <Metric label="Paid" value={formatNumber(batch.paid)} hint="EGP" tone="accent" />
        <Metric label="Refused" value={formatNumber(batch.refused)} hint="EGP" tone={batch.refused ? "warning" : "default"} />
        <Metric label="Owed" value={formatNumber(batch.owed)} hint={batch.owed > 0 ? `${batch.overdue ? "Was due" : "Due by"} ${day(batch.dueBy)}` : "Answered"} tone={batch.overdue ? "warning" : "default"} />
      </Bento>

      <Card className="overflow-hidden p-0">
        <Table aria-label="Claims in the batch" data-testid="batch-claims">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Claim and work</TH>
              <TH className="hidden text-right md:table-cell">Patient pays</TH>
              <TH className="text-right">Claimed</TH>
              <TH className="hidden text-right sm:table-cell">Paid</TH>
              <TH className="hidden text-right sm:table-cell">Refused</TH>
            </TR>
          </THead>
          <TBody>
            {batch.claimList.flatMap((c) => [
              <TR key={c.id} className="bg-muted/30 hover:bg-muted/30">
                <TD colSpan={5}>
                  <Link href={`/dashboard/finance/insurance/claims/${c.id}`} className="font-mono text-sm underline-offset-2 hover:underline">
                    {c.number}
                  </Link>{" "}
                  <ClaimStatusBadge status={c.status} label={c.statusLabel} overdue={c.overdue} />{" "}
                  <Link href={`/dashboard/patients/${c.patientId}`} className="text-sm underline-offset-2 hover:underline">
                    {c.patientName}
                  </Link>{" "}
                  <span className="font-mono text-xs text-muted-foreground">{c.memberNumber}</span>
                </TD>
              </TR>,
              ...c.lines.map((l) => (
                <TR key={l.id} className={cn(c.status === "CANCELLED" && "text-muted-foreground line-through")}>
                  <TD className="pl-6 text-sm">
                    {l.description}
                    <span className="block text-xs text-muted-foreground">
                      {day(l.workedAt)}
                      {l.approvalNumber ? ` · approval ${l.approvalNumber}` : ""}
                      {l.answers.some((a) => a.reasonLabel) ? ` · refused: ${l.answers.flatMap((a) => (a.reasonLabel ? [a.reasonLabel] : [])).join(", ")}` : ""}
                    </span>
                  </TD>
                  <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(l.patientShare)}</TD>
                  <TD className={NUM}>{formatNumber(l.payerShare)}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(l.paid)}</TD>
                  <TD className={cn(NUM, "hidden sm:table-cell", l.refused > 0 && "text-danger")}>{formatNumber(l.refused)}</TD>
                </TR>
              )),
            ])}
          </TBody>
        </Table>
      </Card>

      {batch.payments.length ? (
        <Card className="space-y-2">
          <h3 className="font-display text-base font-semibold">Its answers</h3>
          <ul className="divide-y divide-border text-sm">
            {batch.payments.map((p) => (
              <li key={p.id} className={cn("flex flex-wrap items-center justify-between gap-2 py-2", p.voided && "text-muted-foreground line-through")}>
                <span>
                  {day(p.paidAt)} · {p.methodLabel}
                  {p.reference ? ` · ${p.reference}` : ""} · paid <span className="font-mono">{formatNumber(p.amount)}</span>, refused <span className="font-mono">{formatNumber(p.refused)}</span>
                  {p.voided ? ` · voided: ${p.voidReason}` : ""}
                </span>
                {canManage && !p.voided ? <VoidPayerPaymentButton paymentId={p.id} label={`the answer of ${day(p.paidAt)}`} /> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
