import { addDays, dateKeyInTz, formatTimeInTz, startOfDayInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { parseHHMM } from "./slots";
import {
  allowedTransitions,
  SLOT_STEP_MINUTES,
  type AppointmentStatus,
  type WorkingHours,
} from "./transitions";

/**
 * The clock rules of the appointment book, as pure functions so the service
 * (the authority), every menu that offers an action and the tests share one
 * definition. No server imports: client components use them too.
 *
 *  - Marking a no-show needs the start time to have passed (`too_early`).
 *  - Check-in is open on the appointment's day on the clinic clock and closes
 *    two hours after the slot ends (`not_today`); re-booking a no-show into
 *    its own slot follows the same window (the patient turned up late).
 *  - A consultation cannot start on a future day (`not_today`) and cannot be
 *    completed before the booked start (`too_early`).
 *  - A booking or a move may start at most 15 minutes before now
 *    (`in_the_past`) and must sit inside the opening hours (`outside_hours`);
 *    the owner may override either on purpose.
 */

/** A booking may start this many minutes before now (a walk-in entered a moment late); earlier is "in the past". */
export const PAST_GRACE_MINUTES = 15;
/** Check-in stays open this long after the slot ends, on the same clinic day. */
export const CHECK_IN_CLOSES_AFTER_END_MINUTES = 120;

const MINUTE = 60_000;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * "Thu 29 Oct" on the clinic clock, built from the numeric parts so text
 * rendered on the server and hydrated in the browser is identical.
 */
export function clinicDayLabel(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${WEEKDAY_SHORT[p.weekday]} ${String(p.day).padStart(2, "0")} ${MONTH_SHORT[p.month - 1]}`;
}

// ── Transitions ──────────────────────────────────────────────────────────────

export type TransitionTimeCode = "too_early" | "not_today";

export interface TransitionTimeBlock {
  code: TransitionTimeCode;
  message: string;
}

export interface TimedAppointment {
  status: AppointmentStatus;
  startsAt: Date | string;
  endsAt: Date | string;
}

function checkInWindow(start: Date, end: Date, now: Date, timeZone: string, what: string): TransitionTimeBlock | null {
  const visitDay = dateKeyInTz(start, timeZone);
  const today = dateKeyInTz(now, timeZone);
  if (visitDay > today) {
    return { code: "not_today", message: `${what} opens on the day of the appointment (${clinicDayLabel(start, timeZone)}).` };
  }
  if (visitDay < today || now.getTime() > end.getTime() + CHECK_IN_CLOSES_AFTER_END_MINUTES * MINUTE) {
    return {
      code: "not_today",
      message: `${what} closed two hours after the appointment ended (${formatTimeInTz(end, timeZone)} on ${clinicDayLabel(start, timeZone)}). Mark it as a no-show or book a new appointment.`,
    };
  }
  return null;
}

/**
 * Why moving `a` to `to` is not possible at `now`, or null when the clock
 * allows it. The state machine (`canTransition`) is checked separately.
 */
export function transitionTimeBlock(a: TimedAppointment, to: AppointmentStatus, now: Date, timeZone: string): TransitionTimeBlock | null {
  const start = new Date(a.startsAt);
  const end = new Date(a.endsAt);
  const started = now.getTime() >= start.getTime();
  const at = () =>
    dateKeyInTz(start, timeZone) === dateKeyInTz(now, timeZone)
      ? formatTimeInTz(start, timeZone)
      : `${clinicDayLabel(start, timeZone)} ${formatTimeInTz(start, timeZone)}`;
  switch (to) {
    case "NO_SHOW":
      return started ? null : { code: "too_early", message: `A no-show can only be marked once the appointment has started (${at()}).` };
    case "CHECKED_IN":
      return checkInWindow(start, end, now, timeZone, "Check-in");
    case "SCHEDULED":
      // Re-booking a no-show into its own (past) slot is for a patient who turned up late.
      return a.status === "NO_SHOW" ? checkInWindow(start, end, now, timeZone, "Re-booking a no-show into its slot") : null;
    case "IN_PROGRESS":
      return dateKeyInTz(start, timeZone) > dateKeyInTz(now, timeZone)
        ? { code: "not_today", message: `The consultation can start on the day of the appointment (${clinicDayLabel(start, timeZone)}).` }
        : null;
    case "COMPLETED":
      return started ? null : { code: "too_early", message: `An appointment cannot be completed before its start time (${at()}).` };
    default:
      return null;
  }
}

/** The moves the state machine allows from the current status that the clock also allows right now. */
export function availableTransitions(a: TimedAppointment, now: Date, timeZone: string): AppointmentStatus[] {
  return allowedTransitions(a.status).filter((to) => !transitionTimeBlock(a, to, now, timeZone));
}

// ── Bookings ─────────────────────────────────────────────────────────────────

/** True when a booking would start more than the grace period before `now`. */
export function isInThePast(startsAt: Date, now: Date): boolean {
  return startsAt.getTime() < now.getTime() - PAST_GRACE_MINUTES * MINUTE;
}

/** "Sat–Thu 10:00–20:00" (the week read from Saturday, the first day of the Egyptian week). */
export function describeHours(h: WorkingHours): string {
  const days = [...h.days].sort((a, b) => ((a + 1) % 7) - ((b + 1) % 7));
  const consecutive = days.every((d, i) => i === 0 || (days[i - 1]! + 1) % 7 === d);
  const names = days.map((d) => WEEKDAY_SHORT[d]);
  const range = days.length > 2 && consecutive ? `${names[0]}–${names[names.length - 1]}` : names.join(", ");
  return `${range} ${h.start}–${h.end}`;
}

/** "Friday closed", "Friday and Saturday closed", or "" when the clinic opens every day. */
export function closedDaysLabel(h: WorkingHours): string {
  const closed = [5, 6, 0, 1, 2, 3, 4].filter((d) => !h.days.includes(d)).map((d) => WEEKDAY_LONG[d]);
  if (!closed.length) return "";
  return `${closed.length > 1 ? `${closed.slice(0, -1).join(", ")} and ${closed.at(-1)}` : closed[0]} closed`;
}

/** True when the clinic does not open on the weekday of `date` (clinic clock). */
export function isClosedDay(date: Date, hours: WorkingHours, timeZone: string): boolean {
  return !hours.days.includes(zonedParts(date, timeZone).weekday);
}

export interface HoursViolation {
  reason: "closed_day" | "outside_span";
  message: string;
}

/**
 * Whether a slot sits inside the opening hours on the clinic clock: an open
 * weekday, starting at or after opening and ending at or before closing on
 * the same day. Null when it does.
 */
export function hoursViolation(startsAt: Date, endsAt: Date, hours: WorkingHours, timeZone: string): HoursViolation | null {
  const s = zonedParts(startsAt, timeZone);
  if (!hours.days.includes(s.weekday)) {
    return { reason: "closed_day", message: `The clinic is closed on ${WEEKDAY_LONG[s.weekday]}s. Opening hours: ${describeHours(hours)}.` };
  }
  const open = parseHHMM(hours.start) ?? 0;
  const close = parseHHMM(hours.end) ?? 24 * 60;
  const startMinute = s.hour * 60 + s.minute + s.second / 60;
  const e = zonedParts(endsAt, timeZone);
  const sameDay = dateKeyInTz(endsAt, timeZone) === dateKeyInTz(startsAt, timeZone);
  const endsAtMidnight = !sameDay && e.hour === 0 && e.minute === 0 && e.second === 0 && endsAt.getTime() - startsAt.getTime() <= 24 * 60 * MINUTE;
  const endMinute = sameDay ? e.hour * 60 + e.minute + e.second / 60 : endsAtMidnight ? 24 * 60 : Number.POSITIVE_INFINITY;
  if (startMinute < open || endMinute > close) {
    return { reason: "outside_span", message: `That time is outside the opening hours (${describeHours(hours)}).` };
  }
  return null;
}

/**
 * The first start on the slot grid (opening time + n × step) at or after
 * `from` that fits `durationMinutes` before closing on an open day, looking
 * two weeks ahead; null when the hours leave no room at all.
 */
export function nextOpenStart(
  from: Date,
  hours: WorkingHours,
  timeZone: string,
  durationMinutes = 30,
  stepMinutes: number = SLOT_STEP_MINUTES,
): Date | null {
  const open = parseHHMM(hours.start) ?? 0;
  const close = parseHHMM(hours.end) ?? 24 * 60;
  let day = startOfDayInTz(from, timeZone);
  for (let i = 0; i < 14; i++) {
    const p = zonedParts(day, timeZone);
    if (hours.days.includes(p.weekday)) {
      for (let minute = open; minute + durationMinutes <= close; minute += stepMinutes) {
        const start = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(minute / 60), minute: minute % 60 }, timeZone);
        if (start.getTime() >= from.getTime()) return start;
      }
    }
    day = addDays(day, 1, timeZone);
  }
  return null;
}
