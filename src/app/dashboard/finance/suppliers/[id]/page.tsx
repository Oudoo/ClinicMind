import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { TenantScopeError } from "@/lib/tenant-scope";
import { formatNumber } from "@/lib/utils";
import { expenseFormContext, getSupplier, listExpenses } from "@/modules/finance/expenses";
import { Badge, Bento, Card, EmptyState, Metric } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { dayLabel, ExpenseStatusBadge } from "@/components/clinicmind/expense-shared";
import { NewExpenseButton, PayExpenseButton } from "@/components/clinicmind/expense-actions";
import { EditSupplierButton } from "@/components/clinicmind/supplier-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Supplier" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/dashboard/finance/suppliers/[id]` — a supplier: how to reach them, what
 * is owed to them and their bills, newest first, a payment on each one owed.
 */
export default async function SupplierPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "expenses:read")) {
    return <NotForRole title="Not available for your role" hint="Suppliers are for the front desk and the clinic owner." />;
  }
  const supplier = await getSupplier(ctx.tenantId, id, { role: ctx.role }).catch((err: unknown) => {
    if (err instanceof TenantScopeError) return null;
    throw err;
  });
  if (!supplier) notFound();
  const page = Math.max(1, Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1);
  const [bills, form] = await Promise.all([
    listExpenses(ctx.tenantId, { view: "all", supplierId: id, page, pageSize: 20 }, { role: ctx.role }),
    expenseFormContext(ctx.tenantId, { id: ctx.userId, role: ctx.role }),
  ]);
  const canWrite = can(ctx.role, "expenses:write");
  const context = { suppliers: form.suppliers, clinics: form.clinics, timezone: form.timezone, canSalaries: form.canSalaries, drawerOpen: form.drawerOpen };

  return (
    <div className="space-y-6" data-testid="supplier-page">
      <Link href="/dashboard/finance/suppliers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Suppliers
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight">{supplier.name}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {supplier.categoryLabel}
            {supplier.archived ? <Badge>No longer used</Badge> : null}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {supplier.contactName ? <span>{supplier.contactName}</span> : null}
            {supplier.phone ? (
              <a href={`tel:${supplier.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
                <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                {supplier.phone}
              </a>
            ) : null}
            {supplier.email ? (
              <a href={`mailto:${supplier.email}`} className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                {supplier.email}
              </a>
            ) : null}
          </div>
          {supplier.notes ? <p className="mt-2 max-w-2xl whitespace-pre-line text-sm text-muted-foreground">{supplier.notes}</p> : null}
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <EditSupplierButton supplier={supplier} canSalaries={form.canSalaries} />
            {!supplier.archived ? <NewExpenseButton context={context} supplier={{ id: supplier.id, name: supplier.name, category: supplier.category }} label="New bill" /> : null}
          </div>
        ) : null}
      </div>

      <Bento className="lg:grid-cols-3">
        <Metric label="Owed · EGP" value={formatNumber(supplier.owed)} hint={supplier.openBills ? `On ${supplier.openBills} bill${supplier.openBills === 1 ? "" : "s"}` : "Nothing owed"} tone={supplier.owed ? "accent" : "default"} />
        <Metric label="This year · EGP" value={formatNumber(supplier.billedThisYear)} hint="Billed since the 1st of January" />
        <Metric label="Last bill" value={supplier.lastBilledOn ? dayLabel(supplier.lastBilledOn) : "—"} />
      </Bento>

      <Card className="overflow-hidden p-0">
        {bills.rows.length ? (
          <Table aria-label={`Bills of ${supplier.name}`} data-testid="supplier-bills">
            <THead>
              <TR className="hover:bg-transparent">
                <TH className="hidden sm:table-cell">Day</TH>
                <TH>What</TH>
                <TH className="text-right">Amount</TH>
                <TH>Paid</TH>
              </TR>
            </THead>
            <TBody>
              {bills.rows.map((e) => (
                <TR key={e.id}>
                  <TD className="hidden whitespace-nowrap text-xs sm:table-cell">{dayLabel(e.billedOn)}</TD>
                  <TD>
                    <Link href={`/dashboard/finance/expenses/${e.id}`} className="font-medium underline-offset-2 hover:underline">
                      {e.description}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      <span className="sm:hidden">{dayLabel(e.billedOn)} · </span>
                      {e.categoryLabel}
                      {e.reference ? ` · ${e.reference}` : ""}
                    </div>
                    {canWrite && e.owed > 0 ? (
                      <div className="mt-2">
                        <PayExpenseButton expenseId={e.id} description={e.description} owed={e.owed} billedOn={e.billedOn} timezone={form.timezone} drawerOpen={form.drawerOpen} />
                      </div>
                    ) : null}
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    <span className="font-mono tabular-nums">{formatNumber(e.amount)}</span>
                    {e.paid && e.owed ? <div className="text-xs text-muted-foreground">{formatNumber(e.owed)} owed</div> : null}
                  </TD>
                  <TD className="text-xs">
                    <ExpenseStatusBadge status={e.status} label={e.statusLabel} daysLate={e.daysLate} />
                    {e.owed && e.dueOn ? <div className="mt-1 whitespace-nowrap text-muted-foreground">{`${e.overdue ? "Was due" : "By"} ${dayLabel(e.dueOn)}`}</div> : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title="No bill yet" hint={canWrite ? "Record one with New bill." : "Its bills show here."} />
          </div>
        )}
        {bills.total > bills.pageSize ? <Pagination page={page} pageSize={bills.pageSize} total={bills.total} basePath={`/dashboard/finance/suppliers/${id}`} className="border-t border-border" /> : null}
      </Card>
    </div>
  );
}
