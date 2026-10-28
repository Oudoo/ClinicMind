import { describe, expect, it } from "vitest";
import { ageFrom, formatCalendarDate } from "@/lib/utils";

describe("formatCalendarDate", () => {
  it("shows a date of birth on the same day whatever the time zone", () => {
    const dob = new Date("1990-03-27T00:00:00.000Z");
    expect(formatCalendarDate(dob)).toBe("27 Mar 1990");
    expect(formatCalendarDate("1990-03-27")).toBe("27 Mar 1990");
  });
});

describe("ageFrom", () => {
  const now = new Date("2026-10-28T10:00:00.000Z");
  it("counts completed years on the calendar", () => {
    expect(ageFrom(new Date("1990-10-28T00:00:00.000Z"), now)).toBe(36); // birthday today
    expect(ageFrom(new Date("1990-10-29T00:00:00.000Z"), now)).toBe(35); // tomorrow
    expect(ageFrom(new Date("2000-02-29T00:00:00.000Z"), now)).toBe(26);
    expect(ageFrom("2026-01-01", now)).toBe(0);
  });

  it("never returns a negative or invalid age", () => {
    expect(ageFrom(new Date("2099-01-01T00:00:00.000Z"), now)).toBeNull();
    expect(ageFrom("not a date", now)).toBeNull();
    expect(ageFrom(null, now)).toBeNull();
  });
});
