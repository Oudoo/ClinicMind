import { systemDb, withSystem } from "../src/lib/db";
import { dedupeFollowUps } from "../src/modules/concierge/service";

/**
 * Patients with two or more concierge follow-ups running for the same treatment
 * (started before one-per-treatment held), so they get every check-in twice.
 *
 *   npm run concierge:dedupe -- <tenant-slug>            # report only
 *   npm run concierge:dedupe -- --all                    # report only, every active clinic
 *   npm run concierge:dedupe -- <tenant-slug> --apply    # keep the latest session's, stop the others
 *
 * With --apply each earlier follow-up is stopped as "replaced" (pending steps
 * skipped, open check-in links closed; answers, missed steps and escalations
 * kept), with a timeline entry and an audit record. Safe to re-run.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const all = args.includes("--all");
  const apply = args.includes("--apply");
  const slug = args.find((a) => !a.startsWith("--"));
  if (!all && !slug) {
    console.error("usage: npm run concierge:dedupe -- <tenant-slug> | --all [--apply]");
    process.exitCode = 2;
    return;
  }
  const tenants = all
    ? await systemDb.tenant.findMany({ where: { deletedAt: null, status: "ACTIVE" }, select: { id: true, slug: true }, orderBy: { slug: "asc" } })
    : await systemDb.tenant.findMany({ where: { slug: slug!, deletedAt: null }, select: { id: true, slug: true } });
  if (!tenants.length) {
    console.error(all ? "no active tenants found" : `tenant "${slug}" not found`);
    process.exitCode = 1;
    return;
  }

  console.log(apply ? "Stopping duplicate follow-ups (keeping each treatment's latest)…" : "Dry run: nothing is changed. Add --apply to stop the duplicates.");
  let total = 0;
  for (const tenant of tenants) {
    const found = await dedupeFollowUps(tenant.id, { apply, actor: { email: "script:concierge-dedupe" } });
    for (const f of found) {
      total += f.replaced.length;
      console.log(`[${tenant.slug}] ${f.patientName} · ${f.treatment}: keep ${f.kept}, ${apply ? "stopped" : "would stop"} ${f.replaced.join(", ")}`);
    }
    if (!found.length) console.log(`[${tenant.slug}] no duplicate follow-ups`);
  }
  console.log(`\n${total} follow-up(s) ${apply ? "stopped" : "to stop"}.`);
}

// An operator script: it works across clinics, outside row-level security (src/lib/db.ts).
withSystem(main)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => systemDb.$disconnect());
