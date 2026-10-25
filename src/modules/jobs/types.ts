/**
 * Background jobs: small, idempotent functions the scheduler runs every
 * minute in-process (or an external cron triggers through POST /api/cron/run).
 * Each module registers its own in `<module>/jobs.ts`; the registry lists them.
 */
export interface JobContext {
  now: Date;
  log: (message: string) => void;
}

export interface Job {
  /** Unique, kebab-case: "concierge-dispatch". */
  name: string;
  /** Minimum minutes between two runs. */
  everyMinutes: number;
  /** Return a one-line summary for the log, or nothing. */
  run(ctx: JobContext): Promise<string | void>;
}

export interface JobResult {
  ok: boolean;
  skipped?: boolean;
  summary?: string;
  error?: string;
  ms: number;
}
