import { JOBS } from "./registry";
import type { JobResult } from "./types";

const lastRun = new Map<string, number>();

export interface RunOptions {
  /** Run every job now regardless of its interval. */
  force?: boolean;
  /** Only these job names. */
  only?: readonly string[];
}

/**
 * Run the jobs that are due. Failures are isolated per job and logged; the
 * result map says what happened to each one.
 */
export async function runDueJobs(now: Date = new Date(), opts: RunOptions = {}): Promise<Record<string, JobResult>> {
  const results: Record<string, JobResult> = {};
  for (const job of JOBS) {
    if (opts.only && !opts.only.includes(job.name)) continue;
    const last = lastRun.get(job.name) ?? 0;
    if (!opts.force && now.getTime() - last < job.everyMinutes * 60_000) {
      results[job.name] = { ok: true, skipped: true, ms: 0 };
      continue;
    }
    const started = Date.now();
    lastRun.set(job.name, now.getTime());
    try {
      const summary = await job.run({ now, log: (m) => console.info(`[jobs] ${job.name}: ${m}`) });
      results[job.name] = { ok: true, summary: summary ?? undefined, ms: Date.now() - started };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[jobs] ${job.name} failed`, err);
      results[job.name] = { ok: false, error, ms: Date.now() - started };
    }
  }
  return results;
}

/** For tests: forget when jobs last ran. */
export function resetJobClock(): void {
  lastRun.clear();
}
