import type { EvidenceKind, EvidenceStatus } from "@prisma/client";

/** Wire shapes of the evidence library and panel (dates as ISO strings). */

export interface EvidenceSourceDTO {
  id: string;
  title: string;
  kind: EvidenceKind;
  kindLabel: string;
  publisher: string | null;
  year: number | null;
  url: string | null;
  language: string;
  status: EvidenceStatus;
  statusLabel: string;
  approvedBy: string | null;
  approvedAt: string | null;
  retiredAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  passages: number;
}

export interface EvidenceSourceDetailDTO extends EvidenceSourceDTO {
  body: string;
  passageList: { index: number; heading: string | null; content: string }[];
}

export interface EvidenceCitationDTO {
  /** The number the statements use ([1], [2]…). */
  n: number;
  sourceId: string;
  passageId: string;
  title: string;
  kindLabel: string;
  publisher: string | null;
  year: number | null;
  url: string | null;
  heading: string | null;
  /** The cited passage, word for word. */
  passage: string;
}

export interface EvidenceAnswerDTO {
  /** The question as it went to the search and the model: the patient's name and numbers taken out. */
  sentQuestion: string;
  grounded: boolean;
  /** Said plainly when nothing in the library answers ("No good source…"). */
  noGoodSource: string | null;
  statements: { text: string; cites: number[] }[];
  citations: EvidenceCitationDTO[];
  /** What went with the question about the patient (no name, phone or ID). */
  context: string[];
  /** "library": the passages' own sentences; "model": written by the clinic's AI model from them. */
  mode: "library" | "model";
  provider: string;
  model: string;
  /** The log entry of this answer. */
  runId: string | null;
}
