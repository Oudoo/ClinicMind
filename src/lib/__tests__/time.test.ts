import { describe, expect, it, vi } from "vitest";
import {
  addDays,
  dateKeyInTz,
  endOfDayInTz,
  formatDateInTz,
  formatDateTimeInTz,
  formatTimeInTz,
  fromDateKey,
  fromLocalInput,
  isSameDayInTz,
  isValidTimeZone,
  minutesBetween,
  startOfDayInTz,
  startOfWeekInTz,
  toLocalInput,
  tzOffsetMs,
  zonedParts,
  zonedTimeToUtc,
} from "@/lib/time";

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const HOUR = 60 * 60 * 1000;

/**
 * Zones under test (ICU/tzdata 2025b):
 *  - Asia/Riyadh: UTC+3 all year, no DST.
 *  - Africa/Cairo: UTC+2 in winter; Egypt reinstated DST in 2023, switching at
 *    *midnight* (24 Apr 2026 00:00 → 01:00 EEST; 29 Oct 2026 24:00 → 23:00 EET),
 *    so even the start of a day can sit on a transition.
 *  - Europe/London: 29 Mar 2026 01:00 UTC (GMT → BST), 25 Oct 2026 01:00 UTC (BST → GMT).
 */
describe("time helpers", () => {
  describe("DST-free zone (Asia/Riyadh)", () => {
    it("brackets a day at local midnight and 23:59:59.999", () => {
      const noon = new Date("2026-07-15T10:00:00Z");
      expect(iso(startOfDayInTz(noon, "Asia/Riyadh"))).toBe("2026-07-14T21:00:00.000Z");
      expect(iso(endOfDayInTz(noon, "Asia/Riyadh"))).toBe("2026-07-15T20:59:59.999Z");
      expect(tzOffsetMs(noon, "Asia/Riyadh")).toBe(3 * HOUR);
    });

    it("assigns an instant just before local midnight to the earlier day", () => {
      const lateEvening = new Date("2026-07-15T20:59:59Z"); // 23:59:59 local
      const justAfter = new Date("2026-07-15T21:00:00Z"); // 00:00:00 next day
      expect(dateKeyInTz(lateEvening, "Asia/Riyadh")).toBe("2026-07-15");
      expect(dateKeyInTz(justAfter, "Asia/Riyadh")).toBe("2026-07-16");
      expect(isSameDayInTz(lateEvening, justAfter, "Asia/Riyadh")).toBe(false);
    });
  });

  describe("Africa/Cairo (the default clinic zone)", () => {
    it("uses UTC+2 in winter", () => {
      const d = new Date("2026-01-15T10:00:00Z");
      expect(tzOffsetMs(d, "Africa/Cairo")).toBe(2 * HOUR);
      expect(iso(startOfDayInTz(d, "Africa/Cairo"))).toBe("2026-01-14T22:00:00.000Z");
      expect(iso(endOfDayInTz(d, "Africa/Cairo"))).toBe("2026-01-15T21:59:59.999Z");
      expect(zonedParts(d, "Africa/Cairo")).toEqual({
        year: 2026,
        month: 1,
        day: 15,
        hour: 12,
        minute: 0,
        second: 0,
        weekday: 4,
      });
    });

    it("starts the day the clocks spring forward at 01:00 local (midnight does not exist)", () => {
      const d = new Date("2026-04-24T10:00:00Z");
      // 24 Apr 2026 00:00 EET never happens; the day begins at 01:00 EEST = 22:00Z.
      expect(iso(startOfDayInTz(d, "Africa/Cairo"))).toBe("2026-04-23T22:00:00.000Z");
      expect(iso(endOfDayInTz(new Date("2026-04-23T10:00:00Z"), "Africa/Cairo"))).toBe(
        "2026-04-23T21:59:59.999Z",
      );
      expect(iso(fromLocalInput("2026-04-24T00:30", "Africa/Cairo"))).toBe("2026-04-23T22:30:00.000Z");
    });

    it("gives the day the clocks fall back 25 hours", () => {
      const d = new Date("2026-10-29T10:00:00Z");
      const start = startOfDayInTz(d, "Africa/Cairo");
      const end = endOfDayInTz(d, "Africa/Cairo");
      expect(iso(start)).toBe("2026-10-28T21:00:00.000Z"); // 00:00 EEST
      expect(iso(end)).toBe("2026-10-29T21:59:59.999Z"); // 23:59:59.999 EET
      expect(end.getTime() - start.getTime() + 1).toBe(25 * HOUR);
    });

    it("starts the week on Saturday", () => {
      // Thursday 22 Oct 2026 → Saturday 17 Oct 2026 00:00 EEST.
      expect(iso(startOfWeekInTz(new Date("2026-10-22T10:00:00Z"), "Africa/Cairo"))).toBe(
        "2026-10-16T21:00:00.000Z",
      );
      // A Saturday is its own week start.
      expect(iso(startOfWeekInTz(new Date("2026-10-24T10:00:00Z"), "Africa/Cairo"))).toBe(
        "2026-10-23T21:00:00.000Z",
      );
      // 23:30Z on Friday is already Saturday 02:30 in Cairo.
      expect(iso(startOfWeekInTz(new Date("2026-10-23T23:30:00Z"), "Africa/Cairo"))).toBe(
        "2026-10-23T21:00:00.000Z",
      );
      // Other week starts are supported (Monday).
      expect(iso(startOfWeekInTz(new Date("2026-10-22T10:00:00Z"), "Europe/London", 1))).toBe(
        "2026-10-18T23:00:00.000Z",
      );
    });

    it("round-trips datetime-local input on the clinic clock", () => {
      const instant = new Date("2026-10-22T07:05:00Z");
      expect(toLocalInput(instant, "Africa/Cairo")).toBe("2026-10-22T10:05");
      expect(iso(fromLocalInput("2026-10-22T10:05", "Africa/Cairo"))).toBe(iso(instant));
      expect(iso(fromLocalInput("2026-10-22T10:05:30", "Africa/Cairo"))).toBe("2026-10-22T07:05:30.000Z");
    });

    it("formats dates and times in the zone", () => {
      const lateUtc = new Date("2026-10-22T22:30:00Z"); // 01:30 on the 23rd in Cairo (EEST)
      expect(formatTimeInTz(new Date("2026-10-22T07:05:00Z"), "Africa/Cairo")).toBe("10:05");
      expect(formatDateInTz(lateUtc, "Africa/Cairo")).toBe("23 Oct 2026");
      expect(formatDateInTz(lateUtc, "Africa/Cairo", { weekday: "short", day: "2-digit", month: "short" })).toBe(
        "Fri 23 Oct",
      );
      expect(formatDateTimeInTz(lateUtc, "Africa/Cairo")).toBe("23 Oct 2026, 01:30");
      expect(formatTimeInTz(new Date("2026-01-14T22:00:00Z"), "Africa/Cairo")).toBe("00:00");
      expect(dateKeyInTz(lateUtc, "Africa/Cairo")).toBe("2026-10-23");
      expect(dateKeyInTz(lateUtc, "UTC")).toBe("2026-10-22");
    });

    it("puts a plain space after a weekday, as the browser's ICU may put a comma (hydration)", () => {
      const browserParts: Intl.DateTimeFormatPart[] = [
        { type: "weekday", value: "Mon" },
        { type: "literal", value: ", " },
        { type: "day", value: "26" },
        { type: "literal", value: " " },
        { type: "month", value: "Oct" },
      ];
      const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(browserParts);
      try {
        expect(formatDateInTz(new Date("2026-10-26T10:00:00Z"), "Africa/Cairo", { weekday: "short", day: "2-digit", month: "short" })).toBe("Mon 26 Oct");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("Europe/London around DST transitions", () => {
    it("the spring-forward day is 23 hours long", () => {
      const d = new Date("2026-03-29T12:00:00Z");
      const start = startOfDayInTz(d, "Europe/London");
      const end = endOfDayInTz(d, "Europe/London");
      expect(iso(start)).toBe("2026-03-29T00:00:00.000Z");
      expect(iso(end)).toBe("2026-03-29T22:59:59.999Z");
      expect(end.getTime() - start.getTime() + 1).toBe(23 * HOUR);
    });

    it("the fall-back day is 25 hours long", () => {
      const d = new Date("2026-10-25T12:00:00Z");
      const start = startOfDayInTz(d, "Europe/London");
      const end = endOfDayInTz(d, "Europe/London");
      expect(iso(start)).toBe("2026-10-24T23:00:00.000Z");
      expect(iso(end)).toBe("2026-10-25T23:59:59.999Z");
      expect(end.getTime() - start.getTime() + 1).toBe(25 * HOUR);
    });

    it("moves a wall time inside the spring gap forward past it", () => {
      // 01:30 on 29 Mar 2026 never happens in London; it becomes 02:30 BST.
      expect(iso(fromLocalInput("2026-03-29T01:30", "Europe/London"))).toBe("2026-03-29T01:30:00.000Z");
      expect(toLocalInput(new Date("2026-03-29T01:30:00Z"), "Europe/London")).toBe("2026-03-29T02:30");
    });

    it("resolves an ambiguous autumn wall time to the earlier instant", () => {
      // 01:30 on 25 Oct 2026 happens twice; the first is 01:30 BST = 00:30Z.
      expect(iso(fromLocalInput("2026-10-25T01:30", "Europe/London"))).toBe("2026-10-25T00:30:00.000Z");
      expect(iso(zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, "Europe/London"))).toBe(
        "2026-10-25T00:30:00.000Z",
      );
      // Negative-offset zones behave the same way (America/New_York, 1 Nov 2026).
      expect(iso(fromLocalInput("2026-11-01T01:30", "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
      expect(iso(fromLocalInput("2026-03-08T02:30", "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    });

    it("addDays keeps midnight at midnight across the transition when a zone is given", () => {
      const midnightBefore = startOfDayInTz(new Date("2026-03-28T12:00:00Z"), "Europe/London"); // 28 Mar 00:00 GMT
      const twoDaysLater = addDays(midnightBefore, 2, "Europe/London");
      expect(iso(twoDaysLater)).toBe("2026-03-29T23:00:00.000Z"); // 30 Mar 00:00 BST
      expect(toLocalInput(twoDaysLater, "Europe/London")).toBe("2026-03-30T00:00");
      // Without a zone exactly 48 hours are added.
      expect(iso(addDays(midnightBefore, 2))).toBe("2026-03-30T00:00:00.000Z");
      // Negative steps and millisecond preservation.
      expect(iso(addDays(new Date("2026-03-30T10:00:00.250Z"), -1, "Europe/London"))).toBe(
        "2026-03-29T10:00:00.250Z",
      );
    });

    it("reports the offset at an instant", () => {
      expect(tzOffsetMs(new Date("2026-07-15T10:00:00Z"), "Europe/London")).toBe(HOUR);
      expect(tzOffsetMs(new Date("2026-01-15T10:00:00Z"), "Europe/London")).toBe(0);
      expect(tzOffsetMs(new Date("2026-07-15T10:00:00.123Z"), "America/New_York")).toBe(-4 * HOUR);
    });
  });

  describe("parsing and validation", () => {
    it("rejects malformed or impossible input", () => {
      expect(fromLocalInput("2026-02-30T10:00", "Africa/Cairo")).toBeNull();
      expect(fromLocalInput("2026-01-01T24:00", "Africa/Cairo")).toBeNull();
      expect(fromLocalInput("2026-01-01T10:60", "Africa/Cairo")).toBeNull();
      expect(fromLocalInput("not a date", "Africa/Cairo")).toBeNull();
      expect(fromLocalInput("", "Africa/Cairo")).toBeNull();
      expect(fromDateKey("2026-13-01", "Africa/Cairo")).toBeNull();
      expect(fromDateKey("2026-1-1", "Africa/Cairo")).toBeNull();
    });

    it("parses a date key to local midnight", () => {
      expect(iso(fromDateKey("2026-10-22", "Africa/Cairo"))).toBe("2026-10-21T21:00:00.000Z");
      expect(iso(fromDateKey(" 2026-10-22 ", "UTC"))).toBe("2026-10-22T00:00:00.000Z");
      // Leap day is a real date.
      expect(iso(fromDateKey("2028-02-29", "UTC"))).toBe("2028-02-29T00:00:00.000Z");
    });

    it("validates IANA zone names", () => {
      expect(isValidTimeZone("Africa/Cairo")).toBe(true);
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
      expect(isValidTimeZone("")).toBe(false);
    });

    it("measures minutes between instants", () => {
      expect(minutesBetween(new Date("2026-10-22T09:00:00Z"), new Date("2026-10-22T09:30:00Z"))).toBe(30);
      expect(minutesBetween(new Date("2026-10-22T09:30:00Z"), new Date("2026-10-22T09:00:00Z"))).toBe(-30);
    });
  });
});
