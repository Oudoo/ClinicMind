import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { FileText, Users } from "lucide-react";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { canSeeAccounts, getLedger } from "@/modules/finance/ledger";
import { getHousehold } from "@/modules/finance/household";
import { balanceWords } from "@/modules/finance/ledger-copy";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { FamilyAccount } from "./family-account";
import { LedgerText } from "./ledger-text";

/** The most recent lines shown on the record; the statement has every line for any dates. */
const SHOWN = 25;

/**
 * The patient's account on their record: where it stands (the balance, what
 * is due on invoices, not invoiced yet, and the credit), the family account,
 * and the latest lines of the ledger with the running balance. For the
 * roles that take payments and the owner.
 */
export async function PatientAccount({ tenantId, role, patientId, canWrite }: { tenantId: string; role: UserRole; patientId: string; canWrite: boolean }) {
  if (!canSeeAccounts(role)) return null;
  const [ledger, household] = await Promise.all([getLedger(tenantId, patientId), getHousehold(tenantId, patientId)]);
  const { position, timezone } = ledger;
  const shown = ledger.entries.slice(-SHOWN);
  const carried = ledger.entries.length > SHOWN ? ledger.entries[ledger.entries.length - SHOWN - 1]!.balance : null;
  const date = (iso: string) => formatDateInTz(new Date(iso), timezone);
  const money = (n: number) => (n ? formatNumber(n) : "");
  const statement = `/dashboard/patients/${patientId}/statement`;

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        {/* The buttons sit beside the title where there is room, and under it on a phone. */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <h2 className="font-display text-lg font-semibold tracking-tight">Account</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Every charge and every payment, with the balance after each.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={statement} className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-3 text-sm hover:bg-muted">
              <FileText className="h-4 w-4" aria-hidden="true" />
              Statement
            </Link>
            {household.role !== "none" ? (
              <Link href={`${statement}?family=1`} className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-3 text-sm hover:bg-muted">
                <Users className="h-4 w-4" aria-hidden="true" />
                Family statement
              </Link>
            ) : null}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 rounded-lg bg-muted/60 p-3 sm:grid-cols-4">
          <div>
            <dt className="data-label">Balance</dt>
            <dd className={cn("font-mono text-sm tabular-nums", position.balance > 0 && "text-warning", position.balance < 0 && "text-accent")} data-testid="account-balance">
              {balanceWords(position.balance)}
            </dd>
          </div>
          <div>
            <dt className="data-label">Due on invoices</dt>
            <dd className="font-mono text-sm tabular-nums">{formatNumber(position.dueOnInvoices)}</dd>
          </div>
          <div>
            <dt className="data-label" title="Charges on no issued invoice yet">Not invoiced yet</dt>
            <dd className="font-mono text-sm tabular-nums">{formatNumber(position.notInvoiced)}</dd>
          </div>
          <div>
            <dt className="data-label" title="Paid and not yet put towards an invoice">Credit</dt>
            <dd className="font-mono text-sm tabular-nums">{formatNumber(position.credit)}</dd>
          </div>
        </dl>
      </Card>

      <FamilyAccount patient={ledger.patient} household={household} canManage={canWrite && can(role, "payments:write")} />

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-4 py-3 sm:px-6">
          <SectionTitle title="Ledger" description={carried !== null ? `The latest ${SHOWN} lines: the statement has them all, for any dates.` : "Amounts in EGP."} />
        </div>
        {ledger.entries.length ? (
          <Table aria-label="Ledger">
            <THead>
              <TR className="hover:bg-transparent">
                <TH className="hidden sm:table-cell">Date</TH>
                <TH className="hidden md:table-cell">Reference</TH>
                <TH className="px-3 sm:px-5">Details</TH>
                <TH className="hidden text-end sm:table-cell">Charges</TH>
                <TH className="hidden text-end sm:table-cell">Payments</TH>
                <TH className="px-3 text-end sm:hidden">Amount</TH>
                <TH className="px-3 text-end sm:px-5">Balance</TH>
              </TR>
            </THead>
            <TBody>
              {carried !== null ? (
                <TR>
                  <TD className="hidden text-xs text-muted-foreground sm:table-cell">Earlier</TD>
                  <TD className="hidden md:table-cell" />
                  <TD className="px-3 text-sm text-muted-foreground sm:px-5">Brought forward</TD>
                  <TD className="hidden sm:table-cell" />
                  <TD className="hidden sm:table-cell" />
                  <TD className="px-3 sm:hidden" />
                  <TD className="px-3 text-end font-mono text-xs tabular-nums sm:px-5">{formatNumber(carried)}</TD>
                </TR>
              ) : null}
              {shown.map((e) => (
                <TR key={e.id} className="align-top">
                  <TD className="hidden whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground sm:table-cell">{date(e.at)}</TD>
                  <TD className="hidden whitespace-nowrap font-mono text-xs md:table-cell">{e.reference ?? ""}</TD>
                  <TD className="px-3 text-sm sm:min-w-[10rem] sm:px-5">
                    <LedgerText entry={e} />
                    {/* The date (on a phone) and the reference (below a laptop) go under the details. */}
                    <span className="block font-mono text-[11px] text-muted-foreground sm:hidden">
                      {date(e.at)}
                      {e.reference ? ` · ${e.reference}` : ""}
                    </span>
                    {e.reference ? <span className="hidden font-mono text-[11px] text-muted-foreground sm:block md:hidden">{e.reference}</span> : null}
                  </TD>
                  <TD className="hidden whitespace-nowrap text-end font-mono text-xs tabular-nums sm:table-cell">{money(e.debit)}</TD>
                  <TD className="hidden whitespace-nowrap text-end font-mono text-xs tabular-nums text-success sm:table-cell">{money(e.credit)}</TD>
                  <TD className="whitespace-nowrap px-3 text-end font-mono text-xs tabular-nums sm:hidden">
                    {e.debit ? <span className="block">{formatNumber(e.debit)}</span> : null}
                    {e.credit ? <span className="block text-success">−{formatNumber(e.credit)}</span> : null}
                  </TD>
                  <TD className={cn("whitespace-nowrap px-3 text-end font-mono text-xs tabular-nums sm:px-5", e.balance > 0 && "text-warning")}>{formatNumber(e.balance)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title="Nothing on the account yet" hint="Charges appear when work is done; payments as they are taken." />
          </div>
        )}
      </Card>
    </div>
  );
}
