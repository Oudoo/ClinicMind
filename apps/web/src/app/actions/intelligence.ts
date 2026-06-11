"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  clients,
  recommendations,
  decisions,
  dmaicProjects,
  forecasts,
  aeoAudits,
  knowledgeDocuments,
} from "@growengine/db";
import {
  audit,
  publishEvent,
  EVENT_TYPES,
  enqueueResearchJob,
  semanticSearch,
  linkEntities,
} from "@growengine/core";
import { requirePermission, requireUser } from "@/lib/session";
import { createAiJob } from "@/lib/jobs";

async function ownedClient(tenantId: string, clientId: string) {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId)));
  return client ?? null;
}

const recSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(4).max(200),
  body: z.string().min(10).max(20000),
  category: z.enum(["marketing", "operations", "creative", "budget", "technical"]),
});

/** Create a recommendation and immediately queue evidence verification. */
export async function createRecommendation(formData: FormData) {
  const user = await requirePermission("intelligence:manage");
  const parsed = recSchema.safeParse({
    clientId: formData.get("clientId"),
    title: formData.get("title"),
    body: formData.get("body"),
    category: formData.get("category") ?? "marketing",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (!(await ownedClient(user.tenantId, parsed.data.clientId))) return { error: "Client not found" };

  const [rec] = await db
    .insert(recommendations)
    .values({
      tenantId: user.tenantId,
      clientId: parsed.data.clientId,
      title: parsed.data.title,
      body: parsed.data.body,
      category: parsed.data.category,
      proposedBy: user.id,
    })
    .returning();

  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.recommendationCreated,
    entityType: "recommendation",
    entityId: rec.id,
    payload: { clientId: rec.clientId, title: rec.title },
  });
  await createAiJob(user.tenantId, rec.clientId, "recommendation_verify", {
    recommendationId: rec.id,
  });

  revalidatePath(`/clients/${rec.clientId}`);
  return { ok: true, recommendationId: rec.id };
}

const decisionSchema = z.object({
  outcome: z.enum(["approved", "rejected", "deferred", "modified"]),
  reason: z.string().max(5000).optional(),
  approvedByName: z.string().max(120).optional(),
});

/** Record an explicit Decision on a recommendation (AOM first-class). */
export async function decideRecommendation(recommendationId: string, formData: FormData) {
  const user = await requireUser();
  const parsed = decisionSchema.safeParse({
    outcome: formData.get("outcome"),
    reason: formData.get("reason") || undefined,
    approvedByName: formData.get("approvedByName") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const [rec] = await db
    .select()
    .from(recommendations)
    .where(
      and(eq(recommendations.id, recommendationId), eq(recommendations.tenantId, user.tenantId))
    );
  if (!rec) return { error: "Recommendation not found" };
  // Client-portal users can only decide on their own client's recommendations
  if (user.clientId && user.clientId !== rec.clientId) return { error: "Forbidden" };

  const [decision] = await db
    .insert(decisions)
    .values({
      tenantId: user.tenantId,
      clientId: rec.clientId,
      title: `Decision on: ${rec.title}`,
      outcome: parsed.data.outcome,
      reason: parsed.data.reason,
      approvedByName: parsed.data.approvedByName ?? user.name ?? undefined,
      approvedByUserId: user.id,
      sourceEntityType: "recommendation",
      sourceEntityId: rec.id,
    })
    .returning();

  await db
    .update(recommendations)
    .set({
      status: parsed.data.outcome === "approved" ? "approved" : parsed.data.outcome === "rejected" ? "rejected" : rec.status,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(recommendations.id, rec.id));

  await linkEntities({
    tenantId: user.tenantId,
    fromEntityType: "decision",
    fromEntityId: decision.id,
    toEntityType: "recommendation",
    toEntityId: rec.id,
    linkType: "approved_by",
  });
  await createAiJob(user.tenantId, rec.clientId, "embedding", {
    entityType: "decision",
    entityId: decision.id,
    clientId: rec.clientId,
  });
  await publishEvent({
    tenantId: user.tenantId,
    eventType:
      parsed.data.outcome === "approved"
        ? EVENT_TYPES.recommendationApproved
        : EVENT_TYPES.decisionRecorded,
    entityType: "decision",
    entityId: decision.id,
    payload: { clientId: rec.clientId, outcome: parsed.data.outcome, title: rec.title },
  });
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "decision.record",
    entityType: "decision",
    entityId: decision.id,
    changes: { outcome: parsed.data.outcome },
  });

  revalidatePath(`/clients/${rec.clientId}`);
  return { ok: true };
}

const dmaicSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(4).max(200),
  problemStatement: z.string().min(20).max(10000),
});

