import { and, eq, desc, sql as dsql } from "drizzle-orm";
import {
  db,
  meetings,
  transcripts,
  sowDocuments,
  recommendations,
  dmaicProjects,
  tasks,
  metricRecords,
  knowledgeDocuments,
} from "@growengine/db";
import {
  aiComplete,
  aiCompleteJson,
  transcribeAudio,
  downloadObject,
  computeConfidence,
  publishEvent,
  EVENT_TYPES,
  indexEntity,
  linkEntities,
  type AiJobData,
} from "@growengine/core";

/**
 * LLM-driven analysis jobs: meeting intelligence, SOW generation,
 * recommendation verification, and DMAIC formulation.
 */

export async function handleMeetingAnalysis(data: AiJobData) {
  const { meetingId } = data.input as { meetingId: string };
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.tenantId, data.tenantId)));
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`);

  const ctx = {
    tenantId: data.tenantId,
    clientId: meeting.clientId,
    feature: "meeting_analysis",
    aiJobId: data.aiJobId,
  };

  // 1. Transcribe if a recording exists and no transcript yet
  let [transcript] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.meetingId, meetingId));

  if (!transcript && meeting.recordingStorageKey) {
    await db.update(meetings).set({ status: "transcribing" }).where(eq(meetings.id, meetingId));
    const audio = await downloadObject(meeting.recordingStorageKey);
    const result = await transcribeAudio(
      audio,
      meeting.recordingStorageKey.split("/").pop() ?? "recording.mp3",
      ctx
    );
    [transcript] = await db
      .insert(transcripts)
      .values({
        tenantId: data.tenantId,
        meetingId,
        engine: result.engine,
        language: result.language,
        fullText: result.fullText,
        segments: result.segments,
        wordCount: result.fullText.split(/\s+/).length,
        processingTimeMs: result.processingTimeMs,
      })
      .returning();
    await publishEvent({
      tenantId: data.tenantId,
      eventType: EVENT_TYPES.transcriptReady,
      entityType: "transcript",
      entityId: transcript.id,
      payload: { meetingId, clientId: meeting.clientId },
    });
  }
  if (!transcript) throw new Error("No transcript or recording available for analysis");

  // 2. Extract requirements, challenges, action items + expectation baseline
  await db.update(meetings).set({ status: "analyzing" }).where(eq(meetings.id, meetingId));

  const prereqs = JSON.stringify(meeting.prerequisiteResponses ?? {});
  const analysis = await aiCompleteJson<{
    requirements: { text: string; priority: string; evidenceQuote: string }[];
    challenges: { text: string; severity: string; evidenceQuote: string }[];
    actionItems: { text: string; owner: string; due: string | null }[];
    expectationBaselineMarkdown: string;
  }>(
    `You are a senior account strategist. Analyze this client meeting transcript and the pre-meeting form responses.

PRE-MEETING FORM RESPONSES:
${prereqs}

TRANSCRIPT:
${transcript.fullText.slice(0, 60000)}

