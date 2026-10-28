import { Badge } from "@/components/ui/primitives";
import { balanceWords } from "@/modules/finance/ledger-copy";

/**
 * The patient's balance as a chip: "Owes 2,400 EGP" or "In credit 600 EGP"
 * (nothing, or "Settled", when the account is square). Shown to the roles
 * that take payments, on the patient header and wherever patients check in.
 */
export function BalanceChip({ balance, showSettled = false, className }: { balance: number | null | undefined; showSettled?: boolean; className?: string }) {
  if (balance === null || balance === undefined) return null;
  if (balance === 0) return showSettled ? <Badge tone="success" className={className}>Settled</Badge> : null;
  return (
    <Badge tone={balance > 0 ? "warning" : "accent"} className={className} title={balance > 0 ? "What the patient owes now" : "Paid ahead, not yet used"}>
      {balanceWords(balance)}
    </Badge>
  );
}
