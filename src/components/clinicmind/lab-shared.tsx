import { Badge } from "@/components/ui/primitives";
import type { LabOrderDTO } from "@/modules/lab/orders";

/** Where a lab order stands: late (by how many days), at the lab, its result in (flagged when a doctor must act), cancelled. */
export function LabStatusBadge({ order }: { order: Pick<LabOrderDTO, "status" | "statusLabel" | "late" | "daysLate" | "abnormal"> }) {
  if (order.late) return <Badge tone="danger">{`${order.daysLate} day${order.daysLate === 1 ? "" : "s"} late`}</Badge>;
  if (order.status === "RECEIVED") return <Badge tone={order.abnormal ? "warning" : "success"}>{order.abnormal ? "Result in · to act on" : order.statusLabel}</Badge>;
  if (order.status === "CANCELLED") return <Badge>{order.statusLabel}</Badge>;
  return <Badge tone="accent">{order.statusLabel}</Badge>;
}
