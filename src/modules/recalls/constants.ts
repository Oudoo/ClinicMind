import type { ChannelType, RecallKind, RecallStatus, UserRole } from "@prisma/client";

/**
 * The words and rules of the recall list, free of server imports so the
 * worklist and the patient page use the same ones in the browser.
 *
 * A recall is due from `dueAt` (the start of a day on the clinic clock) and
 * on time until `windowEndAt` (the end of a day). While it waits for a
 * booking it is "due soon" in the 14 days before, "due" in its window and
 * "overdue" after it; before that it is upcoming.
 */

export const RECALL_KINDS = ["REVIEW", "NEXT_SESSION", "UNBOOKED", "MISSED", "LAPSED"] as const satisfies readonly RecallKind[];

export const RECALL_KIND_LABEL: Record<RecallKind, string> = {
  REVIEW: "Review",
  NEXT_SESSION: "Next session",
  UNBOOKED: "Treatment not booked",
  MISSED: "Missed visit",
  LAPSED: "No visit in a while",
};

export const RECALL_STATUSES = ["OPEN", "CONTACTED", "SNOOZED", "BOOKED", "DONE", "DECLINED", "UNREACHABLE"] as const satisfies readonly RecallStatus[];

export const RECALL_STATUS_LABEL: Record<RecallStatus, string> = {
  OPEN: "Not contacted",
  CONTACTED: "Contacted",
  SNOOZED: "Snoozed",
  BOOKED: "Booked",
  DONE: "Done",
  DECLINED: "Declined",
  UNREACHABLE: "Unreachable",
};

/** Still being worked: waiting for a booking, or booked and waiting for the visit. */
export const ACTIVE_RECALL_STATUSES = ["OPEN", "CONTACTED", "SNOOZED", "BOOKED"] as const satisfies readonly RecallStatus[];
/** Waiting for a booking. */
export const WAITING_RECALL_STATUSES = ["OPEN", "CONTACTED", "SNOOZED"] as const satisfies readonly RecallStatus[];
/** How a recall ends. */
export const CLOSED_RECALL_STATUSES = ["DONE", "DECLINED", "UNREACHABLE"] as const satisfies readonly RecallStatus[];

export function isClosedRecall(status: RecallStatus): boolean {
  return (CLOSED_RECALL_STATUSES as readonly RecallStatus[]).includes(status);
}

/** Why a patient said no. The last two are the system's, when what the recall followed went away. */
export const DECLINE_REASONS = [
  { key: "price", label: "Price" },
  { key: "timing", label: "Not now" },
  { key: "no_longer_needed", label: "No longer needed" },
  { key: "treated_elsewhere", label: "Treated elsewhere" },
  { key: "moved_away", label: "Moved away" },
  { key: "doctor_advice", label: "Doctor's advice" },
  { key: "other", label: "Another reason" },
  { key: "treatment_cancelled", label: "The treatment was cancelled", system: true },
  { key: "patient_archived", label: "The patient's record was archived", system: true },
] as const satisfies readonly { key: string; label: string; system?: boolean }[];

export type DeclineReason = (typeof DECLINE_REASONS)[number]["key"];
/** The reasons a person picks from. */
export const STAFF_DECLINE_REASONS = DECLINE_REASONS.filter((r) => !("system" in r)).map((r) => r.key) as [DeclineReason, ...DeclineReason[]];

export function declineReasonLabel(key: string | null | undefined): string {
  return DECLINE_REASONS.find((r) => r.key === key)?.label ?? "Declined";
}

/** What came of a call, and what it does to the recall (see service.ts). */
export const CALL_OUTCOMES = [
  { key: "no_answer", label: "No answer", hint: "Try again in 2 days" },
  { key: "call_back", label: "Asked to be called back", hint: "On the day they asked" },
  { key: "thinking", label: "Will think about it", hint: "Try again in 3 days" },
  { key: "will_book", label: "Will book themselves", hint: "Check again in 3 days" },
  { key: "wrong_number", label: "Wrong number", hint: "Ends it as unreachable" },
  { key: "declined", label: "Declined", hint: "Ends it, with the reason" },
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number]["key"];
export const CALL_OUTCOME_KEYS = CALL_OUTCOMES.map((o) => o.key) as [CallOutcome, ...CallOutcome[]];

export function callOutcomeLabel(key: string | null | undefined): string {
  return CALL_OUTCOMES.find((o) => o.key === key)?.label ?? "Call";
}

