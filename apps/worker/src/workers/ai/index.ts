import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db, aiJobs } from "@growengine/db";
import { bullConnectionOptions, QUEUE_NAMES, type AiJobData } from "@growengine/core";
import { markJobStatus } from "../../lib/track.js";
import {
  handleForecast,
  handleSeasonality,
  handleLostOpportunity,
  handleHealthScore,
  handleScorecards,
} from "./quant.js";
import {
  handleMeetingAnalysis,
  handleSowGeneration,
  handleRecommendationVerify,
  handleDmaicGeneration,
  handleReport,
} from "./analysis.js";
import {
  handleLeadAudit,
  handleDigest,
  handleQbr,
  handleProcessIntelligence,
} from "./reports.js";
import { handleAeoAudit } from "./aeo.js";
import { handleEmbedding, handleRetentionEnforcement } from "./maintenance.js";

/**
 * AI Worker — reports, DMAIC formulation, AEO/GEO audits, meeting
 * analysis, verification, forecasting, digests and maintenance. Each job
 * is tracked end-to-end in ai_jobs with cost linkage via cost_tracking.
 */

const handlers: Record<AiJobData["jobType"], (data: AiJobData) => Promise<unknown>> = {
  report: handleReport,
  dmaic: handleDmaicGeneration,
  aeo_audit: handleAeoAudit,
  meeting_analysis: handleMeetingAnalysis,
  sow: handleSowGeneration,
  recommendation_verify: handleRecommendationVerify,
  forecast: handleForecast,
  embedding: handleEmbedding,
  lead_audit: handleLeadAudit,
  qbr: handleQbr,
  digest: handleDigest,
  lost_opportunity: handleLostOpportunity,
  seasonality: handleSeasonality,
  process_intelligence: handleProcessIntelligence,
  health_score: handleHealthScore,
  scorecards: handleScorecards,
  retention_enforcement: handleRetentionEnforcement,
};

export function createAiWorker() {
  const worker = new Worker<AiJobData>(
    QUEUE_NAMES.ai,
    async (job: Job<AiJobData>) => {
      await markJobStatus(job, "active");
      const { aiJobId, jobType } = job.data;

      if (aiJobId) {
        await db
          .update(aiJobs)
          .set({
            status: "running",
            queueJobId: String(job.id),
            attempts: job.attemptsMade + 1,
            startedAt: new Date(),
          })
          .where(eq(aiJobs.id, aiJobId));
      }

      try {
        const handler = handlers[jobType];
        if (!handler) throw new Error(`Unknown AI job type: ${jobType}`);
        const output = await handler(job.data);
        if (aiJobId) {
          await db
            .update(aiJobs)
            .set({
              status: "completed",
              output: (output as Record<string, unknown>) ?? {},
              completedAt: new Date(),
            })
            .where(eq(aiJobs.id, aiJobId));
        }
        return output;
      } catch (err) {
        if (aiJobId) {
          await db
            .update(aiJobs)
            .set({ status: "failed", error: (err as Error).message })
            .where(eq(aiJobs.id, aiJobId));
        }
        throw err;
      }
    },
    { connection: bullConnectionOptions(), concurrency: 2 }
  );
  worker.on("completed", (job) => markJobStatus(job, "completed"));
  worker.on("failed", (job, err) => job && markJobStatus(job, "failed", err.message));
  return worker;
}
