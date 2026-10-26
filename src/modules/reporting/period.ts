import { addDays, dateKeyInTz, endOfDayInTz, fromDateKey, startOfDayInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";

/**
 * Reporting periods on the clinic clock. A period is a half-open interval
 * [from, to); the comparison period is the interval of equal length that ends
 * where the period starts. Shared by the finance dashboard, the reports and
 * the patient data dashboard. No server imports: client components may use it.
 */
export const PERIOD_PRESETS = ["today", "7d", "28d", "month", "90d", "custom"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Today",
  "7d": "7 days",
  "28d": "28 days",
  month: "This month",
  "90d": "90 days",
  custom: "Custom",
};

export interface Period {
  /** Inclusive start instant. */
  from: Date;
  /** Exclusive end instant. */
  to: Date;
}

export interface ResolvedPeriod extends Period {
  preset: PeriodPreset;
  /** Local date keys (YYYY-MM-DD) of the first and last day of the period. */
  fromKey: string;
  toKey: string;
  /** The preceding period of equal length. */
  previous: Period;
  /** Whole local days in the period. */
  days: number;
  label: string;
}

export interface PeriodQuery {
  period?: string | null;
  from?: string | null;
  to?: string | null;
}

const MAX_DAYS = 366;

export function isPeriodPreset(value: unknown): value is PeriodPreset {
  return typeof value === "string" && (PERIOD_PRESETS as readonly string[]).includes(value);
}

/** The number of whole days between two instants on the clinic clock. */
export function daysBetweenInTz(from: Date, to: Date, timeZone: string): number {
  const a = startOfDayInTz(from, timeZone).getTime();
  const b = startOfDayInTz(to, timeZone).getTime();
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

/**
 * Resolve `?period=28d` (or `?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`)
 * into instants on the clinic clock. Invalid input falls back to 28 days.
 */
export function resolvePeriod(query: PeriodQuery, timeZone: string, now: Date = new Date(), fallback: PeriodPreset = "28d"): ResolvedPeriod {
  let preset: PeriodPreset = isPeriodPreset(query.period) ? query.period : fallback;
  const todayStart = startOfDayInTz(now, timeZone);
  const tomorrowStart = addDays(todayStart, 1, timeZone);
  let from: Date;
  let to: Date;

  if (preset === "custom") {
    const f = query.from ? fromDateKey(query.from, timeZone) : null;
    const t = query.to ? fromDateKey(query.to, timeZone) : null;
    if (f && t && t.getTime() >= f.getTime()) {
      from = f;
      to = addDays(t, 1, timeZone);
      if (daysBetweenInTz(from, to, timeZone) > MAX_DAYS) from = addDays(to, -MAX_DAYS, timeZone);
    } else {
      preset = fallback === "custom" ? "28d" : fallback;
      from = addDays(todayStart, -27, timeZone);
      to = tomorrowStart;
    }
  }
  if (preset === "today") {
    from = todayStart;
    to = tomorrowStart;
  } else if (preset === "7d") {
    from = addDays(todayStart, -6, timeZone);
    to = tomorrowStart;
  } else if (preset === "28d") {
    from = addDays(todayStart, -27, timeZone);
    to = tomorrowStart;
  } else if (preset === "90d") {
    from = addDays(todayStart, -89, timeZone);
    to = tomorrowStart;
  } else if (preset === "month") {
    const p = zonedParts(now, timeZone);
    from = zonedTimeToUtc({ year: p.year, month: p.month, day: 1 }, timeZone);
    to = tomorrowStart;
  }

  const days = daysBetweenInTz(from!, to!, timeZone);
  const previous: Period = { from: addDays(from!, -days, timeZone), to: from! };
  const fromKey = dateKeyInTz(from!, timeZone);
  const toKey = dateKeyInTz(new Date(to!.getTime() - 1), timeZone);
  const label = preset === "custom" || preset === "month" ? `${fromKey} → ${toKey}` : PRESET_LABELS[preset];
  return { preset, from: from!, to: to!, fromKey, toKey, previous, days, label };
}

/** `{ period, from, to }` query entries for links that keep the current period. */
export function periodQuery(period: ResolvedPeriod): Record<string, string> {
  return period.preset === "custom" ? { period: "custom", from: period.fromKey, to: period.toKey } : { period: period.preset };
}

/** A window of `days` days ending now (used by alert rules). */
export function windowEndingNow(days: number, timeZone: string, now: Date = new Date()): ResolvedPeriod {
  const to = new Date(now.getTime() + 1);
  const from = addDays(startOfDayInTz(now, timeZone), -(days - 1), timeZone);
  const previous: Period = { from: addDays(from, -days, timeZone), to: from };
  return {
    preset: "custom",
    from,
    to,
    fromKey: dateKeyInTz(from, timeZone),
    toKey: dateKeyInTz(now, timeZone),
    previous,
    days,
    label: `Last ${days} days`,
  };
}

/** Bucket boundaries (local midnights) for a period, by day up to 31 days, else by week. */
export function periodBuckets(period: Period, timeZone: string): { start: Date; end: Date; label: string }[] {
  const days = daysBetweenInTz(period.from, period.to, timeZone);
  const step = days <= 31 ? 1 : 7;
  const out: { start: Date; end: Date; label: string }[] = [];
  let cursor = startOfDayInTz(period.from, timeZone);
  while (cursor.getTime() < period.to.getTime()) {
    const next = addDays(cursor, step, timeZone);
    const end = next.getTime() < period.to.getTime() ? next : period.to;
    const p = zonedParts(cursor, timeZone);
    out.push({ start: cursor, end, label: step === 1 ? String(p.day) : `${p.day}/${p.month}` });
    cursor = next;
  }
  return out;
}

export { endOfDayInTz };
