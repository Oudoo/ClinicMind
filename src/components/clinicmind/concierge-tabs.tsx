import Link from "next/link";
import { cn } from "@/lib/utils";

export type ConciergeTab = "board" | "enrolments" | "protocols" | "roster";

export const CONCIERGE_TABS: { key: ConciergeTab; label: string; short?: string }[] = [
  { key: "board", label: "Board" },
  { key: "enrolments", label: "Enrolments" },
  { key: "protocols", label: "Protocols" },
  { key: "roster", label: "Roster & hours", short: "Roster" },
];

/** The concierge page's tabs as links (`?tab=`), so each tab is its own server render and shareable. */
export function ConciergeTabs({ active, badges = {} }: { active: ConciergeTab; badges?: Partial<Record<ConciergeTab, number>> }) {
  return (
    <nav aria-label="Concierge sections" className="-mx-1 overflow-x-auto px-1">
      <ul className="inline-flex h-auto min-w-max items-center gap-0.5 rounded-lg bg-muted p-1 sm:gap-1">
        {CONCIERGE_TABS.map((t) => {
          const current = t.key === active;
          const count = badges[t.key];
          return (
            <li key={t.key}>
              <Link
                href={t.key === "board" ? "/dashboard/concierge" : `/dashboard/concierge?tab=${t.key}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                  current ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.short ? (
                  <>
                    <span className="sm:hidden">{t.short}</span>
                    <span className="hidden sm:inline">{t.label}</span>
                  </>
                ) : (
                  t.label
                )}
                {count ? <span className="rounded-md bg-danger/10 px-1.5 font-mono text-[10px] text-danger">{count}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
