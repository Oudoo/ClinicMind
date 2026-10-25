/**
 * Post-treatment concierge (Module 5). The finance module calls
 * `enrolOnSignedProcedure` the moment a doctor signs a procedure; the concierge
 * module owns everything after that (protocols, tasks, check-ins, triage,
 * escalations). This file is the contract between the two.
 */
export interface EnrolActor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

export interface EnrolmentSummary {
  enrolmentId: string;
  protocolId: string;
  tasks: number;
}

/**
 * Enrol the patient of a signed procedure in the active protocol of its
 * treatment. Returns null when the treatment has no active protocol (nothing
 * to do) and never throws for a missing protocol; a thrown error means the
 * sign-off should still succeed, so callers catch and log.
 */
export async function enrolOnSignedProcedure(
  _tenantId: string,
  _procedureId: string,
  _actor: EnrolActor = {},
): Promise<EnrolmentSummary | null> {
  return null;
}
