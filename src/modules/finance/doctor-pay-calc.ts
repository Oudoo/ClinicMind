/**
 * Doctor pay, the arithmetic: which rule covers a piece of work, what the
 * work has earned by a day under it, and a month's statement settled against
 * what was owed back. No server imports: the rules form and the statements
 * use it too.
 *
 * A piece of work is a procedure (its charges, the money put towards them,
 * its costs and the sessions done) or a consultation fee. What it has
 * earned by a day is worked out from everything up to that day; a statement
 * pays what the work had earned by the month's end less what earlier
 * statements paid for it, so a late payment, a cost that comes in later, a
 * cancellation or a refund each count in the month they happen.
 */
import { CATEGORY_LABELS, PRICE_CATEGORIES, type PriceCategoryValue } from "./constants";

export const PAY_BASES = ["BILLED", "COLLECTED", "FIXED"] as const;
export type PayBasisValue = (typeof PAY_BASES)[number];

export const PAY_BASIS_LABELS: Record<PayBasisValue, string> = {
  BILLED: "A share of what is billed",
  COLLECTED: "A share of what is collected",
  FIXED: "A fixed fee per session",
};

/** The rule for everything a doctor's other rules do not cover. */
export const OTHER_WORK = "*";
/** Consultation fees, beside the price list's categories. */
export const CONSULTATIONS = "consultation";
export const PAY_CATEGORIES = [OTHER_WORK, CONSULTATIONS, ...PRICE_CATEGORIES] as const;
export type PayCategoryValue = (typeof PAY_CATEGORIES)[number];

export function payCategoryLabel(category: string): string {
  if (category === OTHER_WORK) return "Everything else";
  if (category === CONSULTATIONS) return "Consultation fees";
  return CATEGORY_LABELS[category as PriceCategoryValue] ?? category;
}

export interface PayTerms {
  basis: PayBasisValue;
  /** A share in hundredths of a percent (3750 is 37.5%). */
  rate: number | null;
  /** A fixed fee, EGP a session. */
  amount: number | null;
  deductCosts: boolean;
}

/** The rule for a category: the doctor's own for it, else their rule for everything else, else none. */
export function ruleFor<R extends { category: string }>(rules: readonly R[], category: string | null): R | null {
  return (category ? rules.find((r) => r.category === category) : undefined) ?? rules.find((r) => r.category === OTHER_WORK) ?? null;
}

/** "37.5%" */
export const percentLabel = (rate: number) => `${(rate / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/** "40% of what is collected, after costs", "250 EGP a session". */
export function describeTerms(t: PayTerms): string {
  if (t.basis === "FIXED") return `${(t.amount ?? 0).toLocaleString("en-US")} EGP a session`;
  return `${percentLabel(t.rate ?? 0)} of what is ${t.basis === "BILLED" ? "billed" : "collected"}${t.deductCosts ? ", after costs" : ""}`;
}

/** A piece of work up to a day: billed for it, collected for it, its costs and the sessions done. */
export interface WorkToDate {
  billed: number;
  collected: number;
  costs: number;
  sessions: number;
}

/**
 * What the work has earned by then under its rule: a share of what was
 * billed or collected (the costs taken off first, when the rule says so),
 * or the fee for each session done; never below zero, and nothing without
 * a rule.
 */
export function earnedBy(terms: PayTerms | null, work: WorkToDate): number {
  if (!terms) return 0;
  if (terms.basis === "FIXED") return Math.max(0, (terms.amount ?? 0) * Math.max(0, work.sessions));
  const base = (terms.basis === "BILLED" ? work.billed : work.collected) - (terms.deductCosts ? work.costs : 0);
  return Math.max(0, Math.round((base * (terms.rate ?? 0)) / 10_000));
}

/**
 * A month settled: what it earned with what was owed back from before. The
 * clinic pays what is left above zero; what is below zero is owed back and
 * taken off the next statement.
 */
export function settle(earned: number, broughtForward: number): { payable: number; carriedForward: number } {
  const total = earned + Math.min(0, broughtForward);
  return { payable: Math.max(0, total), carriedForward: Math.min(0, total) };
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const isMonthKey = (key: string) => MONTH.test(key);

/** The month a day key falls in: "2026-10-29" → "2026-10". */
export const monthOfKey = (dayKey: string) => dayKey.slice(0, 7);

/** The month `n` months from `month` ("2026-12", 1 → "2027-01"). */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** "October 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}
