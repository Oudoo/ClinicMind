/**
 * Domain errors of the concierge module, mapped to HTTP by
 * `app/api/concierge/_lib/errors.ts`. Anything else falls through to the
 * shared `handleApiError`.
 */
export type ConciergeErrorCode =
  | "not_found"
  | "invalid_state"
  | "already_answered"
  | "no_active_protocol"
  | "no_steps"
  | "draft_only"
  | "draft_exists"
  | "active_only"
  | "token_invalid"
  | "photos_required"
  | "photo_too_large"
  | "photo_type"
  | "too_many_photos"
  | "payload_too_large"
  | "invalid_roster"
  | "validation_error";

export class ConciergeError extends Error {
  constructor(
    readonly code: ConciergeErrorCode,
    message: string,
    readonly status: number = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConciergeError";
  }
}

/** A row that is missing, or belongs to another tenant: both look the same (404). */
export class ConciergeNotFoundError extends ConciergeError {
  constructor(
    readonly entity: "enrolment" | "task" | "escalation" | "protocol" | "procedure" | "check_in" | "document",
    readonly id: string,
  ) {
    super("not_found", `${entity} ${id} not found in tenant`, 404);
    this.name = "ConciergeNotFoundError";
  }
}

/** Answers (or settings) that fail validation: 422 with per-field errors. */
export class CheckInValidationError extends ConciergeError {
  constructor(
    readonly fieldErrors: Record<string, string[]>,
    message = "Please check the highlighted answers",
  ) {
    super("validation_error", message, 422);
    this.name = "CheckInValidationError";
  }
}
