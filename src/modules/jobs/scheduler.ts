import { runDueJobs } from "./run";

const TICK_MS = 60_000;
const FIRST_TICK_MS = 20_000;

/**
 * In-process scheduler: one timer per server process, started from
 * instrumentation.ts. Fine for a single instance; with several instances set
 * SCHEDULER=off on all but one, or use the cron endpoint instead.
 */
export function startScheduler(): void {
  const g = globalThis as typeof globalThis & { __clinicmindScheduler?: ReturnType<typeof setInterval> };
  if (g.__clinicmindScheduler) return;
  const tick = () => {
    runDueJobs().catch((err) => console.error("[jobs] tick failed", err));
  };
  const first = setTimeout(tick, FIRST_TICK_MS);
  first.unref?.();
  g.__clinicmindScheduler = setInterval(tick, TICK_MS);
  g.__clinicmindScheduler.unref?.();
  console.info("[jobs] in-process scheduler started (every minute)");
}
