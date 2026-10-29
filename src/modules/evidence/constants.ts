import type { EvidenceKind, EvidenceStatus } from "@prisma/client";

/**
 * The clinic's evidence library: what a source can be and where it stands.
 * No server imports: client components use it.
 */

export const EVIDENCE_KINDS = ["GUIDELINE", "DRUG_INFO", "PROTOCOL"] as const satisfies readonly EvidenceKind[];

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  GUIDELINE: "Guideline",
  DRUG_INFO: "Drug information",
  PROTOCOL: "Clinic protocol",
};

export const EVIDENCE_STATUSES = ["DRAFT", "APPROVED", "RETIRED"] as const satisfies readonly EvidenceStatus[];

export const EVIDENCE_STATUS_LABEL: Record<EvidenceStatus, string> = {
  DRAFT: "Waiting for approval",
  APPROVED: "Approved",
  RETIRED: "Retired",
};

/** The panel cites at most this many passages in one answer. */
export const MAX_CITED_PASSAGES = 4;

/** What the panel says, word for word, when the library does not answer the question. */
export const NO_GOOD_SOURCE = "No good source in the clinic's library answers this question.";
export const NO_GOOD_SOURCE_AR = "مفيش مصدر مناسب في مكتبة العيادة يجاوب على السؤال ده.";
