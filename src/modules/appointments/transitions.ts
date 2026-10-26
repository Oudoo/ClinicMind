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

// ── Kinds ────────────────────────────────────────────────────────────────────

export const APPOINTMENT_KINDS = ["CONSULTATION", "FOLLOW_UP", "PROCEDURE", "CHECK_UP"] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];

export const KIND_LABEL: Record<AppointmentKind, string> = {
  CONSULTATION: "Consultation",
  FOLLOW_UP: "Follow-up",
  PROCEDURE: "Procedure",
  CHECK_UP: "Check-up",
};

// ── Live bookings, lateness and the slot grid ────────────────────────────────

/** Statuses of a booking that is still ahead or under way (what the "next appointment" button shows). */
export const LIVE_STATUSES = ["SCHEDULED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"] as const satisfies readonly AppointmentStatus[];

export function isLive(status: AppointmentStatus): boolean {
  return (LIVE_STATUSES as readonly AppointmentStatus[]).includes(status);
}

/** A checked-in patient still waiting this many minutes past the start is "running late". */
export const LATE_AFTER_MINUTES = 10;
/** A booking with no check-in this many minutes past its start is flagged to reception once. */
export const NO_SHOW_FLAG_AFTER_MINUTES = 20;
/** Free slots are offered on this grid. */
export const SLOT_STEP_MINUTES = 15;

/** Tenant setting `hours`: open weekdays (0 = Sunday … 6 = Saturday) and the daily opening span. */
export interface WorkingHours {
  days: number[];
  /** `HH:mm` on the clinic clock. */
  start: string;
  end: string;
}

/** Saturday to Thursday, 10:00–20:00; Friday closed. */
export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [6, 0, 1, 2, 3, 4], start: "10:00", end: "20:00" };

// ── Dictated notes ───────────────────────────────────────────────────────────

export const APPOINTMENT_NOTE_KINDS = ["DICTATION", "TEXT"] as const;
export type AppointmentNoteKind = (typeof APPOINTMENT_NOTE_KINDS)[number];
export const MAX_NOTE_LENGTH = 5000;
export const NOTE_LANGUAGES = ["auto", "ar", "en"] as const;
export type NoteLanguage = (typeof NOTE_LANGUAGES)[number];
export const LANGUAGE_LABEL: Record<string, string> = { ar: "Arabic", en: "English", auto: "Auto" };