/** Days until the next try after each outcome (call_back takes the day the patient gave). */
export const RETRY_DAYS: Partial<Record<CallOutcome | "message", number>> = { no_answer: 2, thinking: 3, will_book: 3, message: 3 };
/** Tries without an answer after which the worklist offers "unreachable". */
export const UNREACHABLE_AFTER_TRIES = 3;
/** Days before the due day a recall counts as due soon (and the first automatic message goes). */
export const DUE_SOON_DAYS = 14;
/** A missed or cancelled visit not rebooked within this many hours becomes a recall. */
export const MISSED_AFTER_HOURS = 48;
/** Planned work not booked this many days after it was planned becomes a recall. */
export const UNBOOKED_AFTER_DAYS = 3;
/** No visit for this many months: a lapsed patient (one recall at each). */
export const LAPSED_MONTHS = [12, 18] as const;
/** Patients last seen longer ago than this are left to campaigns, not to the recall list. */
export const LAPSED_HORIZON_MONTHS = 24;

export const RECALL_CHANNELS = ["WHATSAPP", "VOICE", "SMS"] as const satisfies readonly ChannelType[];
export const CHANNEL_LABEL: Record<(typeof RECALL_CHANNELS)[number], string> = { WHATSAPP: "WhatsApp", VOICE: "Phone call", SMS: "SMS" };

export const RECALL_OWNER_ROLES = ["RECEPTIONIST", "NURSE", "DOCTOR", "CLINIC_OWNER"] as const satisfies readonly UserRole[];
export const OWNER_ROLE_LABEL: Record<(typeof RECALL_OWNER_ROLES)[number], string> = {
  RECEPTIONIST: "Reception",
  NURSE: "Nurses",
  DOCTOR: "Doctors",
  CLINIC_OWNER: "The owner",
};

export type RecallBand = "upcoming" | "soon" | "due" | "overdue" | "snoozed" | "booked" | "closed";

const DAY_MS = 86_400_000;
/** Whole days from a to b, both day starts on the clinic clock (rounded: a daylight-saving day is 23 or 25 hours). */
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

/**
 * Where a recall stands today. `days`: until the due day (soon, upcoming),
 * since the due day (due), or past the window's end (overdue).
 * `todayStart` is the start of today on the clinic clock.
 */
export function recallBand(
  r: { status: RecallStatus; dueAt: Date; windowEndAt: Date },
  todayStart: Date,
): { band: RecallBand; days: number } {
  if (isClosedRecall(r.status)) return { band: "closed", days: 0 };
  if (r.status === "BOOKED") return { band: "booked", days: 0 };
  if (r.status === "SNOOZED") return { band: "snoozed", days: 0 };
  const untilDue = daysBetween(todayStart, r.dueAt);
  if (untilDue > DUE_SOON_DAYS) return { band: "upcoming", days: untilDue };
  if (untilDue > 0) return { band: "soon", days: untilDue };
  if (r.windowEndAt.getTime() >= todayStart.getTime()) return { band: "due", days: -untilDue };
  // The window ended yesterday or before: overdue by the days since its last day.
  return { band: "overdue", days: Math.max(1, daysBetween(r.windowEndAt, todayStart) + 1) };
}

export function bandLabel(b: { band: RecallBand; days: number }): string {
  switch (b.band) {
    case "upcoming":
      return `Due in ${b.days} days`;
    case "soon":
      return b.days === 1 ? "Due tomorrow" : `Due in ${b.days} days`;
    case "due":
      return b.days === 0 ? "Due today" : `Due ${b.days} day${b.days === 1 ? "" : "s"} ago`;
    case "overdue":
      return `Overdue ${b.days} day${b.days === 1 ? "" : "s"}`;
    case "snoozed":
      return "Snoozed";
    case "booked":
      return "Booked";
    case "closed":
      return "Closed";
  }
}

/** The order of the worklist: overdue first (longest first), then due (longest in first), then due soon (nearest first); the higher value first on a tie. */
export function urgencyRank(b: { band: RecallBand; days: number }): number {
  switch (b.band) {
    case "overdue":
      return 3_000_000 + b.days;
    case "due":
      return 2_000_000 + b.days;
    case "soon":
      return 1_000_000 - b.days;
    case "upcoming":
      return 500_000 - b.days;
    default:
      return 0;
  }
}

export const BAND_TONE: Record<RecallBand, "default" | "success" | "warning" | "danger" | "accent"> = {
  upcoming: "default",
  soon: "accent",
  due: "warning",
  overdue: "danger",
  snoozed: "default",
  booked: "success",
  closed: "default",
};