Return strict JSON with keys:
- "requirements": array of {text, priority: "must"|"should"|"could", evidenceQuote: short verbatim quote from the transcript supporting it}
- "challenges": array of {text, severity: "low"|"medium"|"high", evidenceQuote}
- "actionItems": array of {text, owner, due: ISO date or null}
- "expectationBaselineMarkdown": a complete Expectation Baseline document in markdown with sections: Context, Agreed Goals, Success Metrics, Assumptions, Out of Scope, Open Questions. Only include items actually supported by the transcript.`,
    ctx,
    { maxTokens: 8000 }
  );

  const confidence = computeConfidence({
    evidenceCount:
      analysis.requirements.length + analysis.challenges.length + analysis.actionItems.length,
    dataWindowDays: 1,
    dataFreshnessHours: 1,
    variability: 0.2,
    sourceCount: 1,
  });

  await db
    .update(meetings)
    .set({
      status: "analyzed",
      extractedRequirements: analysis.requirements,
      extractedChallenges: analysis.challenges,
      actionItems: analysis.actionItems,
      expectationBaseline: analysis.expectationBaselineMarkdown,
      analysisConfidence: String(confidence.score),
      updatedAt: new Date(),
    })
    .where(eq(meetings.id, meetingId));

  // 3. File the baseline into the AOM as a knowledge document + index
  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      tenantId: data.tenantId,
      clientId: meeting.clientId,
      type: "expectation_baseline",
      title: `Expectation Baseline — ${meeting.title}`,
      contentMarkdown: analysis.expectationBaselineMarkdown,
      sourceEntityType: "meeting",
      sourceEntityId: meetingId,
    })
    .returning();
  await linkEntities({
    tenantId: data.tenantId,
    fromEntityType: "knowledge_document",
    fromEntityId: doc.id,
    toEntityType: "meeting",
    toEntityId: meetingId,
    linkType: "generated_from",
  });
  try {
    await indexEntity(
      {
        tenantId: data.tenantId,
        clientId: meeting.clientId,
        entityType: "meeting",
        entityId: meetingId,
        text: `${meeting.title}\n${transcript.fullText}`,
      },
      ctx
    );
    await indexEntity(
      {
        tenantId: data.tenantId,
        clientId: meeting.clientId,
        entityType: "knowledge_document",
        entityId: doc.id,
        text: analysis.expectationBaselineMarkdown,
      },
      ctx
    );
  } catch {
    /* embedding provider unavailable — AOM keyword data still intact */
  }

  await publishEvent({
    tenantId: data.tenantId,
    eventType: EVENT_TYPES.meetingAnalyzed,
    entityType: "meeting",
    entityId: meetingId,
    payload: { clientId: meeting.clientId, confidence: confidence.score },
  });
}

export async function handleSowGeneration(data: AiJobData) {
  const { meetingId, sowId } = data.input as { meetingId: string; sowId: string };
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.tenantId, data.tenantId)));
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`);

  const ctx = {
    tenantId: data.tenantId,
    clientId: meeting.clientId,
    feature: "sow_generation",
    aiJobId: data.aiJobId,
  };

  const sow = await aiCompleteJson<{
    scopeItems: { title: string; description: string; deliverables: string[] }[];
    technicalFeasibility: { item: string; feasibility: string; risks: string[] }[];
    manDayEstimates: { item: string; optimistic: number; likely: number; pessimistic: number }[];
    optionTiers: { tier: string; name: string; includes: string[]; totalManDays: number }[];
    documentMarkdown: string;
  }>(
    `You are a delivery director producing a Scope of Work from analyzed meeting intelligence.

MEETING: ${meeting.title}
EXTRACTED REQUIREMENTS: ${JSON.stringify(meeting.extractedRequirements)}
EXTRACTED CHALLENGES: ${JSON.stringify(meeting.extractedChallenges)}
EXPECTATION BASELINE:
${meeting.expectationBaseline ?? "(none)"}

Return strict JSON:
- "scopeItems": [{title, description, deliverables[]}]
- "technicalFeasibility": [{item, feasibility: "feasible"|"feasible_with_risk"|"needs_discovery", risks[]}]
- "manDayEstimates": [{item, optimistic, likely, pessimistic}] (numbers, man-days)
- "optionTiers": exactly three tiers [{tier: "good"|"better"|"best", name, includes[], totalManDays}]
- "documentMarkdown": the full SOW document in markdown (Scope, Deliverables, Feasibility, Estimates table, Good/Better/Best comparison, Assumptions, Exclusions).
Base every estimate on the listed requirements only.`,
    ctx,
    { maxTokens: 8000 }
  );

  const confidence = computeConfidence({
    evidenceCount: (meeting.extractedRequirements as unknown[]).length,
    dataWindowDays: 1,
    dataFreshnessHours: 4,
    variability: 0.3,
    sourceCount: 1,
  });

  await db
    .update(sowDocuments)
    .set({
      scopeItems: sow.scopeItems,
      technicalFeasibility: { items: sow.technicalFeasibility },
      manDayEstimates: { items: sow.manDayEstimates },
      optionTiers: sow.optionTiers,
      documentMarkdown: sow.documentMarkdown,
      generationConfidence: String(confidence.score),
      updatedAt: new Date(),
    })
    .where(and(eq(sowDocuments.id, sowId), eq(sowDocuments.tenantId, data.tenantId)));

  await linkEntities({
    tenantId: data.tenantId,
    fromEntityType: "sow_document",
    fromEntityId: sowId,
    toEntityType: "meeting",
    toEntityId: meetingId,
    linkType: "generated_from",
  });

  await publishEvent({
    tenantId: data.tenantId,
    eventType: EVENT_TYPES.sowGenerated,
    entityType: "sow_document",
    entityId: sowId,
    payload: { clientId: meeting.clientId, meetingId },
  });
}

