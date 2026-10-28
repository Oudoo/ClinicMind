/**
 * Timezone-aware date helpers built on `Intl.DateTimeFormat` only (no runtime
 * dependency). Every function takes an explicit IANA zone such as
 * "Africa/Cairo" so that day and week boundaries follow the *clinic's* clock,
 * never the server's.
 *
 * Instants are plain `Date`s (UTC underneath); "wall-clock" values are the
 * local date/time a clock on the clinic's wall would show. Conversions handle
 * DST gaps (a wall time that never happens moves forward past the gap) and
 * overlaps (a wall time that happens twice resolves to the earlier instant).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** 0 = Sunday … 6 = Saturday, as `Date.prototype.getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Saturday: the first day of the Egyptian work week. */
export const DEFAULT_WEEK_START: Weekday = 6;

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  /** 0–23 */
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
}

export interface WallClock {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31; values outside the month roll over like `Date.UTC`. */
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of an instant in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAYS.indexOf(read("weekday") as (typeof WEEKDAYS)[number]);
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    // Some engines print "24" for midnight even with hourCycle h23.
    hour: Number(read("hour")) % 24,
    minute: Number(read("minute")),
    second: Number(read("second")),
    weekday: (weekday === -1 ? 0 : weekday) as Weekday,
  };
}

/**
 * Offset of `timeZone` from UTC at the given instant, in milliseconds
 * (wall-clock = UTC + offset). Cairo in winter → +2h, London in summer → +1h.
 */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // formatToParts has second precision; compare against the instant sans ms.
  return asUtc - (date.getTime() - date.getUTCMilliseconds());
}

/**
 * The instant at which a clock in `timeZone` shows the given wall-clock time.
 * A time inside a DST gap (e.g. 01:30 on the night London springs forward)
 * moves forward past the gap; a time that occurs twice (the night clocks go
 * back) resolves to the earlier of the two instants.
 */
export function zonedTimeToUtc(wall: WallClock, timeZone: string): Date {
  const target = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
    wall.millisecond ?? 0,
  );
  // Offsets in force around the target: transitions are days apart, so the
  // offsets one day either side cover both sides of any nearby transition.
  const offsets = [
    ...new Set([target - DAY_MS, target, target + DAY_MS].map((t) => tzOffsetMs(new Date(t), timeZone))),
  ];
  const valid = offsets
    .map((offset) => target - offset)
    .filter((instant) => instant + tzOffsetMs(new Date(instant), timeZone) === target);
  if (valid.length) return new Date(Math.min(...valid));
  // Nonexistent wall time (DST gap): the smaller offset is the one in force
  // before the clocks moved, and subtracting it lands just past the gap.
  return new Date(target - Math.min(...offsets));
}

/** Local midnight of the day containing `date`, as an instant. */
export function startOfDayInTz(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timeZone);
}

/** The last millisecond of the day containing `date` (23:59:59.999 local). */
export function endOfDayInTz(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const nextMidnight = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day + 1 }, timeZone);
  return new Date(nextMidnight.getTime() - 1);
}

/**
 * Add calendar days. With a `timeZone` the wall-clock time is preserved across
 * DST changes (midnight stays midnight); without one, exact 24-hour periods
 * are added.
 */
export function addDays(date: Date, days: number, timeZone?: string): Date {
  if (!timeZone) return new Date(date.getTime() + days * DAY_MS);
  const p = zonedParts(date, timeZone);
  return zonedTimeToUtc(
    {
      year: p.year,
      month: p.month,
      day: p.day + days,
      hour: p.hour,
      minute: p.minute,
      second: p.second,
      millisecond: date.getUTCMilliseconds(),
    },
    timeZone,
  );
}

/** Local midnight of the first day of the week containing `date`. */
export function startOfWeekInTz(
  date: Date,
  timeZone: string,
  weekStartsOn: Weekday = DEFAULT_WEEK_START,
): Date {
  const p = zonedParts(date, timeZone);
  const back = (p.weekday - weekStartsOn + 7) % 7;
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day - back }, timeZone);
}

/** True when both instants fall on the same local calendar day. */
export function isSameDayInTz(a: Date, b: Date, timeZone: string): boolean {
  return dateKeyInTz(a, timeZone) === dateKeyInTz(b, timeZone);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `YYYY-MM-DD` of the local day containing `date` (the key used in URLs and buckets). */
export function dateKeyInTz(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local midnight of a `YYYY-MM-DD` key, or null when the key is not a real date. */
export function fromDateKey(key: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isCalendarDate(year, month, day)) return null;
  return zonedTimeToUtc({ year, month, day }, timeZone);
}

/** Value for an `<input type="datetime-local">` showing `date` on the clinic clock. */
export function toLocalInput(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Instant for a `YYYY-MM-DDTHH:mm` (optionally `:ss`) value typed into a
 * datetime-local input, read on the clinic clock. Null when malformed.
 */
export function fromLocalInput(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  if (!isCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  return zonedTimeToUtc({ year, month, day, hour, minute, second }, timeZone);
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

/**
 * e.g. "24 Oct 2026"; pass `options` to change the fields shown. The same on
 * the server and in every browser: ICU versions disagree on the comma after a
 * weekday ("Mon, 26 Oct" in Chrome, "Mon 26 Oct" in Node), which breaks the
 * hydration of client components, so a weekday is always followed by a space.
 */
export function formatDateInTz(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" },
  locale = "en-GB",
): string {
  const parts = new Intl.DateTimeFormat(locale, { ...options, timeZone }).formatToParts(date);
  return parts.map((p, i) => (p.type === "literal" && parts[i - 1]?.type === "weekday" ? " " : p.value)).join("");
}

/** e.g. "09:30" on the clinic clock (24-hour). */
export function formatTimeInTz(date: Date, timeZone: string, locale = "en-GB"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** e.g. "24 Oct 2026, 09:30". */
export function formatDateTimeInTz(date: Date, timeZone: string, locale = "en-GB"): string {
  return `${formatDateInTz(date, timeZone, undefined, locale)}, ${formatTimeInTz(date, timeZone, locale)}`;
}

/** Minutes between two instants (may be fractional). */
export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}
