import { Badge } from "@/components/ui/primitives";
import { STATUS_LABEL, type AppointmentStatus } from "@/modules/appointments/transitions";

type Tone = "default" | "accent" | "success" | "warning" | "danger";

export const STATUS_TONE: Record<AppointmentStatus, Tone> = {
  SCHEDULED: "default",
  CONFIRMED: "accent",
  CHECKED_IN: "accent",
  IN_PROGRESS: "accent",
  COMPLETED: "success",
  WAITLISTED: "warning",
  CANCELLED: "danger",
  NO_SHOW: "danger",
};

export function AppointmentStatusBadge({ status, className }: { status: AppointmentStatus; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