/**
 * AI Recommendation Verification Engine — every claim in a recommendation
 * must be backed by actual metric records; unverifiable claims are flagged.
 */
export async function handleRecommendationVerify(data: AiJobData) {
  const { recommendationId } = data.input as { recommendationId: string };
  const [rec] = await db
    .select()
    .from(recommendations)
    .where(
      and(eq(recommendations.id, recommendationId), eq(recommendations.tenantId, data.tenantId))
    );
  if (!rec) throw new Error(`Recommendation ${recommendationId} not found`);

  // Pull the last 90 days of metric facts for this client as evidence pool
  const facts = await db
    .select({
      metric: metricRecords.metric,
      date: metricRecords.date,
      value: metricRecords.value,
      provider: metricRecords.provider,
      sourceRequestId: metricRecords.sourceRequestId,
      sourceReferenceUrl: metricRecords.sourceReferenceUrl,
      id: metricRecords.id,
    })
    .from(metricRecords)
    .where(
      and(
        eq(metricRecords.tenantId, data.tenantId),
        eq(metricRecords.clientId, rec.clientId),
        dsql`${metricRecords.date} >= CURRENT_DATE - INTERVAL '90 days'`
      )
    )
    .orderBy(desc(metricRecords.date))
    .limit(2000);

  // Aggregate per metric for a compact evidence digest the model can cite
  const byMetric = new Map<string, { total: number; days: number; latest: string; sample: typeof facts }>();
  for (const f of facts) {
    const entry = byMetric.get(f.metric) ?? { total: 0, days: 0, latest: f.date, sample: [] };
    entry.total += Number(f.value);
    entry.days++;
    if (entry.sample.length < 5) entry.sample.push(f);
    byMetric.set(f.metric, entry);
  }
  const digest = [...byMetric.entries()].map(([metric, e]) => ({
    metric,
    totalLast90d: Math.round(e.total * 100) / 100,
    dataPoints: e.days,
    sampleRecordIds: e.sample.map((s) => s.id),
    sampleRequestIds: e.sample.map((s) => s.sourceRequestId).filter(Boolean),
  }));

  const ctx = {
    tenantId: data.tenantId,
    clientId: rec.clientId,
    feature: "recommendation_verify",
    aiJobId: data.aiJobId,
  };

  const verification = await aiCompleteJson<{
    claims: {
      claim: string;
      verdict: "supported" | "partially_supported" | "unsupported";
      evidence: string;
      metricsUsed: string[];
    }[];
    overallVerdict: "verified" | "needs_revision";
    revisedBody?: string;
  }>(
    `You are a rigorous analytics verifier. Verify each factual claim in this recommendation against the ACTUAL metric digest below. A claim is "supported" only when the digest data backs it.

RECOMMENDATION TITLE: ${rec.title}
RECOMMENDATION BODY:
${rec.body}

METRIC DIGEST (last 90 days, real platform data):
${JSON.stringify(digest)}

Return strict JSON:
- "claims": [{claim, verdict: "supported"|"partially_supported"|"unsupported", evidence: one sentence citing the metric and numbers used, metricsUsed: [metric names]}]
- "overallVerdict": "verified" if no unsupported claims, else "needs_revision"
- "revisedBody": only when needs_revision — the recommendation rewritten to drop unsupported claims.`,
    ctx,
    { maxTokens: 4000 }
  );

  const evidence = verification.claims.map((c) => {
    const records = c.metricsUsed.flatMap(
      (m) => byMetric.get(m)?.sample.map((s) => ({ id: s.id, requestId: s.sourceRequestId, url: s.sourceReferenceUrl })) ?? []
    );
    return {
      claim: c.claim,
      verdict: c.verdict,
      evidence: c.evidence,
      metricRecordIds: records.map((r) => r.id).slice(0, 5),
      sourceRequestIds: records.map((r) => r.requestId).filter(Boolean).slice(0, 5),
      sourceReferenceUrls: [...new Set(records.map((r) => r.url).filter(Boolean))].slice(0, 3),
    };
  });

  const supported = verification.claims.filter((c) => c.verdict === "supported").length;
  const confidence = computeConfidence({
    evidenceCount: facts.length,
    dataWindowDays: 90,
    dataFreshnessHours: facts.length ? 24 : 720,
    variability: 0.3,
    sanityPassRate: verification.claims.length
      ? supported / verification.claims.length
      : 0,
    sourceCount: new Set(facts.map((f) => f.provider)).size || 1,
  });

  await db
    .update(recommendations)
    .set({
      status: verification.overallVerdict === "verified" ? "verified" : "proposed",
      body: verification.revisedBody ?? rec.body,
      evidence,
      evidenceCount: facts.length,
      confidenceScore: String(confidence.score),
      dataSources: [...new Set(facts.map((f) => f.provider))],
      updatedAt: new Date(),
    })
    .where(eq(recommendations.id, recommendationId));

  try {
    await indexEntity(
      {
        tenantId: data.tenantId,
        clientId: rec.clientId,
        entityType: "recommendation",
        entityId: rec.id,
        text: `${rec.title}\n${verification.revisedBody ?? rec.body}`,
      },
      ctx
    );
  } catch {
    /* embeddings optional */
  }

  await publishEvent({
    tenantId: data.tenantId,
    eventType: EVENT_TYPES.recommendationVerified,
    entityType: "recommendation",
    entityId: rec.id,
    payload: {
      clientId: rec.clientId,
      verdict: verification.overallVerdict,
      confidence: confidence.score,
    },
  });
}

