import { zonedParts, zonedTimeToUtc } from "@/lib/time";
import {
  DEFAULT_WORKING_HOURS,
  SLOT_STEP_MINUTES,
  type AppointmentStatus,
  type WorkingHours,
} from "./transitions";

/**
 * The free-slot grid: pure functions over working hours and the day's live
 * bookings, so the search is unit-tested without a database and the service
 * only supplies the rows. Times are instants; the grid is laid out on the
 * clinic clock (DST-safe through `zonedTimeToUtc`).
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(value: string): number | null {
  const m = HHMM.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The `hours` tenant setting as stored, repaired field by field; anything unusable falls back to the default. */
export function normaliseHours(raw: unknown): WorkingHours {
  const fallback = DEFAULT_WORKING_HOURS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...fallback, days: [...fallback.days] };
  const r = raw as Record<string, unknown>;
  const days = Array.isArray(r.days)
    ? [...new Set(r.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))]
    : [...fallback.days];
  const start = typeof r.start === "string" && parseHHMM(r.start) !== null ? r.start.trim() : fallback.start;
  const end = typeof r.end === "string" && parseHHMM(r.end) !== null ? r.end.trim() : fallback.end;
  if (parseHHMM(start)! >= parseHHMM(end)!) return { days, start: fallback.start, end: fallback.end };
  return { days: days.length ? days : [...fallback.days], start, end };
}

export interface TakenRange {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  doctorId: string | null;
  room: string | null;
  patientId: string;
  patientName: string;
  patientInitials: string;
}

export interface SlotCell {
  startsAt: Date;
  endsAt: Date;
  /** Inside working hours, not in the past and clear of every taken range. */
  free: boolean;
  /** Before `notBefore` (usually now). */
  past: boolean;
  takenBy: TakenRange[];
}

export interface SlotGrid {
  /** The clinic does not open on this weekday. */
  closed: boolean;
  cells: SlotCell[];
}

export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function overlaps(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && a.endsAt.getTime() > b.startsAt.getTime();
}

/**
 * Every start time on the grid for one clinic day: `durationMinutes` long,
 * `stepMinutes` apart, inside the working hours, with the bookings that make
 * a cell unavailable attached.
 */
export function buildSlotGrid(opts: {
  /** Any instant of the day (its local date is used). */
  day: Date;
  timeZone: string;
  hours: WorkingHours;
  durationMinutes: number;
  stepMinutes?: number;
  taken: readonly TakenRange[];
  /** Cells starting before this instant are marked past (not free). */
  notBefore?: Date | null;
}): SlotGrid {
  const step = opts.stepMinutes ?? SLOT_STEP_MINUTES;
  const p = zonedParts(opts.day, opts.timeZone);
  if (!opts.hours.days.includes(p.weekday)) return { closed: true, cells: [] };
  const open = parseHHMM(opts.hours.start) ?? 0;
  const close = parseHHMM(opts.hours.end) ?? 24 * 60;
  const cells: SlotCell[] = [];
  for (let minute = open; minute + opts.durationMinutes <= close; minute += step) {
    const startsAt = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(minute / 60), minute: minute % 60 }, opts.timeZone);
    const endsAt = new Date(startsAt.getTime() + opts.durationMinutes * 60_000);
    const cell = { startsAt, endsAt };
    const takenBy = opts.taken.filter((t) => overlaps(cell, t));
    const past = Boolean(opts.notBefore) && startsAt.getTime() < opts.notBefore!.getTime();
    cells.push({ startsAt, endsAt, free: !past && takenBy.length === 0, past, takenBy });
  }
  return { closed: false, cells };
}

/** The first `count` free cells that start strictly after `after`. */
export function freeCellsAfter(cells: readonly SlotCell[], after: Date, count: number): SlotCell[] {
  return cells.filter((c) => c.free && c.startsAt.getTime() > after.getTime()).slice(0, count);
}
