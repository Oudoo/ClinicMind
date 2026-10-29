import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatNumber } from "@/lib/utils";
import { expenseKpis, listSuppliers } from "@/modules/finance/expenses";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Checkbox, Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { ExpenseNav } from "@/components/clinicmind/expense-nav";
import { dayLabel } from "@/components/clinicmind/expense-shared";
import { NewSupplierButton } from "@/components/clinicmind/supplier-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Suppliers" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/dashboard/finance/suppliers` — who the clinic buys from or pays, with
 * what is owed to each, what each billed this year and its last bill.
 */
export default async function SuppliersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "expenses:read")) {
    return <NotForRole title="Not available for your role" hint="Suppliers are for the front desk and the clinic owner." />;
  }
  const q = first(sp.q)?.trim() ?? "";
  const archived = first(sp.archived) === "1";
  const [suppliers, kpis] = await Promise.all([
    listSuppliers(ctx.tenantId, { role: ctx.role, includeArchived: archived, q: q || undefined }),
    expenseKpis(ctx.tenantId, { role: ctx.role }),
  ]);
  const canWrite = can(ctx.role, "expenses:write");
  const owed = suppliers.reduce((s, x) => s + x.owed, 0);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Suppliers"
        description="Who the clinic buys from or pays: labs, suppliers of materials, the landlord, the utilities, the accountant. What is owed to each comes from its bills."
        action={canWrite ? <NewSupplierButton canSalaries={can(ctx.role, "tenant:manage")} /> : undefined}
      />
      <ExpenseNav current="suppliers" toPay={kpis.toPay.bills} overdue={kpis.overdue.bills} />
      <Card className="overflow-hidden p-0">
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4" role="search" aria-label="Search suppliers">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Search
            <Input name="q" defaultValue={q} placeholder="A supplier's name" />
          </label>
          <label className="flex h-10 items-center gap-2 text-sm">
            <Checkbox name="archived" value="1" defaultChecked={archived} />
            With those no longer used
          </label>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {suppliers.length ? (
          <Table aria-label="Suppliers" data-testid="supplier-table">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Supplier</TH>
                <TH className="text-right">Owed</TH>
                <TH className="hidden text-right md:table-cell">This year</TH>
                <TH className="hidden lg:table-cell">Last bill</TH>
              </TR>
            </THead>
            <TBody>
              {suppliers.map((s) => (
                <TR key={s.id} className={s.archived ? "text-muted-foreground" : undefined}>
                  <TD>
                    <Link href={`/dashboard/finance/suppliers/${s.id}`} className="font-medium underline-offset-2 hover:underline">
                      {s.name}
                    </Link>
                    {s.isLab ? (
                      <Badge className="ml-2" tone="accent">
                        Lab
                      </Badge>
                    ) : null}
                    {s.archived ? <Badge className="ml-2">No longer used</Badge> : null}
                    <div className="text-xs text-muted-foreground">
                      {s.categoryLabel}
                      {s.phone ? ` · ${s.phone}` : ""}
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    <span className="font-mono tabular-nums">{formatNumber(s.owed)}</span>
                    {s.openBills ? <div className="text-xs text-muted-foreground">{`${s.openBills} bill${s.openBills === 1 ? "" : "s"}`}</div> : null}
                  </TD>
                  <TD className="hidden whitespace-nowrap text-right font-mono tabular-nums md:table-cell">{formatNumber(s.billedThisYear)}</TD>
                  <TD className="hidden whitespace-nowrap text-xs lg:table-cell">{s.lastBilledOn ? dayLabel(s.lastBilledOn) : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title={q ? "No supplier matches" : "No supplier yet"} hint={q ? "Try another name." : "Add one with New supplier, or type a new name when recording an expense."} />
          </div>
        )}
        {suppliers.length ? (
          <p className="border-t border-border px-4 py-3 text-right text-sm">
            <span className="data-label mr-2">Owed in all</span>
            <span className="font-mono tabular-nums">{formatNumber(owed)} EGP</span>
          </p>
        ) : null}
      </Card>
    </div>
  );
}
