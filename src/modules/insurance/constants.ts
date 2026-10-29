/**
 * The fixed lists of insurance and companies, and their words. Client-safe:
 * no server imports.
 */

export const PAYER_KINDS = ["INSURER", "COMPANY"] as const;
export type PayerKindValue = (typeof PAYER_KINDS)[number];

export const PAYER_KIND_LABELS: Record<PayerKindValue, string> = {
  INSURER: "Insurance company",
  COMPANY: "Company paying for its staff",
};

/** Whose card it is: the holder's own, or a family member on the holder's cover. */
export const COVER_RELATIONS = ["SELF", "SPOUSE", "CHILD", "PARENT", "OTHER"] as const;
export type CoverRelationValue = (typeof COVER_RELATIONS)[number];

export const COVER_RELATION_LABELS: Record<CoverRelationValue, string> = {
  SELF: "The holder",
  SPOUSE: "The holder's spouse",
  CHILD: "The holder's child",
  PARENT: "The holder's parent",
  OTHER: "Another family member",
};

export const APPROVAL_STATUSES = ["REQUESTED", "APPROVED", "REFUSED", "CANCELLED"] as const;
export type ApprovalStatusValue = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatusValue, string> = {
  REQUESTED: "Waiting for the payer",
  APPROVED: "Approved",
  REFUSED: "Refused",
  CANCELLED: "Cancelled",
};

export const CLAIM_STATUSES = ["OPEN", "SENT", "SETTLED", "CANCELLED"] as const;
export type ClaimStatusValue = (typeof CLAIM_STATUSES)[number];

export const CLAIM_STATUS_LABELS: Record<ClaimStatusValue, string> = {
  OPEN: "To send",
  SENT: "Sent",
  SETTLED: "Answered",
  CANCELLED: "Cancelled",
};

/** Why a payer refused (part of) a claim. */
export const REFUSAL_REASONS = ["NOT_COVERED", "NO_APPROVAL", "OVER_LIMIT", "PRICE", "NOT_MEMBER", "PAPERS", "DUPLICATE", "OTHER"] as const;
export type RefusalReasonValue = (typeof REFUSAL_REASONS)[number];

export const REFUSAL_REASON_LABELS: Record<RefusalReasonValue, string> = {
  NOT_COVERED: "Not covered by the contract",
  NO_APPROVAL: "No approval",
  OVER_LIMIT: "Over the member's limit",
  PRICE: "Above the contract's price",
  NOT_MEMBER: "Not covered on that day",
  PAPERS: "Papers missing",
  DUPLICATE: "Claimed twice",
  OTHER: "Another reason",
};

/** The price list's categories, as a contract's rules name them. */
export const COVER_CATEGORIES = ["general", "skin", "laser", "injectables", "hair"] as const;
export type CoverCategoryValue = (typeof COVER_CATEGORIES)[number];

/** What a payer owes, by how long ago the work was claimed (days). */
export const AGE_BUCKETS = [
  { key: "d30", label: "Up to 30 days", upTo: 30 },
  { key: "d60", label: "31–60 days", upTo: 60 },
  { key: "d90", label: "61–90 days", upTo: 90 },
  { key: "over", label: "Over 90 days", upTo: Infinity },
] as const;
export type AgeBucketKey = (typeof AGE_BUCKETS)[number]["key"];

export const ageBucketOf = (days: number): AgeBucketKey => AGE_BUCKETS.find((b) => days <= b.upTo)!.key;

export const INSURANCE_VIEWS = ["owed", "open", "sent", "approvals", "payers"] as const;
export type InsuranceView = (typeof INSURANCE_VIEWS)[number];

export const MAX_PERCENT = 100;
export const MAX_CONTRACT_DISCOUNT = 90;
