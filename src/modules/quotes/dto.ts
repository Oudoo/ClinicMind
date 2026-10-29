import type { PriceUnitValue } from "@/modules/finance/constants";
import type { QuoteLanguage, QuoteState, QuoteStatusValue } from "./constants";

/** Shapes of quotes as they leave the server (dates as ISO strings). No server imports. */

export interface QuoteItemDTO {
  id: string;
  phase: number;
  position: number;
  priceItemId: string;
  code: string;
  treatmentId: string;
  treatmentName: string;
  description: string;
  site: string | null;
  unit: PriceUnitValue;
  unitLabel: string | null;
  quantity: number;
  stages: number;
  unitPrice: number;
  price: number;
  discount: number;
  discountReason: string | null;
  discountNote: string | null;
  /** price − discount. */
  net: number;
  /** Set once the quote is accepted. */
  accepted: boolean | null;
  procedure: { id: string; status: string } | null;
}

export interface QuoteDTO {
  id: string;
  number: string | null;
  status: QuoteStatusValue;
  /** The status as shown: EXPIRED for a SENT quote past its last valid day. */
  state: QuoteState;
  language: QuoteLanguage;
  title: string | null;
  phases: string[];
  note: string | null;
  /** The last valid day: its start on the clinic clock, and as YYYY-MM-DD. */
  validUntil: string;
  validUntilKey: string;
  listTotal: number;
  discountTotal: number;
  total: number;
  createdAt: string;
  sentAt: string | null;
  linkSentAt: string | null;
  acceptedAt: string | null;
  acceptedName: string | null;
  signature: string | null;
  acceptedVia: "clinic" | "link" | null;
  acceptedTotal: number | null;
  declinedAt: string | null;
  declineReason: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  revisionOf: { id: string; number: string | null } | null;
  /** Quotes made from this one (drafts included). */
  revisions: { id: string; number: string | null; status: QuoteStatusValue }[];
  tenantName: string;
  timezone: string;
  clinic: { id: string; name: string; code: string | null; address: string | null; phone: string | null };
  patient: { id: string; fullName: string; phone: string | null; language: string };
  doctor: { id: string; fullName: string } | null;
  items: QuoteItemDTO[];
}

/** What the patient's page shows: the quote without the clinic's internal fields. */
export type PublicQuoteItemDTO = Omit<QuoteItemDTO, "procedure" | "discountReason" | "discountNote">;
export type PublicQuoteDTO = Omit<QuoteDTO, "revisionOf" | "revisions" | "declineReason" | "withdrawnReason" | "items"> & { items: PublicQuoteItemDTO[] };

export interface QuoteListRow {
  id: string;
  number: string | null;
  status: QuoteStatusValue;
  state: QuoteState;
  title: string | null;
  total: number;
  acceptedTotal: number | null;
  patientId: string;
  patientName: string;
  doctorName: string | null;
  validUntilKey: string;
  createdAt: string;
  sentAt: string | null;
}

/** Quotes given in a period and what became of them, by count and by value. */
export interface AcceptanceRow {
  presented: number;
  presentedValue: number;
  accepted: number;
  /** What the accepted items came to (a quote accepted in part counts in part). */
  acceptedValue: number;
  declined: number;
  expired: number;
  open: number;
}

export interface CaseAcceptance extends AcceptanceRow {
  days: number;
  from: string;
  /** Open quotes whose last valid day is within the next week. */
  expiringSoon: { count: number; value: number };
  byDoctor: (AcceptanceRow & { doctorId: string | null; name: string })[] | null;
  byTreatment: { treatmentId: string; name: string; presentedValue: number; acceptedValue: number; presented: number; accepted: number }[];
}
