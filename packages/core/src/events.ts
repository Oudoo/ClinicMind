import { db, domainEvents } from "@growengine/db";
import { enqueueDomainEvent } from "./queues.js";

/**
 * Domain Event Layer — producers publish, the events worker fans out to
 * registered handlers (forecast refresh, health score refresh, digests,
 * AOM indexing, notification rules, outbound webhooks). This prevents
 * tight coupling between modules.
 */
export const EVENT_TYPES = {
  tenantCreated: "tenant.created",
  clientCreated: "client.created",
  clientOnboarded: "client.onboarded",
  integrationConnected: "integration.connected",
  integrationSyncCompleted: "integration.sync_completed",
  integrationFailed: "integration.failed",
  integrationTokenExpiring: "integration.token_expiring",
  meetingRecorded: "meeting.recorded",
  meetingAnalyzed: "meeting.analyzed",
  transcriptReady: "transcript.ready",
  recommendationCreated: "recommendation.created",
  recommendationVerified: "recommendation.verified",
  recommendationApproved: "recommendation.approved",
  decisionRecorded: "decision.recorded",
  dmaicGenerated: "dmaic.generated",
  dmaicPhaseAdvanced: "dmaic.phase_advanced",
  forecastGenerated: "forecast.generated",
  healthScoreComputed: "health_score.computed",
  catRequested: "cat.requested",
  catDecided: "cat.decided",
  pilotCompleted: "pilot.completed",
  aeoAuditCompleted: "aeo_audit.completed",
  leadAuditSubmitted: "lead_audit.submitted",
  leadAuditCompleted: "lead_audit.completed",
  milestoneReached: "milestone.reached",
  ticketCreated: "ticket.created",
  ticketSlaBreached: "ticket.sla_breached",
  taskCompleted: "task.completed",
  sowGenerated: "sow.generated",
  invoiceIssued: "invoice.issued",
  usageLimitApproaching: "usage.limit_approaching",
  showcasePublished: "showcase.published",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface PublishEventInput {
  tenantId: string | null;
  eventType: EventType | string;
  payload?: Record<string, unknown>;
  entityType?: string;
  entityId?: string;
}

/**
 * Persist the event, then enqueue fan-out. Persistence first guarantees an
 * auditable record even if Redis is briefly unavailable.
 */
export async function publishEvent(input: PublishEventInput) {
  const [event] = await db
    .insert(domainEvents)
    .values({
      tenantId: input.tenantId,
      eventType: input.eventType,
      payload: input.payload ?? {},
      entityType: input.entityType,
      entityId: input.entityId,
    })
    .returning();

  await enqueueDomainEvent({
    domainEventId: event.id,
    tenantId: input.tenantId,
    eventType: input.eventType,
    payload: input.payload ?? {},
  });

  return event;
}
