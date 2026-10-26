import { describe, expect, it } from "vitest";
import { MAX_PHOTOS, parsePhotoPayload, sniffImageType } from "@/modules/concierge/checkins";
import { DEFAULT_PROTOCOLS } from "@/modules/concierge/protocols";
import { clinicDayNumber, planTasks } from "@/modules/concierge/service";
import { isWithinHours, normalizeSettings } from "@/modules/concierge/settings";
import { zonedParts } from "@/lib/time";

/**
 * Pure scheduling and roster logic: when each protocol step goes out on the
 * clinic clock (Cairo leaves daylight saving on 30 Oct 2026), the day number,
 * who is "in hours", and what counts as a photo.
 */
const TZ = "Africa/Cairo";
const hair = DEFAULT_PROTOCOLS.find((p) => p.treatmentKey === "hair-transplant")!;
const wall = (d: Date) => {
  const p = zonedParts(d, TZ);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

describe("planTasks", () => {
  it("keeps the procedure's clinic-clock time across the daylight-saving change", () => {
    // 11:00 Cairo summer time (UTC+3) on 27 Oct 2026; Cairo is UTC+2 from 30 Oct.
    const performedAt = new Date("2026-10-27T08:00:00Z");
    const plan = planTasks(hair.steps, performedAt, TZ);
    expect(plan.map((t) => [t.kind, wall(t.dueAt)])).toEqual([
      ["INSTRUCTION", "2026-10-27 15:00"], // + 4 h
      ["CHECK_IN", "2026-10-28 11:00"], // day 1
      ["CHECK_IN", "2026-10-30 11:00"], // day 3, first day of winter time
      ["CHECK_IN", "2026-11-03 11:00"], // day 7
      ["PHOTO_REQUEST", "2026-11-03 12:00"], // day 7 + 1 h
      ["CHECK_IN", "2026-11-10 11:00"], // day 14
      ["CHECK_IN", "2026-11-26 11:00"], // month 1
      ["PHOTO_REQUEST", "2027-01-25 11:00"], // month 3
      ["PHOTO_REQUEST", "2027-04-25 11:00"], // month 6
      ["CHECK_IN", "2027-10-27 11:00"], // month 12 (Cairo summer time again)
    ]);
    expect(plan[3]!.dueAt.toISOString()).toBe("2026-11-03T09:00:00.000Z");
    expect(plan.map((t) => t.stepIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("moves early-morning check-ins and photo requests to 10:00, never instructions", () => {
    const performedAt = new Date("2026-11-15T05:30:00Z"); // 07:30 Cairo
    const plan = planTasks(hair.steps, performedAt, TZ);
    expect(wall(plan[0]!.dueAt)).toBe("2026-11-15 11:30"); // instruction, + 4 h
    expect(wall(plan[1]!.dueAt)).toBe("2026-11-16 10:00"); // day 1 would be 07:30
    expect(wall(plan[4]!.dueAt)).toBe("2026-11-22 10:00"); // day-7 photos would be 08:30
    const night = planTasks([{ ...hair.steps[0]!, offsetHours: 2 }], new Date("2026-11-15T22:30:00Z"), TZ);
    expect(wall(night[0]!.dueAt)).toBe("2026-11-16 02:30"); // an instruction keeps its time
  });

  it("counts clinic days, not 24-hour periods", () => {
    const performed = new Date("2026-11-15T18:00:00Z"); // 20:00 Cairo
    expect(clinicDayNumber(performed, new Date("2026-11-15T21:00:00Z"), TZ)).toBe(0); // 23:00 the same day
    expect(clinicDayNumber(performed, new Date("2026-11-16T07:00:00Z"), TZ)).toBe(1); // 09:00 next morning, 13 h later
    expect(clinicDayNumber(performed, new Date("2026-11-22T07:00:00Z"), TZ)).toBe(7);
    expect(clinicDayNumber(performed, new Date("2026-11-14T07:00:00Z"), TZ)).toBe(0); // never negative
  });
});

describe("roster hours", () => {
  const hours = { days: [6, 0, 1, 2, 3, 4], start: "09:00", end: "21:00" }; // Saturday–Thursday
  it("is in hours on a working day between start and end, on the clinic clock", () => {
    expect(isWithinHours(new Date("2026-11-16T08:00:00Z"), TZ, hours)).toBe(true); // Monday 10:00
    expect(isWithinHours(new Date("2026-11-16T06:59:00Z"), TZ, hours)).toBe(false); // Monday 08:59
    expect(isWithinHours(new Date("2026-11-16T19:00:00Z"), TZ, hours)).toBe(false); // Monday 21:00
    expect(isWithinHours(new Date("2026-11-20T10:00:00Z"), TZ, hours)).toBe(false); // Friday noon
  });

  it("handles overnight shifts and the whole-day form", () => {
    const night = { days: [1], start: "22:00", end: "06:00" }; // Monday night
    expect(isWithinHours(new Date("2026-11-16T21:00:00Z"), TZ, night)).toBe(true); // Monday 23:00
    expect(isWithinHours(new Date("2026-11-17T02:00:00Z"), TZ, night)).toBe(true); // Tuesday 04:00, still Monday's shift
    expect(isWithinHours(new Date("2026-11-17T21:00:00Z"), TZ, night)).toBe(false); // Tuesday 23:00
    expect(isWithinHours(new Date("2026-11-20T10:00:00Z"), TZ, { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" })).toBe(true);
    expect(isWithinHours(new Date("2026-11-16T08:00:00Z"), TZ, { days: [], start: "09:00", end: "21:00" })).toBe(false);
  });

  it("normalizes junk settings back to the defaults", () => {
    const s = normalizeSettings({ hours: { days: [9, "x", 1], start: "25:00" }, roster: { inHoursUserId: "  " }, ackMinutes: { inHours: 0, outOfHours: 30 } });
    expect(s.hours).toEqual({ days: [1], start: "09:00", end: "21:00" });
    expect(s.roster).toEqual({ inHoursUserId: null, outOfHoursUserId: null, backupUserId: null });
    expect(s.ackMinutes).toEqual({ inHours: 15, outOfHours: 30 });
    expect(normalizeSettings(null).ackMinutes).toEqual({ inHours: 15, outOfHours: 30 });
  });
});

describe("photos", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  it("types an image by its bytes, never by its name", () => {
    expect(sniffImageType(jpeg)).toBe("image/jpeg");
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("\0\0\0\x18ftypheic\0\0\0\0"))).toBe("image/heic");
    expect(sniffImageType(svg)).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it("reads base64 photos with or without a data URL prefix", () => {
    const [a, b] = parsePhotoPayload([
      { view: "front", type: "image/png", data: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
      { view: "top", data: png.toString("base64") },
    ]);
    expect(a).toMatchObject({ view: "front", mimeType: "image/jpeg" });
    expect(a!.bytes.equals(jpeg)).toBe(true);
    expect(b).toMatchObject({ view: "top", mimeType: "image/png" });
    expect(parsePhotoPayload(undefined)).toEqual([]);
  });

  it("refuses too many photos and unreadable data", () => {
    const one = { data: jpeg.toString("base64") };
    expect(() => parsePhotoPayload(Array.from({ length: MAX_PHOTOS + 1 }, () => one))).toThrow(/At most/);
    expect(() => parsePhotoPayload([{ data: "not base64 !!" }])).toThrow(/could not be read/);
    expect(() => parsePhotoPayload("x")).toThrow();
  });
});