/**
 * Automated DMAIC Generator — converts a finding into a full
 * Define/Measure/Analyze/Improve/Control project with generated tasks.
 */
export async function handleDmaicGeneration(data: AiJobData) {
  const { dmaicProjectId } = data.input as { dmaicProjectId: string };
  const [project] = await db
    .select()
    .from(dmaicProjects)
    .where(and(eq(dmaicProjects.id, dmaicProjectId), eq(dmaicProjects.tenantId, data.tenantId)));
  if (!project) throw new Error(`DMAIC project ${dmaicProjectId} not found`);

  const facts = await db
    .select({
      metric: metricRecords.metric,
      total: dsql<string>`SUM(${metricRecords.value})`,
      days: dsql<string>`COUNT(DISTINCT ${metricRecords.date})`,
      provider: dsql<string>`MIN(${metricRecords.provider}::text)`,
    })
    .from(metricRecords)
    .where(
      and(
        eq(metricRecords.tenantId, data.tenantId),
        eq(metricRecords.clientId, project.clientId),
        dsql`${metricRecords.date} >= CURRENT_DATE - INTERVAL '90 days'`
      )
    )
    .groupBy(metricRecords.metric);

  const ctx = {
    tenantId: data.tenantId,
    clientId: project.clientId,
    feature: "dmaic",
    aiJobId: data.aiJobId,
  };

  const dmaic = await aiCompleteJson<{
    phases: {
      define: { goal: string; scope: string; stakeholders: string[]; problemQuantification: string };
      measure: { kpis: { name: string; baseline: string; target: string }[]; dataCollectionPlan: string };
      analyze: { hypotheses: { hypothesis: string; evidence: string }[]; rootCauses: string[] };
      improve: { interventions: { action: string; expectedImpact: string; effort: string }[] };
      control: { monitoringPlan: string; controlMetrics: string[]; reviewCadenceDays: number };
    };
    timeline: { phase: string; startOffsetDays: number; durationDays: number }[];
    tasks: { phase: string; title: string; description: string; estimateHours: number }[];
  }>(
    `You are a Lean Six Sigma master black belt working in a growth marketing agency. Build a complete DMAIC project.

PROBLEM STATEMENT: ${project.problemStatement}
CLIENT METRIC SUMMARY (last 90 days, real data): ${JSON.stringify(facts)}

Return strict JSON:
- "phases": {define: {goal, scope, stakeholders[], problemQuantification}, measure: {kpis: [{name, baseline, target}], dataCollectionPlan}, analyze: {hypotheses: [{hypothesis, evidence}], rootCauses[]}, improve: {interventions: [{action, expectedImpact, effort: "low"|"medium"|"high"}]}, control: {monitoringPlan, controlMetrics[], reviewCadenceDays}}
- "timeline": [{phase, startOffsetDays, durationDays}] for all five phases
- "tasks": 8-15 concrete tasks [{phase, title, description, estimateHours}]
Ground baselines in the metric summary; never invent numbers.`,
    ctx,
    { maxTokens: 8000 }
  );

  const today = new Date();
  const timeline = dmaic.timeline.map((t) => {
    const start = new Date(today.getTime() + t.startOffsetDays * 86400_000);
    const end = new Date(start.getTime() + t.durationDays * 86400_000);
    return {
      phase: t.phase,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    };
  });

  const evidenceCount = facts.reduce((a, f) => a + Number(f.days), 0);
  const confidence = computeConfidence({
    evidenceCount,
    dataWindowDays: 90,
    dataFreshnessHours: facts.length ? 24 : 720,
    variability: 0.35,
    sourceCount: new Set(facts.map((f) => f.provider)).size || 1,
  });

  await db
    .update(dmaicProjects)
    .set({
      phases: dmaic.phases,
      timeline,
      confidenceScore: String(confidence.score),
      dataSources: [...new Set(facts.map((f) => f.provider))],
      evidenceCount,
      updatedAt: new Date(),
    })
    .where(eq(dmaicProjects.id, dmaicProjectId));

  // Generate the execution tasks
  let order = 0;
  for (const task of dmaic.tasks) {
    const phaseWindow = timeline.find((t) => t.phase === task.phase);
    await db.insert(tasks).values({
      tenantId: data.tenantId,
      clientId: project.clientId,
      dmaicProjectId: project.id,
      dmaicPhase: task.phase,
      title: task.title,
      description: task.description,
      estimateHours: String(task.estimateHours),
      dueDate: phaseWindow?.endDate,
      sortOrder: order++,
    });
  }

  try {
    await indexEntity(
      {
        tenantId: data.tenantId,
        clientId: project.clientId,
        entityType: "dmaic_project",
        entityId: project.id,
        text: `${project.title}\n${project.problemStatement}\n${JSON.stringify(dmaic.phases)}`,
      },
      ctx
    );
  } catch {
    /* embeddings optional */
  }

  await publishEvent({
    tenantId: data.tenantId,
    eventType: EVENT_TYPES.dmaicGenerated,
    entityType: "dmaic_project",
    entityId: project.id,
    payload: { clientId: project.clientId, taskCount: dmaic.tasks.length },
  });
}

