import Link from "next/link";
import { cn } from "@/lib/utils";

export type ExpenseTab = "due" | "month" | "recurring" | "voided" | "suppliers";

const TABS: { key: ExpenseTab; label: string; href: string }[] = [
  { key: "due", label: "To pay", href: "/dashboard/finance/expenses?view=due" },
  { key: "month", label: "By month", href: "/dashboard/finance/expenses?view=month" },
  { key: "recurring", label: "Recurring", href: "/dashboard/finance/expenses?view=recurring" },
  { key: "voided", label: "Voided", href: "/dashboard/finance/expenses?view=voided" },
  { key: "suppliers", label: "Suppliers", href: "/dashboard/finance/suppliers" },
];

/** The lists of the Expenses pages, with what is to pay (and whether any of it is late). */
export function ExpenseNav({ current, toPay, overdue }: { current: ExpenseTab; toPay?: number; overdue?: number }) {
  return (
    <nav aria-label="Expense lists" className="-mx-1 overflow-x-auto px-1">
      <ul className="inline-flex h-auto min-w-max items-center gap-0.5 rounded-lg bg-muted p-1 sm:gap-1">
        {TABS.map((t) => {
          const active = t.key === current;
          const count = t.key === "due" ? toPay : undefined;
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                  active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
                {count ? <span className={cn("rounded-md px-1.5 font-mono text-[10px]", overdue ? "bg-danger/10 text-danger" : "bg-card text-muted-foreground")}>{count}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
