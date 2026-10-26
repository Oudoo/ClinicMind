/**
 * Finance vocabulary shared by the services, the API and the client
 * components. Deliberately free of server imports.
 */
export const PAYMENT_KINDS = ["DEPOSIT", "PAYMENT", "REFUND", "CONSULTATION_FEE"] as const;
export type PaymentKindValue = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "WALLET", "POS", "OTHER"] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export const PROCEDURE_STATUSES = ["PLANNED", "SIGNED", "CANCELLED"] as const;
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
  OTHER: "Other",
};

export const PROCEDURE_STATUS_LABELS: Record<ProcedureStatusValue, string> = {
  PLANNED: "Planned",
  SIGNED: "Signed",
  CANCELLED: "Cancelled",
};

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
