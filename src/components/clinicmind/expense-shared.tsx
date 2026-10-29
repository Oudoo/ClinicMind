import { Badge } from "@/components/ui/primitives";
import type { ExpenseStatusValue } from "@/modules/finance/expense-constants";
import type { BadgeTone } from "./patient-shared";

const TONES: Record<ExpenseStatusValue, BadgeTone> = { OPEN: "warning", PART_PAID: "accent", PAID: "success", VOID: "default" };

/** Where an expense stands: late (by how many days), to pay, part paid, paid or voided. */
export function ExpenseStatusBadge({ status, label, daysLate }: { status: ExpenseStatusValue; label: string; daysLate: number | null }) {
  if (daysLate !== null && status !== "PAID" && status !== "VOID") return <Badge tone="danger">{daysLate === 0 ? "Due today" : `${daysLate} day${daysLate === 1 ? "" : "s"} late`}</Badge>;
  return <Badge tone={TONES[status]}>{label}</Badge>;
}

/** "29 Oct 2026" from a day key, on any clock (a day is a day). */
export function dayLabel(key: string, opts: { year?: boolean } = {}): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(opts.year === false ? {} : { year: "numeric" }), timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`));
}