export async function createDmaicProject(formData: FormData) {
  const user = await requirePermission("intelligence:manage");
  const parsed = dmaicSchema.safeParse({
    clientId: formData.get("clientId"),
    title: formData.get("title"),
    problemStatement: formData.get("problemStatement"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (!(await ownedClient(user.tenantId, parsed.data.clientId))) return { error: "Client not found" };

  const [project] = await db
    .insert(dmaicProjects)
    .values({
      tenantId: user.tenantId,
      clientId: parsed.data.clientId,
      title: parsed.data.title,
      problemStatement: parsed.data.problemStatement,
      ownerId: user.id,
    })
    .returning();

  await createAiJob(user.tenantId, project.clientId, "dmaic", { dmaicProjectId: project.id });
  revalidatePath(`/clients/${project.clientId}`);
  return { ok: true, dmaicProjectId: project.id };
}

export async function advanceDmaicPhase(dmaicProjectId: string) {
  const user = await requirePermission("intelligence:manage");
  const [project] = await db
    .select()
    .from(dmaicProjects)
    .where(and(eq(dmaicProjects.id, dmaicProjectId), eq(dmaicProjects.tenantId, user.tenantId)));
  if (!project) return { error: "Project not found" };

  const order = ["define", "measure", "analyze", "improve", "control", "completed"] as const;
  const idx = order.indexOf(project.currentPhase as (typeof order)[number]);
  if (idx < 0 || idx >= order.length - 1) return { error: "Project is already completed" };
  const next = order[idx + 1];

  await db
    .update(dmaicProjects)
    .set({
      currentPhase: next,
      completedAt: next === "completed" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(dmaicProjects.id, dmaicProjectId));
  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.dmaicPhaseAdvanced,
    entityType: "dmaic_project",
    entityId: dmaicProjectId,
    payload: { clientId: project.clientId, phase: next },
  });
  revalidatePath(`/clients/${project.clientId}`);
  return { ok: true };
}

export async function requestForecast(clientId: string, metric: string, horizonDays: number) {
  const user = await requirePermission("intelligence:manage");
  if (!(await ownedClient(user.tenantId, clientId))) return { error: "Client not found" };

  const [forecast] = await db
    .insert(forecasts)
    .values({
      tenantId: user.tenantId,
      clientId,
      metric,
      horizonDays: Math.min(Math.max(horizonDays, 7), 180),
      status: "queued",
    })
    .returning();
  await createAiJob(user.tenantId, clientId, "forecast", {
    clientId,
    metric,
    horizonDays: forecast.horizonDays,
    forecastId: forecast.id,
  });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, forecastId: forecast.id };
}

export async function requestSeasonalityAndLostOpportunity(clientId: string, metric: string) {
  const user = await requirePermission("intelligence:manage");
  if (!(await ownedClient(user.tenantId, clientId))) return { error: "Client not found" };
  await createAiJob(user.tenantId, clientId, "seasonality", { clientId, metric });
  await createAiJob(user.tenantId, clientId, "lost_opportunity", { clientId, metric });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export async function requestAeoAudit(clientId: string, targetUrl: string) {
  const user = await requirePermission("intelligence:manage");
  if (!(await ownedClient(user.tenantId, clientId))) return { error: "Client not found" };
  const parsedUrl = z.string().url().safeParse(targetUrl);
  if (!parsedUrl.success) return { error: "A valid URL is required" };

  const [auditRow] = await db
    .insert(aeoAudits)
    .values({ tenantId: user.tenantId, clientId, targetUrl: parsedUrl.data, status: "queued" })
    .returning();
  await createAiJob(user.tenantId, clientId, "aeo_audit", { aeoAuditId: auditRow.id });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, aeoAuditId: auditRow.id };
}

export async function requestCompetitorAnalysis(
  clientId: string,
  competitorName: string,
  competitorUrl: string
) {
  const user = await requirePermission("intelligence:manage");
  if (!(await ownedClient(user.tenantId, clientId))) return { error: "Client not found" };
  const parsedUrl = z.string().url().safeParse(competitorUrl);
  if (!parsedUrl.success) return { error: "A valid competitor URL is required" };

  await enqueueResearchJob({
    tenantId: user.tenantId,
    clientId,
    operation: "competitor_analysis",
    input: { competitorName, competitorUrl: parsedUrl.data },
  });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export async function requestQbr(clientId: string) {
  const user = await requirePermission("intelligence:manage");
  if (!(await ownedClient(user.tenantId, clientId))) return { error: "Client not found" };
  await createAiJob(user.tenantId, clientId, "qbr", { clientId });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export async function requestReport(clientId: string, title: string, focus?: string) {
  const user = await requirePermission("intelligence:manage");
  if (!(await ownedClient(user.tenantId, clientId))) return { error: "Client not found" };
  if (!title || title.length < 4) return { error: "Report title required" };
  await createAiJob(user.tenantId, clientId, "report", { clientId, title, focus });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

/** AOM semantic search (server action used by the AOM search page). */
export async function searchAom(query: string, clientId?: string) {
  const user = await requirePermission("aom:read");
  if (!query || query.length < 3) return { results: [] };
  try {
    const results = await semanticSearch(
      user.tenantId,
      query,
      { tenantId: user.tenantId, feature: "aom_search" },
      { clientId: clientId || undefined, limit: 15 }
    );
    return { results };
  } catch (err) {
    return { results: [], error: (err as Error).message };
  }
}

export async function createKnowledgeNote(formData: FormData) {
  const user = await requirePermission("aom:manage");
  const title = String(formData.get("title") ?? "").trim();
  const content = String(formData.get("content") ?? "").trim();
  const clientId = String(formData.get("clientId") ?? "") || null;
  if (title.length < 2 || content.length < 4) return { error: "Title and content are required" };

  if (clientId && !(await ownedClient(user.tenantId, clientId))) return { error: "Client not found" };

  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      tenantId: user.tenantId,
      clientId,
      type: "note",
      title,
      contentMarkdown: content,
      authorId: user.id,
    })
    .returning();
  await createAiJob(user.tenantId, clientId, "embedding", {
    entityType: "knowledge_document",
    entityId: doc.id,
    clientId,
  });
  revalidatePath("/aom");
  return { ok: true };
}
