/**
 * Honest change chips on the overview (audit #13): relative change for counts
 * and money, percentage points for rates, "new" instead of "100%" when there
 * was nothing before, both values and both windows in the tooltip; the
 * "Total patients" tile compares the registry now with the registry 7 days
 * ago, and the no-show tile has no chip while a window had nothing due.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addDays, dateKeyInTz } from "@/lib/time";
import { DeltaChip, describeDelta } from "@/components/ui/kpi";
import { getOverview } from "@/modules/analytics/service";
import { createTenant, dbTestsEnabled, deleteTenants } from "@/test/db";

const TZ = "Africa/Cairo";
const DAY = 86_400_000;
const MINUS = "−";

describe("describeDelta", () => {
  it("relative mode: signed share of the previous value, coloured by the good direction", () => {
    expect(describeDelta(412, 398, "up")).toEqual({ text: "+4%", direction: "up", tone: "good" });
    expect(describeDelta(90, 120, "up")).toEqual({ text: `${MINUS}25%`, direction: "down", tone: "bad" });
    expect(describeDelta(90, 120, "down")).toMatchObject({ tone: "good" });
    expect(describeDelta(1000, 1004, "up")).toEqual({ text: "flat", direction: "flat", tone: "neutral" });
  });

  it("relative mode: nothing before reads 'new', never '100%'", () => {
    expect(describeDelta(7, 0, "up")).toEqual({ text: "new", direction: "up", tone: "good" });
    expect(describeDelta(5_000, 0, "down")).toEqual({ text: "new", direction: "up", tone: "bad" });
    expect(describeDelta(0, 0, "up")).toEqual({ text: "flat", direction: "flat", tone: "neutral" });
  });

  it("points mode: rates move in percentage points", () => {
    expect(describeDelta(0.086, 0.041, "down", "points")).toEqual({ text: "+4.5 pts", direction: "up", tone: "bad" });
    expect(describeDelta(0.041, 0.086, "down", "points")).toEqual({ text: `${MINUS}4.5 pts`, direction: "down", tone: "good" });
    // 4% → 8% doubles the rate, but it is four points, not "+100%".
    expect(describeDelta(0.08, 0.04, "down", "points").text).toBe("+4.0 pts");
    expect(describeDelta(0.08, 0.04, "down", "relative").text).toBe("+100%");
    // A previous rate of 0% is a real value in points mode.
    expect(describeDelta(0.05, 0, "up", "points")).toEqual({ text: "+5.0 pts", direction: "up", tone: "good" });
    expect(describeDelta(0.1204, 0.12, "up", "points")).toEqual({ text: "flat", direction: "flat", tone: "neutral" });
  });

  it("the chip's tooltip states both values and both windows", () => {
    const html = renderToStaticMarkup(
      createElement(DeltaChip, {
        current: 0.086,
        previous: 0.041,
        goodWhen: "down",
        mode: "points",
        format: (v: number) => `${Math.round(v * 1000) / 10}%`,
        currentLabel: "in the last 14 days (15–28 Oct)",
        previousLabel: "in the 14 days before (1–14 Oct)",
      }),
    );
    expect(html).toContain('title="8.6% in the last 14 days (15–28 Oct) · 4.1% in the 14 days before (1–14 Oct)"');
    expect(html).toContain("+4.5 pts");
    expect(html).toContain("text-danger");
    expect(renderToStaticMarkup(createElement(DeltaChip, { current: 3, previous: null, goodWhen: "up" }))).toBe("");
  });
});

describe.skipIf(!dbTestsEnabled)("getOverview comparisons", () => {
  const created: string[] = [];
  let busy: string;
  let quiet: string;
  const now = new Date();
  const ago = (days: number, hours = 0) => new Date(now.getTime() - days * DAY - hours * 3_600_000);

  beforeAll(async () => {
    busy = (await createTenant()).id;
    quiet = (await createTenant()).id;
    created.push(busy, quiet);

    const patient = (tenantId: string, fullName: string, createdAt: Date, deletedAt: Date | null = null) =>
      db.patient.create({ data: { tenantId, fullName, createdAt, deletedAt }, select: { id: true } });
    // In the registry 7 days ago and now.
    const kept = await Promise.all(["Old One", "Old Two", "Old Three"].map((n) => patient(busy, n, ago(30))));
    // In the registry 7 days ago, archived since.
    await patient(busy, "Archived This Week", ago(30), ago(2));
    // Archived before the window opened: in neither.
    await patient(busy, "Archived Long Ago", ago(30), ago(10));
    // New this week (one of them already archived again).
    await patient(busy, "New One", ago(2));
    await patient(busy, "New Two", ago(1));
    await patient(busy, "New And Gone", ago(2), ago(1));

    // No-shows: 1 of 4 due in the last 14 days, 1 of 2 in the 14 before; cancelled and waitlisted ones were never due.
    const appt = (tenantId: string, patientId: string, start: Date, status: "COMPLETED" | "NO_SHOW" | "CANCELLED" | "WAITLISTED") =>
      ({ tenantId, patientId, startsAt: start, endsAt: new Date(start.getTime() + 30 * 60_000), status }) as const;
    const p = kept[0]!.id;
    await db.appointment.createMany({
      data: [
        appt(busy, p, ago(3), "COMPLETED"),
        appt(busy, p, ago(3, 1), "COMPLETED"),
        appt(busy, p, ago(4), "COMPLETED"),
        appt(busy, p, ago(5), "NO_SHOW"),
        appt(busy, p, ago(5, 2), "CANCELLED"),
        appt(busy, p, ago(6), "WAITLISTED"),
        appt(busy, p, ago(18), "COMPLETED"),
        appt(busy, p, ago(20), "NO_SHOW"),
      ],
    });
    const q = (await patient(quiet, "Quiet Patient", ago(100))).id;
    await db.appointment.createMany({ data: [appt(quiet, q, ago(2), "COMPLETED"), appt(quiet, q, ago(3), "NO_SHOW")] });
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("compares the registry now with the registry 7 days ago, and counts this week's new records", async () => {
    const m = await getOverview(busy, now);
    expect(m.patients).toBe(5);
    expect(m.patientsWeekAgo).toBe(4);
    expect(m.patientsNew7).toBe(2);
    expect(describeDelta(m.patients, m.patientsWeekAgo, "up")).toMatchObject({ text: "+25%", tone: "good" });
    expect(m.windows).toMatchObject({
      today: dateKeyInTz(now, TZ),
      weekFrom: dateKeyInTz(addDays(now, -6, TZ), TZ),
      prevWeekTo: dateKeyInTz(addDays(now, -7, TZ), TZ),
      fortnightFrom: dateKeyInTz(addDays(now, -13, TZ), TZ),
      sameDayLastWeek: dateKeyInTz(addDays(now, -7, TZ), TZ),
    });
  });

  it("gives the no-show rate with what was due in each window, in points", async () => {
    const m = await getOverview(busy, now);
    expect(m).toMatchObject({ noShows: 1, noShowDue: 4, noShowDuePrev: 2, noShowRate: 0.25, noShowRatePrev: 0.5 });
    expect(describeDelta(m.noShowRate, m.noShowRatePrev!, "down", "points")).toEqual({ text: `${MINUS}25.0 pts`, direction: "down", tone: "good" });
  });

  it("has no previous rate (not 0%) when nothing was due in the previous window", async () => {
    const m = await getOverview(quiet, now);
    expect(m).toMatchObject({ noShowRate: 0.5, noShowDue: 2, noShowDuePrev: 0, noShowRatePrev: null, patients: 1, patientsWeekAgo: 1 });
  });
});
