/**
 * Domain errors of the finance module, mapped to HTTP by the route layer
 * (see app/api/procedures/_lib/errors.ts). A foreign tenant's id looks exactly
 * like a missing one: both are `not_found`.
 */
export class FinanceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FinanceError";
  }
}

export class ProcedureNotFoundError extends FinanceError {
  constructor(id: string) {
    super(404, "not_found", `procedure ${id} not found in tenant`, { entity: "procedure" });
    this.name = "ProcedureNotFoundError";
  }
}

export class PaymentNotFoundError extends FinanceError {
  constructor(id: string) {
    super(404, "not_found", `payment ${id} not found in tenant`, { entity: "payment" });
    this.name = "PaymentNotFoundError";
  }
}

/** The procedure is not in a status that allows the requested change. */
export class ProcedureStateError extends FinanceError {
  constructor(readonly procedureStatus: string, action: string) {
    super(409, "invalid_state", `a ${procedureStatus} procedure cannot be ${action}`, { status: procedureStatus, action });
    this.name = "ProcedureStateError";
  }
}
