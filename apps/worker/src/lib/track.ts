import { eq } from "drizzle-orm";
import { db, queueJobs } from "@growengine/db";
import type { Job } from "bullmq";

/** Mirror BullMQ job lifecycle into queue_jobs for the health dashboard. */
export async function markJobStatus(
  job: Job,
  status: "active" | "completed" | "failed",
  error?: string
) {
  try {
    const finished = status === "completed" || status === "failed";
    await db
      .update(queueJobs)
      .set({
        status,
        error: error ?? null,
        attempts: job.attemptsMade,
        durationMs: job.processedOn ? Date.now() - job.processedOn : null,
        finishedAt: finished ? new Date() : null,
      })
      .where(eq(queueJobs.bullJobId, String(job.id)));
  } catch {
    /* tracking must never break job processing */
  }
}
