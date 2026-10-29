/**
 * The vocabulary of lab work, shared by the service, the API and the client
 * components. Deliberately free of server imports.
 */
export const LAB_ORDER_STATUSES = ["SENT", "RECEIVED", "CANCELLED"] as const;
export type LabOrderStatusValue = (typeof LAB_ORDER_STATUSES)[number];

export const LAB_STATUS_LABELS: Record<LabOrderStatusValue, string> = { SENT: "At the lab", RECEIVED: "Result in", CANCELLED: "Cancelled" };

/** The lists on the Lab work page. */
export const LAB_VIEWS = ["late", "waiting", "back", "unbilled", "cancelled"] as const;
export type LabView = (typeof LAB_VIEWS)[number];

/** Days a lab takes when it says nothing of its own. */
export const DEFAULT_TURNAROUND_DAYS = 7;

/** At most this many files of a lab's report on one order, and this large each. */
export const MAX_LAB_FILES = 6;
export const MAX_LAB_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_LAB_PHOTO_SIDE = 2000;
