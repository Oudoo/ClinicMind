import { Ban, Check, CheckCheck, Circle, Hourglass, MessageCircleQuestion, Play, UserCheck, UserX, type LucideIcon } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, type AppointmentStatus } from "@/modules/appointments/transitions";

/**
 * How each status reads: its word, a mark of its own and a tone, so no two steps of the visit
 * look alike and none is told by colour alone. Amber is "someone is waiting" (the patient in
 * the clinic, or the clinic for the patient's answer); the solid chip is the visit under way.
 */
export const STATUS_STYLE: Record<AppointmentStatus, { tone: Tone; Icon: LucideIcon; className?: string }> = {
  SCHEDULED: { tone: "default", Icon: Circle },
  CONFIRMED: { tone: "accent", Icon: Check },
  CHECKED_IN: { tone: "warning", Icon: UserCheck },
  IN_PROGRESS: { tone: "accent", Icon: Play, className: "bg-accent text-accent-foreground" },
  COMPLETED: { tone: "success", Icon: CheckCheck },
  WAITLISTED: { tone: "default", Icon: Hourglass },
  CANCELLED: { tone: "default", Icon: Ban, className: "bg-transparent ring-1 ring-inset ring-border" },
  NO_SHOW: { tone: "danger", Icon: UserX },
};

/** The tone as a text colour, for a status written without a chip. */
const TONE_TEXT: Record<Tone, string> = {
  default: "text-muted-foreground",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * The booking's status. A scheduled booking whose patient was asked to
 * confirm a new time (`awaitingSince`, the request) reads "Awaiting patient"
 * until they answer. `plain` writes it as a mark and a word without the chip,
 * for narrow places (a day's column of the week): it shortens instead of overflowing.
 */
export function AppointmentStatusBadge({
  status,
  awaitingSince,
  plain = false,
  className,
}: {
  status: AppointmentStatus;
  awaitingSince?: string | null;
  plain?: boolean;
  className?: string;
}) {
  const awaiting = status === "SCHEDULED" && Boolean(awaitingSince);
  const style = STATUS_STYLE[status];
  const Icon = awaiting ? MessageCircleQuestion : style.Icon;
  const tone: Tone = awaiting ? "warning" : style.tone;
  const label = awaiting ? "Awaiting patient" : STATUS_LABEL[status];
  const title = awaiting ? "Asked to confirm the new time on WhatsApp: no answer yet" : undefined;
  if (plain) {
    return (
      <span className={cn("flex min-w-0 items-center gap-1 text-xs font-medium", TONE_TEXT[tone], className)} title={title ?? label}>
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <Badge tone={tone} className={cn("gap-1", awaiting ? null : style.className, className)} title={title}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {label}
    </Badge>
  );
}
