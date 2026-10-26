import { LATE_AFTER_MINUTES, STATUS_LABEL, type AppointmentStatus } from "./transitions";

/**
 * Wording of the live countdown on the "next appointment" button and the
 * "late" flag of the queue strip. Pure (no Date.now, no server imports) so the
 * client ticks it every second and the tests pin the boundaries.
 */

export type CountdownTone = "default" | "accent" | "success" | "warning" | "danger";

export interface Countdown {
  /** e.g. "starts in 12 min", "started 3 min ago", "running late". */
  label: string;
  tone: CountdownTone;
  /** Past the start without a check-in, or checked in and waiting too long. */
  late: boolean;
  /** Signed minutes from now to the start (negative once started). */
  minutesToStart: number;
}

const MINUTE = 60_000;

/** "less than a minute", "12 min", "1 h 05 min", "2 days". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return "less than a minute";
  const minutes = Math.floor(abs / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${String(rest).padStart(2, "0")} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/** True for a booking that is past its start with nobody checked in, or checked in and waiting too long. */
export function isRunningLate(
  a: { startsAt: Date | string; status: AppointmentStatus },
  now: Date,
): boolean {
  const start = new Date(a.startsAt).getTime();
  const sinceStart = now.getTime() - start;
  if (a.status === "SCHEDULED" || a.status === "CONFIRMED") return sinceStart >= MINUTE;
  if (a.status === "CHECKED_IN") return sinceStart >= LATE_AFTER_MINUTES * MINUTE;
  return false;
}

export function describeCountdown(
  a: { startsAt: Date | string; endsAt: Date | string; status: AppointmentStatus },
  now: Date,
): Countdown {
  const start = new Date(a.startsAt).getTime();
  const end = new Date(a.endsAt).getTime();
  const toStart = start - now.getTime();
  const minutesToStart = Math.round(toStart / MINUTE);
  const late = isRunningLate(a, now);

  switch (a.status) {
    case "IN_PROGRESS":
      return {
        label: toStart > 0 ? "in consultation" : `in consultation · started ${formatDuration(-toStart)} ago`,
        tone: "accent",
        late: false,
        minutesToStart,
      };
    case "CHECKED_IN":
      if (late) return { label: `running late · waiting ${formatDuration(-toStart)}`, tone: "danger", late: true, minutesToStart };
      if (toStart > 0) return { label: `checked in · starts in ${formatDuration(toStart)}`, tone: "success", late: false, minutesToStart };
      return { label: `checked in · started ${formatDuration(-toStart)} ago`, tone: "success", late: false, minutesToStart };
    case "SCHEDULED":
    case "CONFIRMED":
      if (late) {
        const overdue = now.getTime() >= end ? " · slot over" : "";
        return { label: `started ${formatDuration(-toStart)} ago · not checked in${overdue}`, tone: "warning", late: true, minutesToStart };
      }
      return {
        label: toStart < MINUTE ? "starting now" : `starts in ${formatDuration(toStart)}`,
        tone: toStart <= 15 * MINUTE ? "accent" : "default",
        late: false,
        minutesToStart,
      };
    default:
      return { label: STATUS_LABEL[a.status].toLowerCase(), tone: "default", late: false, minutesToStart };
  }
}
