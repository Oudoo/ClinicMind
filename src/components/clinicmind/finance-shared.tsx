import { ApiError } from "@/lib/http";
import {
  KIND_LABELS,
  METHOD_LABELS,
  PROCEDURE_STATUS_LABELS,
  type PaymentKindValue,
  type PaymentMethodValue,
  type PriceCategoryValue,
  type PriceUnitValue,
  type ProcedureStatusValue,
} from "@/modules/finance/constants";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";

/**
 * Serializable shapes and helpers shared by the finance components (the
 * patient card, the finance dashboard's dialogs). No server imports.
 */

export interface TreatmentOption {
  id: string;
  key: string;
  name: string;
  priceFrom: number | null;
  priceTo: number | null;
  depositAmount: number | null;
}

/** One price-list item as the procedure dialog offers it (price as of the day asked for). */
export interface PriceOption {
  id: string;
  code: string;
  name: string;
  category: PriceCategoryValue;
  unit: PriceUnitValue;
  unitLabel: string | null;
  sessions: number | null;
  treatmentId: string;
  price: number | null;
}

export interface DoctorOption {
  id: string;
  fullName: string;
}

export interface ProcedureItem {
  id: string;
  patientId: string;
  treatmentName: string;
  treatmentKey: string;
  performedAt: string;
  doctorName: string | null;
  price: number;
  discount: number;
  status: ProcedureStatusValue;
  paid: number;
  /** Signed: what is still owed; started: charged so far less paid (negative when paid ahead); planned: deposits short of the price. */
  balance: number;
  /** Work done in stages: how many, how many done, and what has been charged so far. */
  stages: number;
  stagesDone: number;
  charged: number;
  startedAt: string | null;
  zeroChargeReason: string | null;
  notes: string | null;
  cancelReason: string | null;
}

export interface PaymentItem {
  id: string;
  patientId: string;
  patientName: string;
  kind: PaymentKindValue;
  method: PaymentMethodValue;
  amount: number;
  paidAt: string;
  reference: string | null;
  note: string | null;
  procedureLabel: string | null;
  imported: boolean;
}

/** A procedure the payment form can point at: "Hair transplant · 12 Oct 2026 · owes 9,000 EGP". */
export interface ProcedureChoice {
  id: string;
  label: string;
  balance: number;
}

export const STATUS_TONE: Record<ProcedureStatusValue, BadgeTone> = { PLANNED: "warning", STARTED: "accent", SIGNED: "success", CANCELLED: "danger" };
export const KIND_TONE: Record<PaymentKindValue, BadgeTone> = { DEPOSIT: "accent", PAYMENT: "success", REFUND: "danger", CONSULTATION_FEE: "default" };

export { KIND_LABELS, METHOD_LABELS, PROCEDURE_STATUS_LABELS };

/** Signed amount of a payment for display: refunds are money out. */
export const signedAmount = (p: { kind: string; amount: number }) => (p.kind === "REFUND" ? -p.amount : p.amount);

/** A message for a failed finance request. */
export function financeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.code === "invalid_state") {
      const body = err.body as { status?: string; action?: string };
      return `A ${String(body.status ?? "").toLowerCase() || "closed"} procedure cannot be ${body.action ?? "changed"}. Reload to see its latest status.`;
    }
    if (err.status === 404) return "That record no longer exists (or belongs to another clinic).";
    if (err.status === 403) return "Your role cannot do that.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

/** The price-list items as the dialog needs them (from `listPriceList`). */
export function toPriceOptions(items: readonly { id: string; code: string; name: string; category: PriceCategoryValue; unit: PriceUnitValue; unitLabel: string | null; sessions: number | null; treatment: { id: string }; price: number | null }[]): PriceOption[] {
  return items.map((i) => ({ id: i.id, code: i.code, name: i.name, category: i.category, unit: i.unit, unitLabel: i.unitLabel, sessions: i.sessions, treatmentId: i.treatment.id, price: i.price }));
}
