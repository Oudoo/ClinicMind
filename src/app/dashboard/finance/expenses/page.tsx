import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Paperclip } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatNumber } from "@/lib/utils";
import { isMonthKey, monthLabel, monthOfKey, shiftMonth } from "@/modules/finance/doctor-pay-calc";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, isOwnerOnlyCategory, RECURRING_EVERY_LABELS, type ExpenseCategoryValue } from "@/modules/finance/expense-constants";
import { expenseFormContext, expenseKpis, listExpenses, listRecurring } from "@/modules/finance/expenses";
import { Badge, Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { ExpenseNav } from "@/components/clinicmind/expense-nav";
import { dayLabel, ExpenseStatusBadge } from "@/components/clinicmind/expense-shared";
import { NewExpenseButton, PayExpenseButton } from "@/components/clinicmind/expense-actions";
import { EditRecurringButton, NewRecurringButton, StopRecurringButton } from "@/components/clinicmind/supplier-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Expenses" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
type View = "due" | "month" | "recurring" | "voided";
const VIEWS: readonly View[] = ["due", "month", "recurring", "voided"];

const EMPTY: Record<Exclude<View, "recurring">, { title: string; hint: string }> = {
  due: { title: "Nothing to pay", hint: "A bill shows here until it is paid in full: add one with New expense, A bill to pay." },
  month: { title: "No expense this month", hint: "Money spent and bills of the month show here." },
  voided: { title: "Nothing voided", hint: "An expense voided by the owner, with the reason, shows here." },
};

/**
 * `/dashboard/finance/expenses` — what the clinic spends, for the front desk
 * and the owner (`expenses:read`): what is to pay and what is late, the
 * month's spending by category, the recurring expenses and the voided ones;
 * a payment on each bill to pay. Salaries are the owner's alone.
 */
export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "expenses:read")) {
    return <NotForRole title="Not available for your role" hint="Expenses are for the front desk and the clinic owner." />;
  }
  const asked = first(sp.view);
  const view: View = asked && (VIEWS as readonly string[]).includes(asked) ? (asked as View) : "due";
  const q = first(sp.q)?.trim() ?? "";
  const askedCategory = first(sp.category);
  const category = askedCategory && (EXPENSE_CATEGORIES as readonly string[]).includes(askedCategory) ? (askedCategory as ExpenseCategoryValue) : undefined;
  const askedMonth = first(sp.month);
  const page = Math.max(1, Number(first(sp.page)) || 1);
  const canWrite = can(ctx.role, "expenses:write");
  const isOwner = can(ctx.role, "tenant:manage");

  const [kpis, form] = await Promise.all([expenseKpis(ctx.tenantId, { role: ctx.role }), expenseFormContext(ctx.tenantId, { id: ctx.userId, role: ctx.role })]);
  const month = askedMonth && isMonthKey(askedMonth) ? askedMonth : kpis.month;
  const [list, recurring] = await Promise.all([
    view === "recurring" ? null : listExpenses(ctx.tenantId, { view, month, category, q: q || undefined, page, pageSize: 25 }, { role: ctx.role }),
    view === "recurring" ? listRecurring(ctx.tenantId, { role: ctx.role }) : null,
  ]);
  const context = { suppliers: form.suppliers, clinics: form.clinics, timezone: form.timezone, canSalaries: form.canSalaries, drawerOpen: form.drawerOpen };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const query = { view, q: q || undefined, category, month: view === "month" ? month : undefined };
  const monthHref = (m: string) => `/dashboard/finance/expenses?${new URLSearchParams({ view: "month", month: m, ...(category ? { category } : {}), ...(q ? { q } : {}) }).toString()}`;
  const categories = EXPENSE_CATEGORIES.filter((c) => isOwner || !isOwnerOnlyCategory(c));

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Expenses"
        description="What the clinic spends: bills to pay by their day and money spent at the desk, under a category. Cash paid out of the drawer comes off what it expects at the close."
        action={
          canWrite ? (
            <div className="flex flex-wrap justify-end gap-2">
              {isOwner ? <NewRecurringButton suppliers={form.suppliers} clinics={form.clinics} timezone={form.timezone} canSalaries={form.canSalaries} /> : null}
              <NewExpenseButton context={context} />
            </div>
          ) : undefined
        }
      />

      <Bento>
        <Metric label="To pay · EGP" value={formatNumber(kpis.toPay.amount)} hint={kpis.toPay.bills ? `On ${plural(kpis.toPay.bills, "bill")}` : "Nothing owed"} tone="accent" />
        <Metric label="Late · EGP" value={formatNumber(kpis.overdue.amount)} hint={kpis.overdue.bills ? `${plural(kpis.overdue.bills, "bill")} past the day to pay` : "Nothing late"} tone={kpis.overdue.amount ? "warning" : "default"} />
        <Metric label="Spent this month · EGP" value={formatNumber(kpis.spentThisMonth)} hint={`Billed or spent in ${monthLabel(kpis.month)}${isOwner ? "" : ", salaries aside"}`} />
        <Metric label="Paid this month · EGP" value={formatNumber(kpis.paidThisMonth)} hint="Paid towards expenses since the 1st" />
      </Bento>

      <ExpenseNav current={view} toPay={kpis.toPay.bills} overdue={kpis.overdue.bills} />

      {recurring ? (
        <Card className="overflow-hidden p-0">
          {recurring.length ? (
            <Table aria-label="Recurring expenses" data-testid="recurring-table">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>What</TH>
                  <TH className="text-right">Amount</TH>
                  <TH className="hidden md:table-cell">How often</TH>
                  <TH>Next bill</TH>
                  <TH className="hidden lg:table-cell">Made</TH>
                  {isOwner ? <TH className="hidden text-right sm:table-cell">Act</TH> : null}
                </TR>
              </THead>
              <TBody>
                {recurring.map((r) => {
                  const actions = r.stoppedAt ? null : (
                    <>
                      <EditRecurringButton recurring={r} suppliers={form.suppliers} timezone={form.timezone} canSalaries={form.canSalaries} />
                      <StopRecurringButton recurring={r} />
                    </>
                  );
                  return (
                    <TR key={r.id} className={r.stoppedAt ? "text-muted-foreground" : undefined}>
                      <TD>
                        <div className="font-medium">{r.description}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.supplier ? (
                            <Link href={`/dashboard/finance/suppliers/${r.supplier.id}`} className="underline-offset-2 hover:underline">
                              {r.supplier.name}
                            </Link>
                          ) : (
                            "No supplier"
                          )}{" "}
                          · {r.categoryLabel}
                        </div>
                        <div className="text-xs text-muted-foreground md:hidden">
                          {RECURRING_EVERY_LABELS[r.everyMonths as keyof typeof RECURRING_EVERY_LABELS]}, on the {r.dayOfMonth}
                        </div>
                        {isOwner && actions ? <div className="mt-2 flex flex-wrap gap-1 sm:hidden">{actions}</div> : null}
                      </TD>
                      <TD className="whitespace-nowrap text-right font-mono tabular-nums">{formatNumber(r.amount)}</TD>
                      <TD className="hidden text-xs md:table-cell">
                        {RECURRING_EVERY_LABELS[r.everyMonths as keyof typeof RECURRING_EVERY_LABELS]}, on the {r.dayOfMonth}
                        <div className="text-muted-foreground">{r.dueDays ? `Paid within ${plural(r.dueDays, "day")}` : "Paid on the day"}</div>
                      </TD>
                      <TD className="text-xs">
                        {r.stoppedAt ? (
                          <div className="space-y-1">
                            <Badge>Stopped</Badge>
                            {r.stopReason ? <div className="max-w-[16rem] text-muted-foreground">{r.stopReason}</div> : null}
                          </div>
                        ) : r.nextOn ? (
                          <span className="whitespace-nowrap">{dayLabel(r.nextOn)}</span>
                        ) : (
                          "—"
                        )}
                      </TD>
                      <TD className="hidden text-xs text-muted-foreground lg:table-cell">
                        {r.made ? `${plural(r.made, "bill")}, the last ${dayLabel(r.lastOn!)}` : "None yet"}
                      </TD>
                      {isOwner ? (
                        <TD className="hidden text-right sm:table-cell">
                          <div className="flex justify-end gap-1">{actions}</div>
                        </TD>
                      ) : null}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          ) : (
            <div className="p-6">
              <EmptyState title="No recurring expense" hint={isOwner ? "The rent, the internet, a service contract: New recurring makes their bill on its day." : "The owner sets them up: the rent, the internet, a service contract."} />
            </div>
          )}
        </Card>
      ) : list ? (
        <>
          {view === "month" ? (
            <Card className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <Link href={monthHref(shiftMonth(month, -1))} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="The month before">
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  </Link>
                  <h3 className="min-w-[9rem] text-center font-display text-base font-semibold">{list.monthLabel}</h3>
                  {month < kpis.month ? (
                    <Link href={monthHref(shiftMonth(month, 1))} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="The month after">
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  ) : (
                    <span className="w-7" aria-hidden="true" />
                  )}
                </div>
                <p className="text-sm">
                  <span className="data-label mr-2">Spent</span>
                  <span className="font-mono tabular-nums">{formatNumber(list.amount)} EGP</span>
                </p>
              </div>
              {list.byCategory.length ? (
                <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2" aria-label={`${list.monthLabel} by category`} data-testid="expense-categories">
                  {list.byCategory.map((c) => (
                    <li key={c.category}>
                      <div className="flex items-baseline justify-between gap-2">
                        <Link href={`${monthHref(month)}&category=${c.category}`} className="truncate underline-offset-2 hover:underline">
                          {c.label}
                        </Link>
                        <span className="font-mono text-xs tabular-nums">{formatNumber(c.amount)}</span>
                      </div>
                      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.round((c.amount * 100) / Math.max(1, list.amount)))}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}

          <Card className="overflow-hidden p-0">
            <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4" role="search" aria-label="Search expenses">
              <input type="hidden" name="view" value={view} />
              {view === "month" ? <input type="hidden" name="month" value={month} /> : null}
              <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
                Search
                <Input name="q" defaultValue={q} placeholder="What for, the supplier, the bill no." />
              </label>
              <label className="flex min-w-[10rem] flex-col gap-1 text-xs text-muted-foreground">
                Category
                <Select name="category" defaultValue={category ?? ""}>
                  <option value="">All</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {EXPENSE_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </Select>
              </label>
              <Button type="submit" variant="outline">
                Search
              </Button>
            </form>
            {list.rows.length ? (
              <Table aria-label={view === "due" ? "Bills to pay" : view === "month" ? `Expenses of ${list.monthLabel}` : "Voided expenses"} data-testid="expense-table">
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH className="hidden sm:table-cell">Day</TH>
                    <TH>What</TH>
                    <TH className="hidden text-right sm:table-cell">Amount</TH>
                    <TH>{view === "voided" ? "Why" : view === "due" ? "To pay by" : "Paid"}</TH>
                    {canWrite && view === "due" ? <TH className="hidden text-right sm:table-cell">Act</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {list.rows.map((e) => {
                    const pay = canWrite && e.owed > 0 ? <PayExpenseButton expenseId={e.id} description={e.description} owed={e.owed} billedOn={e.billedOn} timezone={form.timezone} drawerOpen={form.drawerOpen} /> : null;
                    return (
                      <TR key={e.id} className={e.voidedAt ? "text-muted-foreground" : undefined}>
                        <TD className="hidden whitespace-nowrap text-xs sm:table-cell">{dayLabel(e.billedOn)}</TD>
                        <TD>
                          <Link href={`/dashboard/finance/expenses/${e.id}`} className={`font-medium underline-offset-2 hover:underline ${e.voidedAt ? "line-through" : ""}`}>
                            {e.description}
                          </Link>
                          <div className="text-xs text-muted-foreground">
                            {e.supplier?.name ?? "No supplier"} · {e.categoryLabel}
                            {e.recurring ? ` · ${e.recurring.periodLabel}` : ""}
                            {e.files.length ? (
                              <span className="ml-1 inline-flex items-center gap-0.5 align-middle" title={plural(e.files.length, "file")}>
                                · <Paperclip className="h-3 w-3" aria-label={plural(e.files.length, "file")} />
                                {e.files.length}
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs tabular-nums sm:hidden">
                            {dayLabel(e.billedOn)} · {formatNumber(e.amount)} EGP{e.paid && e.owed ? `, ${formatNumber(e.owed)} owed` : ""}
                          </div>
                          {view === "due" && pay ? <div className="mt-2 sm:hidden">{pay}</div> : null}
                        </TD>
                        <TD className="hidden whitespace-nowrap text-right sm:table-cell">
                          <span className="font-mono tabular-nums">{formatNumber(e.amount)}</span>
                          {e.paid && e.owed ? <div className="text-xs text-muted-foreground">{formatNumber(e.owed)} owed</div> : null}
                        </TD>
                        <TD className="text-xs">
                          {view === "voided" ? (
                            <span className="block max-w-[16rem]">{e.voidReason}</span>
                          ) : view === "due" ? (
                            <div className="space-y-1">
                              <ExpenseStatusBadge status={e.status} label={e.statusLabel} daysLate={e.daysLate} />
                              <div className="whitespace-nowrap text-muted-foreground">{e.dueOn ? `${e.overdue ? "Was due" : "By"} ${dayLabel(e.dueOn)}` : "No day set"}</div>
                            </div>
                          ) : (
                            <ExpenseStatusBadge status={e.status} label={e.statusLabel} daysLate={e.daysLate} />
                          )}
                        </TD>
                        {canWrite && view === "due" ? <TD className="hidden text-right sm:table-cell">{pay}</TD> : null}
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            ) : (
              <div className="p-6">
                <EmptyState title={q || category ? "Nothing matches" : EMPTY[list.view === "all" ? "month" : list.view].title} hint={q || category ? "Try other words, another category or another list." : EMPTY[list.view === "all" ? "month" : list.view].hint} />
              </div>
            )}
            {list.total > list.pageSize ? <Pagination page={page} pageSize={list.pageSize} total={list.total} basePath="/dashboard/finance/expenses" query={query} className="border-t border-border" /> : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
