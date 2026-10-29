/**
 * Finance vocabulary shared by the services, the API and the client
 * components. Deliberately free of server imports.
 */
export const PAYMENT_KINDS = ["DEPOSIT", "PAYMENT", "REFUND", "CONSULTATION_FEE"] as const;
export type PaymentKindValue = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "WALLET", "POS", "INSTAPAY", "CHEQUE", "OTHER"] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export const PROCEDURE_STATUSES = ["PLANNED", "STARTED", "SIGNED", "CANCELLED"] as const;
export type ProcedureStatusValue = (typeof PROCEDURE_STATUSES)[number];

export const KIND_LABELS: Record<PaymentKindValue, string> = {
  DEPOSIT: "Deposit",
  PAYMENT: "Payment",
  REFUND: "Refund",
  CONSULTATION_FEE: "Consultation fee",
};

export const METHOD_LABELS: Record<PaymentMethodValue, string> = {
  CASH: "Cash",
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  WALLET: "Wallet",
  POS: "POS",
  INSTAPAY: "InstaPay",
  CHEQUE: "Cheque",
  OTHER: "Other",
};

export const PROCEDURE_STATUS_LABELS: Record<ProcedureStatusValue, string> = {
  PLANNED: "Planned",
  STARTED: "Started",
  SIGNED: "Signed",
  CANCELLED: "Cancelled",
};

/** Why a discount is given: a fixed list, so every discount can be counted and explained. */
export const DISCOUNT_REASONS = ["LOYALTY", "FAMILY", "STAFF", "PROMOTION", "PACKAGE", "GOODWILL", "DOCTOR", "OTHER"] as const;
export type DiscountReasonValue = (typeof DISCOUNT_REASONS)[number];

export const DISCOUNT_REASON_LABELS: Record<DiscountReasonValue, string> = {
  LOYALTY: "Returning patient",
  FAMILY: "Family of a patient",
  STAFF: "Staff or their family",
  PROMOTION: "Campaign offer",
  PACKAGE: "Package price",
  GOODWILL: "Goodwill (a complaint or a long wait)",
  DOCTOR: "The doctor's decision",
  OTHER: "Another reason",
};

/** The discount an insurer's or a company's contract takes off covered work: put on the invoice for it, chosen by no one. */
export const CONTRACT_DISCOUNT = "CONTRACT";

/** Every discount's reason as the reports name it: the fixed list's, and the contract's. */
export const discountReasonLabel = (key: string): string =>
  key === CONTRACT_DISCOUNT ? "Insurance or company contract" : (DISCOUNT_REASON_LABELS[key as DiscountReasonValue] ?? key);

/** Why what is left on an invoice is written off (the owner's decision). */
export const WRITE_OFF_REASONS = ["BAD_DEBT", "SMALL_BALANCE", "DISPUTE", "GOODWILL", "DECEASED", "PAYER_REFUSED", "OTHER"] as const;
export type WriteOffReasonValue = (typeof WRITE_OFF_REASONS)[number];

export const WRITE_OFF_REASON_LABELS: Record<WriteOffReasonValue, string> = {
  BAD_DEBT: "Bad debt: it cannot be collected",
  SMALL_BALANCE: "Too small to chase",
  DISPUTE: "A dispute settled",
  GOODWILL: "Goodwill",
  DECEASED: "The patient has died",
  PAYER_REFUSED: "Refused by the insurer or the company",
  OTHER: "Another reason",
};

/** The roles whose discounts are limited (a percentage of the price); the owner's are not. */
export const DISCOUNT_LIMITED_ROLES = ["RECEPTIONIST", "NURSE", "DOCTOR"] as const;
export type DiscountLimitedRole = (typeof DISCOUNT_LIMITED_ROLES)[number];
export type DiscountLimits = Record<DiscountLimitedRole, number>;
export const DEFAULT_DISCOUNT_LIMITS: DiscountLimits = { RECEPTIONIST: 10, NURSE: 10, DOCTOR: 20 };

/** The largest discount a role may give, as a percentage of the price: the owner's has no limit, a role not listed gives none. */
export function discountLimitFor(role: string, limits: DiscountLimits): number {
  if (role === "CLINIC_OWNER" || role === "SUPER_ADMIN") return 100;
  return (DISCOUNT_LIMITED_ROLES as readonly string[]).includes(role) ? limits[role as DiscountLimitedRole] : 0;
}

/** Whether a discount on a price is within a limit (a percentage), in whole numbers. */
export const withinDiscountLimit = (price: number, discount: number, limit: number) => discount <= 0 || discount * 100 <= price * limit;

/** How a price-list item is counted (Phase 2 price list). */
export const PRICE_UNITS = ["VISIT", "SESSION", "AREA", "UNIT", "TOOTH", "ARCH", "PACKAGE"] as const;
export type PriceUnitValue = (typeof PRICE_UNITS)[number];

export const UNIT_LABELS: Record<PriceUnitValue, string> = {
  VISIT: "Per visit",
  SESSION: "Per session",
  AREA: "Per area",
  UNIT: "Per unit",
  TOOTH: "Per tooth",
  ARCH: "Per arch",
  PACKAGE: "Course package",
};

/** The treatment categories, which group the price list too. */
export const PRICE_CATEGORIES = ["hair", "skin", "laser", "injectables", "general"] as const;
export type PriceCategoryValue = (typeof PRICE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<PriceCategoryValue, string> = {
  hair: "Hair",
  skin: "Skin",
  laser: "Laser",
  injectables: "Injectables",
  general: "General dermatology",
};

/** "per session", "per graft", "6-session course" … for one item. */
export function unitPhrase(unit: PriceUnitValue, unitLabel: string | null, sessions: number | null): string {
  if (unit === "UNIT" && unitLabel) return `per ${unitLabel}`;
  if (unit === "PACKAGE") return sessions ? `${sessions}-session course` : "course package";
  return UNIT_LABELS[unit].toLowerCase();
}

/** Whole EGP; nothing in a clinic costs more than this. */
export const MAX_AMOUNT = 10_000_000;

/** Payments at or above this amount notify the clinic owner. */
export const LARGE_PAYMENT_THRESHOLD = 10_000;

/** Money in minus money out for a list of (non-voided) payments. Kinds that are not money in or out are ignored. */
export function netPaid(payments: readonly { kind: string; amount: number }[]): number {
  let total = 0;
  for (const p of payments) {
    if (p.kind === "PAYMENT" || p.kind === "DEPOSIT" || p.kind === "CONSULTATION_FEE") total += p.amount;
    else if (p.kind === "REFUND") total -= p.amount;
  }
  return total;
}

/** What the patient still owes on a procedure: price − discount − payments − deposits + refunds. */
export function procedureBalance(price: number, discount: number, payments: readonly { kind: string; amount: number }[]): number {
  return price - discount - netPaid(payments);
}

export function formatEgp(amount: number): string {
  return `${new Intl.NumberFormat("en-US").format(Math.round(amount))} EGP`;
}