/** General report generation into the AOM. */
export async function handleReport(data: AiJobData) {
  const { clientId, title, focus } = data.input as {
    clientId: string;
    title: string;
    focus?: string;
  };

  const facts = await db
    .select({
      metric: metricRecords.metric,
      date: metricRecords.date,
      value: dsql<string>`SUM(${metricRecords.value})`,
    })
    .from(metricRecords)
    .where(
      and(
        eq(metricRecords.tenantId, data.tenantId),
        eq(metricRecords.clientId, clientId),
        dsql`${metricRecords.date} >= CURRENT_DATE - INTERVAL '30 days'`
      )
    )
    .groupBy(metricRecords.metric, metricRecords.date)
    .orderBy(metricRecords.date);

  const ctx = { tenantId: data.tenantId, clientId, feature: "report", aiJobId: data.aiJobId };
  const markdown = await aiComplete(
    `Write a client performance report in markdown titled "${title}". ${focus ? `Focus: ${focus}.` : ""}
Use ONLY this real daily data from the last 30 days (metric, date, value):
${JSON.stringify(facts.slice(0, 1500))}
Structure: Executive Summary, Performance by Metric (with concrete numbers), Notable Changes, Risks, Next Steps. Never invent numbers; if data is missing for an area, say so.`,
    ctx,
    { maxTokens: 6000 }
  );

  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      tenantId: data.tenantId,
      clientId,
      type: "report",
      title,
      contentMarkdown: markdown,
    })
    .returning();

  try {
    await indexEntity(
      { tenantId: data.tenantId, clientId, entityType: "knowledge_document", entityId: doc.id, text: markdown },
      ctx
    );
  } catch {
    /* embeddings optional */
  }
  return { documentId: doc.id };
}
