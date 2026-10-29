import { Badge } from "@/components/ui/primitives";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { cn, formatNumber } from "@/lib/utils";
import { AGE_BUCKETS } from "@/modules/insurance/constants";
import type { AgingReport } from "@/modules/insurance/payers";
import Link from "next/link";

/** A claim's state: to send, sent (late past its payer's days), part paid, answered, refused or cancelled. */
export function ClaimStatusBadge({ status, label, overdue }: { status: string; label: string; overdue?: boolean }) {
  const tone: BadgeTone = status === "CANCELLED" ? "default" : status === "SETTLED" ? (label === "Refused" ? "danger" : "success") : overdue ? "danger" : status === "SENT" ? "accent" : "warning";
  return <Badge tone={tone}>{overdue ? "Late" : label}</Badge>;
}

export function ApprovalStatusBadge({ status, label, expired }: { status: string; label: string; expired?: boolean }) {
  const tone: BadgeTone = status === "APPROVED" ? (expired ? "default" : "success") : status === "REFUSED" ? "danger" : status === "REQUESTED" ? "warning" : "default";
  return <Badge tone={tone}>{expired ? "Expired" : label}</Badge>;
}

const NUM = "whitespace-nowrap text-right font-mono tabular-nums";

/** What each payer owes, by how long ago its claims were made; then, of what it owes, what is not sent yet and what is late. */
export function AgingTable({ aging, linkPayers = true }: { aging: AgingReport; linkPayers?: boolean }) {
  return (
    <Table aria-label="Owed by payer, by age" data-testid="aging-table">
      <THead>
        <TR className="hover:bg-transparent">
          <TH>Payer</TH>
          {AGE_BUCKETS.map((b) => (
            <TH key={b.key} className={cn("text-right", b.key === "d30" ? "hidden sm:table-cell" : b.key === "over" ? "" : "hidden lg:table-cell")}>
              {b.label}
            </TH>
          ))}
          <TH className="text-right">Owed</TH>
          <TH className="hidden text-right md:table-cell">Of it, not sent</TH>
          <TH className="hidden text-right sm:table-cell">Of it, late</TH>
        </TR>
      </THead>
      <TBody>
        {aging.rows.map((r) => (
          <TR key={r.payerId}>
            <TD>
              {linkPayers ? (
                <Link href={`/dashboard/finance/insurance/payers/${r.payerId}`} className="font-medium underline-offset-2 hover:underline">
                  {r.payerName}
                </Link>
              ) : (
                <span className="font-medium">{r.payerName}</span>
              )}
              <span className="block text-xs text-muted-foreground">
                {r.claims} claim{r.claims === 1 ? "" : "s"}
              </span>
            </TD>
            {AGE_BUCKETS.map((b) => (
              <TD key={b.key} className={cn(NUM, b.key === "d30" ? "hidden sm:table-cell" : b.key === "over" ? "" : "hidden lg:table-cell", b.key === "over" && r.buckets.over > 0 && "text-danger")}>
                {formatNumber(r.buckets[b.key])}
              </TD>
            ))}
            <TD className={cn(NUM, "font-medium")}>{formatNumber(r.total)}</TD>
            <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(r.notSent)}</TD>
            <TD className={cn(NUM, "hidden sm:table-cell", r.overdue > 0 && "text-danger")}>{formatNumber(r.overdue)}</TD>
          </TR>
        ))}
        {aging.rows.length > 1 ? (
          <TR className="bg-muted/40 font-medium hover:bg-muted/40">
            <TD>Total</TD>
            {AGE_BUCKETS.map((b) => (
              <TD key={b.key} className={cn(NUM, b.key === "d30" ? "hidden sm:table-cell" : b.key === "over" ? "" : "hidden lg:table-cell")}>
                {formatNumber(aging.totals.buckets[b.key])}
              </TD>
            ))}
            <TD className={NUM}>{formatNumber(aging.totals.total)}</TD>
            <TD className={cn(NUM, "hidden md:table-cell")}>{formatNumber(aging.totals.notSent)}</TD>
            <TD className={cn(NUM, "hidden sm:table-cell")}>{formatNumber(aging.totals.overdue)}</TD>
          </TR>
        ) : null}
      </TBody>
    </Table>
  );
}
