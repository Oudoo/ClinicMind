import { systemDb, withSystem } from "../src/lib/db";
import { tidyNotifications } from "../src/modules/notifications/tidy";

/**
 * Clear the alert backlog the old rules left: escalation alerts for cases
 * already taken, the pile of 30-minute reminders per case (the newest one per
 * person stays unread) and the "Double booking refused" alerts.
 *
 *   npm run notifications:tidy -- <tenant-slug>            # report only
 *   npm run notifications:tidy -- --all                    # report only, every active clinic
 *   npm run notifications:tidy -- <tenant-slug> --apply    # mark them read
 *
 * Nothing is deleted: the alerts are marked read and stay under "All". Safe to re-run.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const all = args.includes("--all");
  const apply = args.includes("--apply");
  const slug = args.find((a) => !a.startsWith("--"));
  if (!all && !slug) {
    console.error("usage: npm run notifications:tidy -- <tenant-slug> | --all [--apply]");
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

  console.log(apply ? "Marking the old alerts read…" : "Dry run: nothing is changed. Add --apply to mark them read.");
  let total = 0;
  for (const tenant of tenants) {
    const r = await tidyNotifications(tenant.id, { apply });
    const sum = r.settled + r.collapsed + r.refusals;
    total += sum;
    console.log(
      `[${tenant.slug}] ${sum} ${apply ? "marked read" : "to mark read"}: ${r.settled} for cases already taken, ${r.collapsed} older reminders, ${r.refusals} refused-booking alerts`,
    );
  }
  console.log(`\n${total} alert(s) ${apply ? "marked read" : "to mark read"}.`);
}

// An operator script: it works across clinics, outside row-level security (src/lib/db.ts).
withSystem(main)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => systemDb.$disconnect());
