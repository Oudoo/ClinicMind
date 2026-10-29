/**
 * The questions asked of the clinic's AI, as the log and the monthly review
 * count them. No server imports: client components use it.
 */

/** Runs that answer a clinician's question, and so are rated and reviewed. */
export const QUESTION_KINDS = ["evidence", "assistant_chat", "assistant_cohort"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_KIND_LABEL: Record<QuestionKind, string> = {
  evidence: "Evidence panel",
  assistant_chat: "AI assistant",
  assistant_cohort: "AI assistant (list)",
};

export const FEEDBACK_COMMENT_MAX = 1_000;

/** The monthly review goes to the clinician owners on the first of the month, from this hour on the clinic's clock. */
export const REVIEW_HOUR = 9;
