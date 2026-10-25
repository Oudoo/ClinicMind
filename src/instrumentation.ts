/**
 * Runs once when the Node server starts (never during `next build`): starts the
 * in-process job scheduler unless SCHEDULER=off or the process is a test.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SCHEDULER === "off" || process.env.NODE_ENV === "test") return;
  const { startScheduler } = await import("@/modules/jobs/scheduler");
  startScheduler();
}
