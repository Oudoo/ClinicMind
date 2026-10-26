import { Badge } from "@/components/ui/primitives";
import { KIND_LABEL, STATUS_LABEL, type AppointmentKind, type AppointmentStatus } from "@/modules/appointments/transitions";

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

/** The booking's kind (consultation, follow-up, procedure, check-up) as a quiet badge. */
export function AppointmentKindBadge({ kind, className }: { kind: AppointmentKind; className?: string }) {
  return (
    <Badge tone="default" className={className} title="Appointment kind">
      {KIND_LABEL[kind]}
    </Badge>
  );
}
