/**
 * The appointment state machine and the constants shared by the service, the
 * API and the booking UI. This module is deliberately free of server imports
 * (no Prisma, no db) so client components can use it.
 */

export const APPOINTMENT_STATUSES = [
  "SCHEDULED",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "WAITLISTED",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Allowed transitions. COMPLETED and CANCELLED are terminal; a WAITLISTED
 * booking is only promoted to SCHEDULED when its slot is free, and a NO_SHOW
 * can be re-booked into the same slot.
 */
export const TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  SCHEDULED: ["CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED"],
  WAITLISTED: ["SCHEDULED", "CANCELLED"],
  NO_SHOW: ["SCHEDULED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function allowedTransitions(from: AppointmentStatus): readonly AppointmentStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses that do not occupy their slot and therefore never conflict. */
export const NON_BLOCKING_STATUSES = ["CANCELLED", "NO_SHOW", "WAITLISTED"] as const satisfies readonly AppointmentStatus[];

/** Statuses whose slot (time, doctor, room) may still be changed. */
export const RESCHEDULABLE_STATUSES = ["SCHEDULED", "CONFIRMED", "WAITLISTED"] as const satisfies readonly AppointmentStatus[];

export function isReschedulable(status: AppointmentStatus): boolean {
  return (RESCHEDULABLE_STATUSES as readonly AppointmentStatus[]).includes(status);
}

export function isTerminal(status: AppointmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Cancelling must say why; the reason is also shown on the patient timeline. */
export const REASON_REQUIRED_FOR: readonly AppointmentStatus[] = ["CANCELLED"];
export const MAX_REASON_LENGTH = 300;

export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 480;
export const DURATION_OPTIONS = [15, 20, 30, 45, 60] as const;

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  SCHEDULED: "Scheduled",
  CONFIRMED: "Confirmed",
  CHECKED_IN: "Checked in",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
  WAITLISTED: "Waitlisted",
};

/** Menu wording for moving an appointment from one status to another. */
export function transitionLabel(from: AppointmentStatus, to: AppointmentStatus): string {
  switch (to) {
    case "CONFIRMED":
      return "Confirm";
    case "CHECKED_IN":
      return "Check in";
    case "IN_PROGRESS":
      return "Start consultation";
    case "COMPLETED":
      return "Complete";
    case "CANCELLED":
      return "Cancel";
    case "NO_SHOW":
      return "Mark as no-show";
    case "SCHEDULED":
      return from === "WAITLISTED" ? "Promote to schedule" : "Re-book same slot";
    case "WAITLISTED":
      return "Waitlist";
  }
}
