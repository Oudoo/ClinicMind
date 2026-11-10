import { AlertTriangle, Ban, CircleCheck, CircleDot, Clock, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import type { ExpenseStatusValue } from "@/modules/finance/expense-constants";
import type { BadgeTone } from "./patient-shared";

/** How each state reads: its tone and a mark of its own, so none is told by colour alone. */
const STYLE: Record<ExpenseStatusValue, { tone: BadgeTone; Icon: LucideIcon }> = {
  OPEN: { tone: "warning", Icon: Clock },
  PART_PAID: { tone: "warning", Icon: CircleDot },
  PAID: { tone: "success", Icon: CircleCheck },
  VOID: { tone: "default", Icon: Ban },
};

/** Where an expense stands: late (by how many days), due today, to pay, part paid, paid or voided. */
export function ExpenseStatusBadge({ status, label, daysLate }: { status: ExpenseStatusValue; label: string; daysLate: number | null }) {
  if (daysLate !== null && status !== "PAID" && status !== "VOID") {
    const today = daysLate === 0;
    return (
      <Badge tone={today ? "warning" : "danger"} className="gap-1">
        {today ? <Clock className="h-3 w-3 shrink-0" aria-hidden="true" /> : <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />}
        {today ? "Due today" : `${daysLate} day${daysLate === 1 ? "" : "s"} late`}
      </Badge>
    );
  }
  const { tone, Icon } = STYLE[status];
  return (
    <Badge tone={tone} className="gap-1">
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** "29 Oct 2026" from a day key, on any clock (a day is a day). */
export function dayLabel(key: string, opts: { year?: boolean } = {}): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(opts.year === false ? {} : { year: "numeric" }), timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`));
}
