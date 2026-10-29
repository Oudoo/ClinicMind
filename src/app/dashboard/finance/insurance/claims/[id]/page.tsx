import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { TenantScopeError } from "@/lib/tenant-scope";
import { formatDateInTz } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { getClaim } from "@/modules/insurance/batches";
import { Card, SectionTitle } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { ClaimStatusBadge } from "@/components/clinicmind/insurance-shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Claim" };

const NUM = "whitespace-nowrap text-right font-mono tabular-nums";

/** `/dashboard/finance/insurance/claims/[id]` — a claim line by line: the shares, the approval used, and the payer's answers. */
export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "insurance:read")) return <NotForRole title="Not available for your role" hint="Insurance is for the front desk, the nurses and the clinic owner." />;
  const claim = await getClaim(ctx.tenantId, id).catch((err: unknown) => {
    if (err instanceof TenantScopeError) return null;
    throw err;
  });
  if (!claim) notFound();
  const timezone = await getTenantTimezone(ctx.tenantId);
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="space-y-6" data-testid="claim-page">
      <div className="text-sm">
        <Link href={`/dashboard/finance/insurance/payers/${claim.payerId}`} className="text-accent underline-offset-2 hover:underline">
          ← {claim.payerName}
        </Link>
      </div>
      <SectionTitle
        title={`Claim ${claim.number}`}
        description={`${claim.patientName} · card ${claim.memberNumber}${claim.plan ? ` (${claim.plan})` : ""} · ${claim.relationLabel} · made ${day(claim.claimedAt)}`}
        action={<ClaimStatusBadge status={claim.status} label={claim.statusLabel} overdue={claim.overdue} />}
      />
      <Card className="space-y-1 text-sm">
        <p>
          Invoice{" "}
          <Link href={`/dashboard/finance/invoices/${claim.invoiceId}`} className="font-mono underline-offset-2 hover:underline">
            {claim.invoiceNumber}
          </Link>{" "}
          ·{" "}
          <Link href={`/dashboard/patients/${claim.patientId}`} className="underline-offset-2 hover:underline">
            the patient&apos;s page
          </Link>
          {claim.batch ? (
            <>
              {" "}
              · batch{" "}
              <Link href={`/dashboard/finance/insurance/batches/${claim.batch.id}`} className="font-mono underline-offset-2 hover:underline">
                {claim.batch.number}
              </Link>
              , sent {day(claim.batch.sentAt)}
            </>
          ) : (
            " · not sent yet"
          )}
        </p>
        <p>
          Claimed <span className="font-mono">{formatNumber(claim.amount)}</span> EGP · paid <span className="font-mono">{formatNumber(claim.paid)}</span> · refused{" "}
          <span className="font-mono">{formatNumber(claim.refused)}</span> · owed <span className="font-mono font-medium">{formatNumber(claim.owed)}</span> · the patient&apos;s share{" "}
          <span className="font-mono">{formatNumber(claim.patientShare)}</span>
        </p>
        {claim.cancelReason ? <p className="text-muted-foreground">Cancelled: {claim.cancelReason}</p> : null}
      </Card>
      <Card className="overflow-hidden p-0">
        <Table aria-label="The claim's lines" data-testid="claim-lines">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Work</TH>
              <TH className="hidden text-right lg:table-cell">Contract discount</TH>
              <TH className="hidden text-right md:table-cell">Patient pays</TH>
              <TH className="text-right">Claimed</TH>
              <TH className="hidden text-right sm:table-cell">Paid</TH>
              <TH className="hidden text-right sm:table-cell">Refused</TH>
            </TR>
          </THead>
          <TBody>
            {claim.lines.map((l) => (
              <TR key={l.id}>
                <TD className="text-sm">
                  {l.description}
                  <span className="block text-xs text-muted-foreground">
                    {day(l.workedAt)} · {formatNumber(l.amount)} EGP at the contract&apos;s price{l.approvalNumber ? ` · approval ${l.approvalNumber}` : ""}
                  </span>
                  {l.answers.map((a) => (
                    <span key={a.id} className="block text-xs text-muted-foreground">
                      {day(a.paidAt)}: paid {formatNumber(a.paid)}
                      {a.refused ? `, refused ${formatNumber(a.refused)} (${a.reasonLabel}${a.writtenOff ? ", written off" : ", the patient's to pay"})` : ""}
                      {a.reference ? ` · ${a.reference}` : ""}
                    </span>
                  ))}
                </TD>
                <TD className={cn(NUM, "hidden lg:table-cell")}>{formatNumber(l.contractDiscount)}</TD>
                <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(l.patientShare)}</TD>
                <TD className={NUM}>{formatNumber(l.payerShare)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(l.paid)}</TD>
                <TD className={cn(NUM, "hidden sm:table-cell", l.refused > 0 && "text-danger")}>{formatNumber(l.refused)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
