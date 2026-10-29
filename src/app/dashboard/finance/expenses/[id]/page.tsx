import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { MAX_EXPENSE_FILES } from "@/modules/finance/expense-constants";
import { expenseFormContext, getExpense } from "@/modules/finance/expenses";
import { FinanceError } from "@/modules/finance/errors";
import { Badge, Card } from "@/components/ui/primitives";
import { Alert } from "@/components/ui/field";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { dayLabel, ExpenseStatusBadge } from "@/components/clinicmind/expense-shared";
import { AddReceiptButton, EditExpenseButton, PayExpenseButton, ReceiptList, VoidExpenseButton, VoidExpensePaymentButton } from "@/components/clinicmind/expense-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Expense" };

/**
 * `/dashboard/finance/expenses/[id]` — one expense: what it is and for whom,
 * its days, what is paid and what is owed, its payments (cash out of the
 * drawer marked), and the photos or PDFs of its bill or receipt.
 */
export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "expenses:read")) {
    return <NotForRole title="Not available for your role" hint="Expenses are for the front desk and the clinic owner." />;
  }
  const expense = await getExpense(ctx.tenantId, id, { role: ctx.role }).catch((err: unknown) => {
    if (err instanceof FinanceError && err.status === 404) return null;
    throw err;
  });
  if (!expense) notFound();
  const form = await expenseFormContext(ctx.tenantId, { id: ctx.userId, role: ctx.role });
  const canWrite = can(ctx.role, "expenses:write");
  const isOwner = can(ctx.role, "tenant:manage");
  const live = !expense.voidedAt;
  const when = (iso: string) => formatDateInTz(new Date(iso), form.timezone, { day: "numeric", month: "short", year: "numeric" });
  const context = { suppliers: form.suppliers, clinics: form.clinics, timezone: form.timezone, canSalaries: form.canSalaries, drawerOpen: form.drawerOpen };
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-dashed border-border py-1.5 last:border-0">
      <dt className="data-label">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );

  return (
    <div className="space-y-6" data-testid="expense-page">
      <Link href="/dashboard/finance/expenses" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Expenses
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`font-display text-lg font-semibold tracking-tight ${live ? "" : "line-through"}`}>{expense.description}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {expense.categoryLabel}
            <ExpenseStatusBadge status={expense.status} label={expense.statusLabel} daysLate={expense.daysLate} />
            {expense.recurring ? <Badge>{`Recurring · ${expense.recurring.periodLabel}`}</Badge> : null}
          </p>
        </div>
        {live ? (
          <div className="flex flex-wrap gap-2">
            {canWrite && expense.owed > 0 ? <PayExpenseButton expenseId={expense.id} description={expense.description} owed={expense.owed} billedOn={expense.billedOn} timezone={form.timezone} drawerOpen={form.drawerOpen} /> : null}
            {canWrite ? <EditExpenseButton context={context} expense={expense} /> : null}
            {isOwner ? <VoidExpenseButton expense={expense} /> : null}
          </div>
        ) : null}
      </div>

      {expense.voidedAt ? (
        <Alert tone="info">
          Voided {when(expense.voidedAt)}: {expense.voidReason}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <dl>
            {row(
              "Supplier",
              expense.supplier ? (
                <Link href={`/dashboard/finance/suppliers/${expense.supplier.id}`} className="underline-offset-2 hover:underline">
                  {expense.supplier.name}
                </Link>
              ) : (
                "None"
              ),
            )}
            {row("Day of the bill", dayLabel(expense.billedOn))}
            {row("To pay by", expense.dueOn ? dayLabel(expense.dueOn) : "No day set")}
            {expense.reference ? row("Bill or receipt no.", <span className="font-mono">{expense.reference}</span>) : null}
            {form.clinics.length > 1 ? row("Branch", expense.clinic.name) : null}
            {expense.recurring ? row("Made by", `${expense.recurring.description}, for ${expense.recurring.periodLabel}`) : null}
            {expense.note ? row("Note", <span className="whitespace-pre-line">{expense.note}</span>) : null}
            {row("Recorded", `${when(expense.createdAt)}${expense.createdBy ? ` by ${expense.createdBy}` : expense.recurring ? ", on its day" : ""}`)}
          </dl>
        </Card>
        <Card className="space-y-2">
          <p className="flex items-baseline justify-between gap-2">
            <span className="data-label">Amount</span>
            <span className="font-mono text-lg tabular-nums">{formatNumber(expense.amount)} EGP</span>
          </p>
          <p className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-muted-foreground">Paid</span>
            <span className="font-mono tabular-nums">{formatNumber(expense.paid)}</span>
          </p>
          <p className="flex items-baseline justify-between gap-2 text-sm">
            <span className="text-muted-foreground">Owed</span>
            <span className={`font-mono tabular-nums ${expense.overdue ? "text-danger" : ""}`}>{formatNumber(expense.owed)}</span>
          </p>
        </Card>
      </div>

      <Card className="space-y-3" aria-label="Payments">
        <h3 className="font-display text-base font-semibold">Payments</h3>
        {expense.payments.length ? (
          <ul className="divide-y divide-border" data-testid="expense-payments">
            {expense.payments.map((p) => (
              <li key={p.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 text-sm ${p.voidedAt ? "text-muted-foreground" : ""}`} title={p.voidReason ? `Voided: ${p.voidReason}` : undefined}>
                <div className={p.voidedAt ? "line-through" : ""}>
                  <span className="font-medium">{p.methodLabel}</span> · {when(p.paidAt)}
                  {p.reference ? <span className="font-mono"> · {p.reference}</span> : null}
                  {p.paidBy ? <span className="text-muted-foreground"> · {p.paidBy}</span> : null}
                  {p.fromDrawer ? (
                    <Badge className="ml-2" tone="accent">
                      Cash drawer
                    </Badge>
                  ) : null}
                  {p.voidedAt ? <span className="ml-2 no-underline">Voided</span> : null}
                </div>
                <span className="flex items-center gap-1">
                  <span className="font-mono tabular-nums">{formatNumber(p.amount)}</span>
                  {isOwner && !p.voidedAt && live ? <VoidExpensePaymentButton paymentId={p.id} amount={p.amount} /> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing paid yet.</p>
        )}
      </Card>

      <Card className="space-y-3" aria-label="Receipts">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-base font-semibold">The bill or the receipt</h3>
          {canWrite && live ? <AddReceiptButton expenseId={expense.id} room={MAX_EXPENSE_FILES - expense.files.length} /> : null}
        </div>
        <ReceiptList files={expense.files} canRemove={isOwner} />
      </Card>
    </div>
  );
}
