/**
 * A payer's contract applied to invoiced work, without the database: what it
 * covers (an item's rule, else its category's, else the contract's own), the
 * contract's discount, the patient's share and the payer's, the approval the
 * work needs, and the caps: the amount an approval has left, and what is left
 * of the member's yearly limit. What the payer does not pay, the patient does.
 * The claims service gathers the facts and keeps the result; an invoice draft
 * shows the same result before it is issued. Client-safe.
 */

export interface ContractRule {
  category: string | null;
  priceItemId: string | null;
  covered: boolean;
  copayPct: number | null;
  needsApproval: boolean;
}

export interface ContractTerms {
  id: string;
  /** Days on the clinic clock, YYYY-MM-DD; `validTo` included. */
  validFrom: string;
  validTo: string | null;
  discountPct: number;
  copayPct: number;
  annualLimit: number | null;
  approvalAbove: number | null;
  coveredByDefault: boolean;
  rules: ContractRule[];
}

export interface Ruling {
  covered: boolean;
  copayPct: number;
  needsApproval: boolean;
}

/** What the contract says of a piece of work: its item's rule, else its category's, else the contract's own terms. */
export function ruleFor(terms: Pick<ContractTerms, "rules" | "coveredByDefault" | "copayPct">, work: { priceItemId: string | null; category: string | null }): Ruling {
  const rule = (work.priceItemId ? terms.rules.find((r) => r.priceItemId === work.priceItemId) : undefined) ?? (work.category ? terms.rules.find((r) => r.category === work.category) : undefined);
  if (!rule) return { covered: terms.coveredByDefault, copayPct: terms.copayPct, needsApproval: false };
  return { covered: rule.covered, copayPct: rule.copayPct ?? terms.copayPct, needsApproval: rule.needsApproval };
}

/** The span a day falls in, or null: from its first day to its last, both included (no last day: open-ended). */
export const within = (span: { validFrom: string; validTo: string | null }, day: string) => span.validFrom <= day && (span.validTo === null || day <= span.validTo);

/** The contract in force on a day: the latest one started by then and not ended. */
export function contractOn<T extends { validFrom: string; validTo: string | null }>(contracts: readonly T[], day: string): T | null {
  return [...contracts].filter((c) => within(c, day)).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0] ?? null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** The day of a year that matches a month and day (29 February is the 28th in other years). */
const dayOfYear = (y: number, md: string) => (md === "02-29" && !isLeap(y) ? `${y}-02-28` : `${y}-${md}`);
const dayBefore = (key: string) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** The contract year a day falls in: from the anniversary of the contract's first day on or before it, for a year (both days included). */
export function contractYear(validFrom: string, day: string): { from: string; to: string } {
  const md = validFrom.slice(5);
  let year = Number(day.slice(0, 4));
  if (dayOfYear(year, md) > day) year -= 1;
  return { from: dayOfYear(year, md), to: dayBefore(dayOfYear(year + 1, md)) };
}

/** The contract's discount on work of this amount (its other discounts already off). */
export const contractDiscountOf = (amount: number, pct: number): number => Math.round((amount * pct) / 100);

/** The patient's share of covered work at the contract's price. */
export const patientShareOf = (amount: number, copayPct: number): number => Math.round((amount * copayPct) / 100);

export interface WorkLine {
  chargeId: string;
  /** The day the work was done (the clinic clock). */
  day: string;
  /** After every discount on it, the contract's among them. */
  amount: number;
  priceItemId: string | null;
  category: string | null;
  procedureId: string | null;
}

export interface ApprovalLeft {
  id: string;
  /** The planned work it was asked for: it pays for that work only. */
  procedureId: string | null;
  /** What it approved, less what claims took of it already. */
  left: number;
  validUntil: string | null;
}

/** Why the payer pays less than the contract's share of a line, or nothing. */
export type ShareNote = "not_covered" | "needs_approval" | "approval_cap" | "limit";

export interface LineShare {
  chargeId: string;
  covered: boolean;
  copayPct: number;
  needsApproval: boolean;
  patientShare: number;
  payerShare: number;
  approvalId: string | null;
  note: ShareNote | null;
}

/**
 * The shares of one invoice's work under one contract, line by line in order. A line needs the payer's approval
 * when its rule says so or when it is above the contract's amount; it then takes an approval for its own work
 * (else one for no work in particular) that is still valid on its day, and the payer pays no more than the
 * approval has left. The member's yearly limit caps the rest; approvals and the limit are used up as lines take
 * them. `limitUsed` gives what earlier claims took of the year starting on the day given.
 */
export function shareLines(terms: ContractTerms, lines: readonly WorkLine[], ctx: { approvals: readonly ApprovalLeft[]; limitUsed: (yearFrom: string) => number }): LineShare[] {
  const approvals = ctx.approvals.map((a) => ({ ...a }));
  const taken = new Map<string, number>();
  return lines.map((line) => {
    const ruling = ruleFor(terms, line);
    const base = { chargeId: line.chargeId, covered: ruling.covered, copayPct: ruling.copayPct, approvalId: null as string | null };
    if (!ruling.covered || line.amount <= 0) {
      return { ...base, needsApproval: false, patientShare: Math.max(0, line.amount), payerShare: 0, note: ruling.covered ? null : ("not_covered" as const) };
    }
    const needsApproval = ruling.needsApproval || (terms.approvalAbove !== null && line.amount > terms.approvalAbove);
    let payerShare = line.amount - patientShareOf(line.amount, ruling.copayPct);
    let note: ShareNote | null = null;
    if (needsApproval && payerShare > 0) {
      const usable = approvals
        .filter((a) => a.left > 0 && (a.validUntil === null || line.day <= a.validUntil) && (a.procedureId === null || a.procedureId === line.procedureId))
        .sort((a, b) => Number(b.procedureId === line.procedureId) - Number(a.procedureId === line.procedureId) || (a.validUntil ?? "9999").localeCompare(b.validUntil ?? "9999"));
      const approval = usable[0];
      if (!approval) {
        payerShare = 0;
        note = "needs_approval";
      } else {
        base.approvalId = approval.id;
        if (approval.left < payerShare) {
          payerShare = approval.left;
          note = "approval_cap";
        }
        approval.left -= payerShare;
      }
    }
    if (terms.annualLimit !== null && payerShare > 0) {
      const year = contractYear(terms.validFrom, line.day).from;
      const used = ctx.limitUsed(year) + (taken.get(year) ?? 0);
      const left = Math.max(0, terms.annualLimit - used);
      if (left < payerShare) {
        // What the limit leaves goes back to the approval it came from.
        const approval = base.approvalId ? approvals.find((a) => a.id === base.approvalId) : undefined;
        if (approval) approval.left += payerShare - left;
        payerShare = left;
        note = "limit";
      }
      taken.set(year, (taken.get(year) ?? 0) + payerShare);
    }
    if (payerShare <= 0) base.approvalId = null;
    return { ...base, needsApproval, patientShare: line.amount - payerShare, payerShare, note };
  });
}
