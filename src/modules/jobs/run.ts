import { systemDb, withSystem } from "@/lib/db";
import { JOBS } from "./registry";
import type { JobResult } from "./types";

export interface RunOptions {
  /** Run every job now regardless of its interval. */
  force?: boolean;
  /** Only these job names. */
  only?: readonly string[];
}

/** A tick that comes a few seconds early (timers drift) still finds its job due. */
const EARLY_MS = 5_000;

/**
 * Claim the run of job `name` at `now`: true when this caller should run it. Every server process
 * runs the same scheduler, and the cron endpoint can run jobs too; the row in job_runs decides,
 * since only one caller's update finds the last run old enough (or, forced, every caller's does).
 */
export async function claimJobRun(name: string, now: Date, everyMinutes: number, force = false): Promise<boolean> {
  const dueBefore = new Date(now.getTime() - everyMinutes * 60_000 + EARLY_MS);
  const claimed = force
    ? await systemDb.$queryRaw<{ name: string }[]>`
        INSERT INTO "job_runs" ("name", "lastRunAt") VALUES (${name}, ${now})
        ON CONFLICT ("name") DO UPDATE SET "lastRunAt" = EXCLUDED."lastRunAt"
        RETURNING "name"`
    : await systemDb.$queryRaw<{ name: string }[]>`
        INSERT INTO "job_runs" ("name", "lastRunAt") VALUES (${name}, ${now})
        ON CONFLICT ("name") DO UPDATE SET "lastRunAt" = EXCLUDED."lastRunAt"
        WHERE "job_runs"."lastRunAt" <= ${dueBefore}
        RETURNING "name"`;
  return claimed.length > 0;
}

/**
 * Run the jobs that are due. Failures are isolated per job and logged; the
 * result map says what happened to each one. Jobs work across clinics (each
 * filters by its clinic itself), so they run in the system database scope,
 * outside row-level security (lib/db.ts).
 */
export async function runDueJobs(now: Date = new Date(), opts: RunOptions = {}): Promise<Record<string, JobResult>> {
  const results: Record<string, JobResult> = {};
  for (const job of JOBS) {
    if (opts.only && !opts.only.includes(job.name)) continue;
    const started = Date.now();
    try {
      if (!(await claimJobRun(job.name, now, job.everyMinutes, opts.force))) {
        results[job.name] = { ok: true, skipped: true, ms: 0 };
        continue;
      }
      const summary = await withSystem(() => job.run({ now, log: (m) => console.info(`[jobs] ${job.name}: ${m}`) }));
      results[job.name] = { ok: true, summary: summary ?? undefined, ms: Date.now() - started };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[jobs] ${job.name} failed`, err);
      results[job.name] = { ok: false, error, ms: Date.now() - started };
    }
  }
  return results;
}
