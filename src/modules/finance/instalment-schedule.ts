/**
 * Instalment plans, the arithmetic: a plan's schedule from its terms (a down
 * payment, so many instalments every so many months from a first day, equal
 * whole pounds with the odd pounds on the last), and where each instalment
 * stands once the payments towards the plan are counted against them in
 * order. Day keys are YYYY-MM-DD on the clinic clock. No server imports:
 * the plan dialog previews the schedule with it.
 */

export const MAX_INSTALMENTS = 60;
export const INSTALMENT_INTERVALS = [1, 2, 3, 6] as const;
export const DEFAULT_REMINDER_DAYS = 3;

/** Paid in full; still owed and its day has passed; due within the reminder days; later. */
export type InstalmentState = "PAID" | "OVERDUE" | "DUE" | "UPCOMING";

export const INSTALMENT_STATE_LABELS: Record<InstalmentState, string> = {
  PAID: "Paid",
  OVERDUE: "Overdue",
  DUE: "Due soon",
  UPCOMING: "Upcoming",
};

/** `total` in `count` whole-pound parts: equal, the odd pounds on the last. */
export function splitAmount(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? total - base * (count - 1) : base));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A day key `months` later, on the same day of the month or the month's last day ("2026-01-31" + 1 → "2026-02-28"). */
export function addMonthsToKey(key: string, months: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(d, last))}`;
}

/** Whole days from one day key to another (positive when `to` is later). */
export function daysBetweenKeys(from: string, to: string): number {
  const ms = (k: string) => {
    const [y, m, d] = k.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

export interface ScheduledInstalment {
  /** 0: the down payment, due the day the plan is made; then 1, 2, … */
  number: number;
  dueKey: string;
  amount: number;
}

/** The schedule of a plan's terms. */
export function scheduleOf(terms: { total: number; downPayment: number; count: number; everyMonths: number; firstDue: string; startKey: string }): ScheduledInstalment[] {
  const rest = terms.total - terms.downPayment;
  return [
    ...(terms.downPayment > 0 ? [{ number: 0, dueKey: terms.startKey, amount: terms.downPayment }] : []),
    ...splitAmount(rest, terms.count).map((amount, i) => ({ number: i + 1, dueKey: addMonthsToKey(terms.firstDue, i * terms.everyMonths), amount })),
  ];
}

export interface CoveredInstalment extends ScheduledInstalment {
  /** What the payments cover of it. */
  covered: number;
  /** Still owed on it. */
  owed: number;
  state: InstalmentState;
  /** Days past its day while owed (0 otherwise). */
  daysLate: number;
}

/**
 * Where each instalment stands: the money paid towards the plan covers them
 * in order (the down payment first), an instalment owed after its day is
 * overdue, one owed within the reminder days (or today) is due soon.
 */
export function coverInstalments(instalments: readonly ScheduledInstalment[], paid: number, todayKey: string, reminderDays: number): CoveredInstalment[] {
  let left = Math.max(0, paid);
  return [...instalments]
    .sort((a, b) => a.number - b.number)
    .map((i) => {
      const covered = Math.min(left, i.amount);
      left -= covered;
      const owed = i.amount - covered;
      const ahead = daysBetweenKeys(todayKey, i.dueKey);
      const state: InstalmentState = owed === 0 ? "PAID" : ahead < 0 ? "OVERDUE" : ahead <= reminderDays ? "DUE" : "UPCOMING";
      return { ...i, covered, owed, state, daysLate: owed > 0 && ahead < 0 ? -ahead : 0 };
    });
}

export interface PlanPosition {
  paid: number;
  /** Still to pay on the plan. */
  left: number;
  /** Owed on instalments whose day has passed. */
  overdue: number;
  /** The days the oldest overdue instalment is late. */
  daysLate: number;
  /** The first instalment still owed. */
  next: CoveredInstalment | null;
  paidInstalments: number;
}

export function planPosition(total: number, covered: readonly CoveredInstalment[]): PlanPosition {
  const paid = covered.reduce((s, i) => s + i.covered, 0);
  const late = covered.filter((i) => i.state === "OVERDUE");
  return {
    paid,
    left: Math.max(0, total - paid),
    overdue: late.reduce((s, i) => s + i.owed, 0),
    daysLate: late.reduce((m, i) => Math.max(m, i.daysLate), 0),
    next: covered.find((i) => i.owed > 0) ?? null,
    paidInstalments: covered.filter((i) => i.state === "PAID" && i.number > 0).length,
  };
}
