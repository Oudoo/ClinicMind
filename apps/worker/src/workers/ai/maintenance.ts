import { and, eq, lt, sql as dsql } from "drizzle-orm";
import {
  db,
  dataRetentionPolicies,
  metricRecords,
  transcripts,
  auditLogs,
  notifications,
  meetings,
  knowledgeDocuments,
  recommendations,
  decisions,
  tickets,
} from "@growengine/db";
import { indexEntity, deleteObject, type AiJobData } from "@growengine/core";

/** Generic AOM (re)indexing job for any entity. */
export async function handleEmbedding(data: AiJobData) {
  const { entityType, entityId, clientId } = data.input as {
    entityType: string;
    entityId: string;
    clientId?: string;
  };

  let text = "";
  switch (entityType) {
    case "knowledge_document": {
      const [doc] = await db
        .select()
        .from(knowledgeDocuments)
        .where(and(eq(knowledgeDocuments.id, entityId), eq(knowledgeDocuments.tenantId, data.tenantId)));
      text = doc ? `${doc.title}\n${doc.contentMarkdown}` : "";
      break;
    }
    case "recommendation": {
      const [rec] = await db
        .select()
        .from(recommendations)
        .where(and(eq(recommendations.id, entityId), eq(recommendations.tenantId, data.tenantId)));
      text = rec ? `${rec.title}\n${rec.body}` : "";
      break;
    }
    case "decision": {
      const [d] = await db
        .select()
        .from(decisions)
        .where(and(eq(decisions.id, entityId), eq(decisions.tenantId, data.tenantId)));
      text = d ? `Decision: ${d.title}\nOutcome: ${d.outcome}\nReason: ${d.reason ?? ""}` : "";
      break;
    }
    case "ticket": {
      const [t] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.id, entityId), eq(tickets.tenantId, data.tenantId)));
      text = t ? `${t.subject}\n${t.description ?? ""}` : "";
      break;
    }
    case "meeting": {
      const [m] = await db
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, entityId), eq(meetings.tenantId, data.tenantId)));
      const [tr] = m
        ? await db.select().from(transcripts).where(eq(transcripts.meetingId, m.id))
        : [];
      text = m ? `${m.title}\n${m.agenda ?? ""}\n${tr?.fullText ?? ""}` : "";
      break;
    }
  }
  if (!text.trim()) return;

  await indexEntity(
    { tenantId: data.tenantId, clientId: clientId ?? null, entityType, entityId, text },
    { tenantId: data.tenantId, clientId, feature: "aom_indexing", aiJobId: data.aiJobId }
  );
}

/**
 * Data governance — enforce tenant retention policies for analytics,
 * transcripts, recordings, audit logs and notifications.
 */
export async function handleRetentionEnforcement(data: AiJobData) {
  const policies = await db
    .select()
    .from(dataRetentionPolicies)
    .where(
      and(
        eq(dataRetentionPolicies.tenantId, data.tenantId),
        eq(dataRetentionPolicies.enabled, true)
      )
    );

  for (const policy of policies) {
    const cutoff = new Date(Date.now() - policy.retentionDays * 86400_000);
    switch (policy.dataCategory) {
      case "analytics":
        await db
          .delete(metricRecords)
          .where(
            and(
              eq(metricRecords.tenantId, data.tenantId),
              dsql`${metricRecords.date} < ${cutoff.toISOString().slice(0, 10)}`
            )
          );
        break;
      case "transcripts":
        await db
          .delete(transcripts)
          .where(and(eq(transcripts.tenantId, data.tenantId), lt(transcripts.createdAt, cutoff)));
        break;
      case "recordings": {
        const expired = await db
          .select()
          .from(meetings)
          .where(
            and(
              eq(meetings.tenantId, data.tenantId),
              lt(meetings.createdAt, cutoff),
              dsql`${meetings.recordingStorageKey} IS NOT NULL`
            )
          );
        for (const m of expired) {
          if (m.recordingStorageKey) {
            await deleteObject(m.recordingStorageKey).catch(() => {});
            await db
              .update(meetings)
              .set({ recordingStorageKey: null })
              .where(eq(meetings.id, m.id));
          }
        }
        break;
      }
      case "audit_logs":
        await db
          .delete(auditLogs)
          .where(and(eq(auditLogs.tenantId, data.tenantId), lt(auditLogs.createdAt, cutoff)));
        break;
      case "notifications":
        await db
          .delete(notifications)
          .where(and(eq(notifications.tenantId, data.tenantId), lt(notifications.createdAt, cutoff)));
        break;
    }
    await db
      .update(dataRetentionPolicies)
      .set({ lastEnforcedAt: new Date() })
      .where(eq(dataRetentionPolicies.id, policy.id));
  }
}
