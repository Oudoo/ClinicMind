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

/**
 * The booking's status. A scheduled booking whose patient was asked to
 * confirm a new time (`awaitingSince`, the request) reads "Awaiting patient"
 * until they answer.
 */
export function AppointmentStatusBadge({
  status,
  awaitingSince,
  className,
}: {
  status: AppointmentStatus;
  awaitingSince?: string | null;
  className?: string;
}) {
  if (status === "SCHEDULED" && awaitingSince) {
    return (
      <Badge tone="warning" className={className} title="Asked to confirm the new time on WhatsApp: no answer yet">
        Awaiting patient
      </Badge>
    );
  }
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
