/**
 * Runs once when the Node server starts (never during `next build`): says
 * whether the clinic isolation policies bind the app's database connection,
 * and starts the in-process job scheduler unless SCHEDULER=off or the process
 * is a test.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "test") return;
  const { rlsStatus } = await import("@/lib/db");
  rlsStatus().then(
    (s) => {
      if (!s.enforced) console.warn(`[db] row-level security is NOT enforced: ${s.reason}. Connect as clinicmind_app (docs/RUNBOOK.md §2).`);
      else if (!s.systemCanReachAllClinics) console.error("[db] SYSTEM_DATABASE_URL must connect as the owner: sign-in and other cross-clinic work cannot see any clinic (docs/RUNBOOK.md §2).");
      else console.info(`[db] row-level security enforced (connected as ${s.role})`);
    },
    (err) => console.warn("[db] could not check row-level security", err instanceof Error ? err.message : err),
  );
  if (process.env.SCHEDULER === "off") return;
  const { startScheduler } = await import("@/modules/jobs/scheduler");
  startScheduler();
}
