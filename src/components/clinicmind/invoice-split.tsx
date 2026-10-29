import { formatNumber } from "@/lib/utils";
import type { InvoiceSplit, SplitNote } from "@/modules/insurance/claims";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

const NOTE_WORDS: Record<SplitNote, string> = {
  not_covered: "Not covered by the contract",
  needs_approval: "Needs the payer's approval first: none on record",
  approval_cap: "Up to what the approval has left",
  limit: "Up to what is left of the yearly limit",
  no_cover: "No cover on the day of the work",
  no_contract: "The payer had no contract that day",
};

/**
 * A covered patient's draft: how its work will be shared between the patient
 * and the payer when it is issued (the contract's discount, the co-pay, the
 * approval each line takes, the yearly limit). Not printed.
 */
export function InvoiceSplitPanel({ split }: { split: InvoiceSplit }) {
  if (!split.insured) return null;
  const payers = [...new Set(split.claims.map((c) => c.payerName))];
  return (
    <section className="no-print space-y-3 rounded-lg border border-accent/40 bg-accent-muted/40 p-4 text-sm" aria-label="Insurance on this invoice" data-testid="invoice-split">
      <p>
        {split.claimed > 0 ? (
          <>
            On issue, <span className="font-mono font-medium">{formatNumber(split.claimed)}</span> EGP is claimed from {payers.join(" and ")}; the patient pays{" "}
            <span className="font-mono font-medium">{formatNumber(split.patientPays)}</span> EGP.
          </>
        ) : (
          <>Nothing on it is claimed: the patient pays it all.</>
        )}
      </p>
      <Table aria-label="The patient's and the payer's shares">
        <THead>
          <TR className="hover:bg-transparent">
            <TH>Work</TH>
            <TH className="text-right">Patient pays</TH>
            <TH className="text-right">Claimed</TH>
          </TR>
        </THead>
        <TBody>
          {split.lines.map((l) => (
            <TR key={l.chargeId}>
              <TD>
                <span dir="auto">{l.description}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatNumber(l.amount)} EGP
                  {l.contractDiscount ? ` after the contract's ${formatNumber(l.contractDiscount)} off${l.contractDiscountToAdd ? " (put on when issued)" : ""}` : ""}
                  {l.payerName && l.covered ? ` · ${l.payerName}, the patient pays ${l.copayPct}%` : ""}
                  {l.approvalNumber ? ` · approval ${l.approvalNumber}` : ""}
                  {l.note ? ` · ${NOTE_WORDS[l.note]}` : ""}
                </span>
              </TD>
              <TD className="whitespace-nowrap text-right font-mono tabular-nums">{formatNumber(l.patientShare)}</TD>
              <TD className="whitespace-nowrap text-right font-mono tabular-nums">{formatNumber(l.payerShare)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}
