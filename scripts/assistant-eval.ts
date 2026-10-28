import { systemDb, withSystem } from "../src/lib/db";
import { formatEvalTable, runEvalSet } from "../src/modules/assistant/eval/run";

/**
 * Run the assistant's evaluation set against a real clinic (the demo by
 * default) and print a table: for every question, the answer mode, how many
 * patients were expected and listed, precision and recall.
 *
 *   npm run assistant:eval            # the demo clinic (slug "demo")
 *   npm run assistant:eval -- <slug>  # another tenant
 *
 * The expected answers are computed from that clinic's records by the set's
 * own predicates (src/modules/assistant/eval/questions.ts), so the run checks
 * the assistant against the data as it is today. Answers are not logged.
 * Exits 1 when a question fails, 2 when the tenant does not exist. The open
 * questions are answered by retrieval: run `npm run ai:reindex -- <slug>`
 * first if the clinic was never indexed.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const slug = args.find((a) => !a.startsWith("--")) ?? "demo";
  const tenant = await systemDb.tenant.findFirst({ where: { slug, deletedAt: null }, select: { id: true, name: true } });
  if (!tenant) {
    console.error(`tenant "${slug}" not found (run the demo seed, or pass a tenant slug)`);
    process.exitCode = 2;
    return;
  }
  const owner = await systemDb.user.findFirst({
    where: { tenantId: tenant.id, role: "CLINIC_OWNER", deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true },
  });
  const started = Date.now();
  console.log(`Assistant evaluation set — ${tenant.name} (${slug})\n`);
  const outcomes = await runEvalSet({ tenantId: tenant.id, userId: owner?.id ?? null, email: owner?.email ?? null });
  console.log(formatEvalTable(outcomes));
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (outcomes.some((o) => !o.pass)) process.exitCode = 1;
}

// An operator script: it works across clinics, outside row-level security (src/lib/db.ts).
withSystem(main)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => systemDb.$disconnect());
