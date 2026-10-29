import { afterAll, describe, expect, it } from "vitest";
import { systemDb as db } from "@/lib/db";
import { claimJobRun } from "@/modules/jobs/run";
import { dbTestsEnabled } from "@/test/db";

/** Server processes share the database: each job's run is claimed there, once per interval. */
describe.skipIf(!dbTestsEnabled)("background job runs", () => {
  const name = `test-job-${Date.now()}`;
  afterAll(() => db.jobRun.deleteMany({ where: { name } }));

  it("lets one of two processes run a due job, and the other skip it", async () => {
    const now = new Date("2026-10-29T10:00:00Z");
    const claims = await Promise.all([claimJobRun(name, now, 5), claimJobRun(name, now, 5)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("is due again once its interval has passed, a few seconds early included", async () => {
    expect(await claimJobRun(name, new Date("2026-10-29T10:04:00Z"), 5)).toBe(false);
    expect(await claimJobRun(name, new Date("2026-10-29T10:04:57Z"), 5)).toBe(true);
    expect(await claimJobRun(name, new Date("2026-10-29T10:05:30Z"), 5)).toBe(false);
  });

  it("a forced run always goes ahead and starts the interval again", async () => {
    expect(await claimJobRun(name, new Date("2026-10-29T10:06:00Z"), 5, true)).toBe(true);
    expect(await claimJobRun(name, new Date("2026-10-29T10:10:00Z"), 5)).toBe(false);
    expect(await claimJobRun(name, new Date("2026-10-29T10:11:00Z"), 5)).toBe(true);
  });
});
