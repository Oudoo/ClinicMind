/**
 * The appointment book's clock rules as pure functions (no database): when a
 * no-show, a check-in, the start and the completion of a consultation are
 * possible, what counts as "in the past" for a booking, the opening hours
 * (Friday closed by default) and the booking form's default start.
 */
import { describe, expect, it } from "vitest";
import {
  availableTransitions,
  CHECK_IN_CLOSES_AFTER_END_MINUTES,
  clinicDayLabel,
  closedDaysLabel,
  describeHours,
  hoursViolation,
  isClosedDay,
  isInThePast,
  nextOpenStart,
  PAST_GRACE_MINUTES,
  transitionTimeBlock,
} from "@/modules/appointments/rules";
import { DEFAULT_WORKING_HOURS, type AppointmentStatus } from "@/modules/appointments/transitions";

const TZ = "Africa/Cairo";
const MIN = 60_000;
// January 2030: Cairo runs on UTC+2 (no daylight saving in winter).
const WED = "2030-01-09";
const THU = "2030-01-10";
const FRI = "2030-01-11";
const SAT = "2030-01-12";
const SUN = "2030-01-13";
const MON = "2030-01-14";
const at = (date: string, time: string) => new Date(`${date}T${time}:00+02:00`);

const appt = (status: AppointmentStatus, date: string, from: string, to: string) => ({ status, startsAt: at(date, from), endsAt: at(date, to) });

describe("transition clock rules", () => {
  it("a visit nine days away offers neither check-in nor no-show (audit #11)", () => {
    const now = at(WED, "11:00");
    const visit = { status: "CONFIRMED" as const, startsAt: new Date(now.getTime() + 9 * 86_400_000), endsAt: new Date(now.getTime() + 9 * 86_400_000 + 30 * MIN) };
    expect(transitionTimeBlock(visit, "CHECKED_IN", now, TZ)).toMatchObject({ code: "not_today" });
    expect(transitionTimeBlock(visit, "NO_SHOW", now, TZ)).toMatchObject({ code: "too_early" });
    expect(availableTransitions(visit, now, TZ)).toEqual(["CANCELLED"]);
    expect(availableTransitions({ ...visit, status: "SCHEDULED" }, now, TZ)).toEqual(["CONFIRMED", "CANCELLED"]);
  });

  it("a no-show only once the start time has passed", () => {
    const a = appt("SCHEDULED", SUN, "14:00", "14:30");
    expect(transitionTimeBlock(a, "NO_SHOW", at(SUN, "13:59"), TZ)).toEqual({
      code: "too_early",
      message: "A no-show can only be marked once the appointment has started (14:00).",
    });
    expect(transitionTimeBlock(a, "NO_SHOW", at(SUN, "14:00"), TZ)).toBeNull();
    expect(transitionTimeBlock(a, "NO_SHOW", at(MON, "09:00"), TZ)).toBeNull();
    // Another day's booking names its day.
    expect(transitionTimeBlock(a, "NO_SHOW", at(SAT, "18:00"), TZ)?.message).toContain("Sun 13 Jan 14:00");
  });

  it("check-in on the appointment's day only, until two hours after it ends", () => {
    const a = appt("CONFIRMED", SUN, "14:00", "14:30");
    expect(transitionTimeBlock(a, "CHECKED_IN", at(SAT, "23:59"), TZ)).toMatchObject({ code: "not_today", message: expect.stringContaining("opens on the day of the appointment (Sun 13 Jan)") });
    // Early arrivals on the day are fine.
    expect(transitionTimeBlock(a, "CHECKED_IN", at(SUN, "00:00"), TZ)).toBeNull();
    expect(transitionTimeBlock(a, "CHECKED_IN", at(SUN, "10:00"), TZ)).toBeNull();
    const closes = new Date(at(SUN, "14:30").getTime() + CHECK_IN_CLOSES_AFTER_END_MINUTES * MIN);
    expect(transitionTimeBlock(a, "CHECKED_IN", closes, TZ)).toBeNull();
    expect(transitionTimeBlock(a, "CHECKED_IN", new Date(closes.getTime() + MIN), TZ)).toMatchObject({ code: "not_today", message: expect.stringContaining("closed two hours after") });
    // A late slot: the window never runs into the next day.
    const late = appt("SCHEDULED", SUN, "19:30", "20:00");
    expect(transitionTimeBlock(late, "CHECKED_IN", at(SUN, "21:59"), TZ)).toBeNull();
    expect(transitionTimeBlock(late, "CHECKED_IN", at(MON, "00:05"), TZ)).toMatchObject({ code: "not_today" });
  });

  it("the day is the clinic's, not the server's", () => {
    // 23:30 on Saturday in Cairo is already Sunday in Tokyo and still Saturday in UTC.
    const a = appt("CONFIRMED", SUN, "10:00", "10:30");
    expect(transitionTimeBlock(a, "CHECKED_IN", at(SAT, "23:30"), TZ)?.code).toBe("not_today");
    expect(transitionTimeBlock(a, "CHECKED_IN", at(SAT, "23:30"), "Asia/Tokyo")).toBeNull();
  });

  it("a consultation does not start on a future day and is not completed before the start", () => {
    const checkedIn = appt("CHECKED_IN", MON, "11:00", "11:30");
    expect(transitionTimeBlock(checkedIn, "IN_PROGRESS", at(SUN, "18:00"), TZ)).toMatchObject({ code: "not_today" });
    // On the day the doctor may start early.
    expect(transitionTimeBlock(checkedIn, "IN_PROGRESS", at(MON, "10:40"), TZ)).toBeNull();
    const inProgress = appt("IN_PROGRESS", MON, "11:00", "11:30");
    expect(transitionTimeBlock(inProgress, "COMPLETED", at(MON, "10:59"), TZ)).toMatchObject({ code: "too_early" });
    expect(transitionTimeBlock(inProgress, "COMPLETED", at(MON, "11:00"), TZ)).toBeNull();
    expect(transitionTimeBlock(inProgress, "COMPLETED", at(MON, "18:00"), TZ)).toBeNull();
  });

  it("a no-show is re-booked into its own slot only while check-in is still open", () => {
    const missed = appt("NO_SHOW", SUN, "12:00", "12:30");
    expect(transitionTimeBlock(missed, "SCHEDULED", at(SUN, "12:40"), TZ)).toBeNull();
    expect(transitionTimeBlock(missed, "SCHEDULED", at(MON, "09:00"), TZ)).toMatchObject({ code: "not_today" });
    // Promoting a waitlisted booking is the service's call (a booking-time rule), not this one's.
    expect(transitionTimeBlock(appt("WAITLISTED", SUN, "12:00", "12:30"), "SCHEDULED", at(MON, "09:00"), TZ)).toBeNull();
  });

  it("confirming and cancelling are never blocked by the clock", () => {
    const a = appt("SCHEDULED", SUN, "12:00", "12:30");
    for (const now of [at(WED, "09:00"), at(SUN, "12:10"), at(MON, "09:00")]) {
      expect(transitionTimeBlock(a, "CONFIRMED", now, TZ)).toBeNull();
      expect(transitionTimeBlock(a, "CANCELLED", now, TZ)).toBeNull();
    }
  });

  it("offers the whole walk on the day, in order", () => {
    const now = at(SUN, "12:05");
    expect(availableTransitions(appt("SCHEDULED", SUN, "12:00", "12:30"), now, TZ)).toEqual(["CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW"]);
    expect(availableTransitions(appt("CONFIRMED", SUN, "12:30", "13:00"), now, TZ)).toEqual(["CHECKED_IN", "CANCELLED"]);
    expect(availableTransitions(appt("CHECKED_IN", SUN, "12:00", "12:30"), now, TZ)).toEqual(["IN_PROGRESS", "CANCELLED"]);
    expect(availableTransitions(appt("IN_PROGRESS", SUN, "12:00", "12:30"), now, TZ)).toEqual(["COMPLETED"]);
  });
});

describe("booking clock rules", () => {
  it("a booking may start up to 15 minutes before now", () => {
    const now = at(SUN, "12:00");
    expect(PAST_GRACE_MINUTES).toBe(15);
    expect(isInThePast(new Date(now.getTime() - 15 * MIN), now)).toBe(false);
    expect(isInThePast(new Date(now.getTime() - 15 * MIN - 1), now)).toBe(true);
    expect(isInThePast(new Date(now.getTime() + 60 * MIN), now)).toBe(false);
    // The audit's case: a week ago at 03:00.
    expect(isInThePast(at("2030-01-06", "03:00"), now)).toBe(true);
  });

  it("opening hours: Saturday to Thursday 10:00–20:00 by default, Friday closed", () => {
    const h = DEFAULT_WORKING_HOURS;
    expect(hoursViolation(at(SUN, "10:00"), at(SUN, "10:30"), h, TZ)).toBeNull();
    expect(hoursViolation(at(SUN, "19:30"), at(SUN, "20:00"), h, TZ)).toBeNull();
    expect(hoursViolation(at(SUN, "09:45"), at(SUN, "10:15"), h, TZ)).toMatchObject({ reason: "outside_span" });
    expect(hoursViolation(at(SUN, "19:45"), at(SUN, "20:15"), h, TZ)).toMatchObject({ reason: "outside_span" });
    expect(hoursViolation(at("2030-01-06", "03:00"), at("2030-01-06", "03:30"), h, TZ)).toEqual({
      reason: "outside_span",
      message: "That time is outside the opening hours (Sat–Thu 10:00–20:00).",
    });
    expect(hoursViolation(at(FRI, "11:00"), at(FRI, "11:30"), h, TZ)).toEqual({
      reason: "closed_day",
      message: "The clinic is closed on Fridays. Opening hours: Sat–Thu 10:00–20:00.",
    });
    // Across midnight is never inside the hours.
    expect(hoursViolation(at(SUN, "19:30"), at(MON, "10:30"), h, TZ)).toMatchObject({ reason: "outside_span" });
  });

  it("follows the tenant's own hours, up to midnight", () => {
    const fridayMornings = { days: [5], start: "09:00", end: "11:00" };
    expect(hoursViolation(at(FRI, "09:00"), at(FRI, "09:30"), fridayMornings, TZ)).toBeNull();
    expect(hoursViolation(at(SAT, "09:00"), at(SAT, "09:30"), fridayMornings, TZ)).toMatchObject({ reason: "closed_day" });
    const lateNight = { days: [0], start: "18:00", end: "23:59" };
    expect(hoursViolation(at(SUN, "23:00"), at(SUN, "23:30"), lateNight, TZ)).toBeNull();
    expect(hoursViolation(at(SUN, "23:30"), at(MON, "00:00"), lateNight, TZ)).toMatchObject({ reason: "outside_span" });
    expect(isClosedDay(at(FRI, "12:00"), DEFAULT_WORKING_HOURS, TZ)).toBe(true);
    expect(isClosedDay(at(SAT, "12:00"), DEFAULT_WORKING_HOURS, TZ)).toBe(false);
  });

  it("the booking form opens on the next start inside the opening hours", () => {
    const h = DEFAULT_WORKING_HOURS;
    const next = (from: Date, duration = 30) => nextOpenStart(from, h, TZ, duration)?.toISOString();
    expect(next(at(SUN, "08:00"))).toBe(at(SUN, "10:00").toISOString());
    expect(next(at(SUN, "10:07"))).toBe(at(SUN, "10:15").toISOString());
    expect(next(at(SUN, "19:30"))).toBe(at(SUN, "19:30").toISOString());
    expect(next(at(SUN, "19:31"))).toBe(at(MON, "10:00").toISOString());
    expect(next(at(SUN, "19:15"), 60)).toBe(at(MON, "10:00").toISOString());
    // Thursday evening skips the closed Friday.
    expect(next(at(THU, "21:39"))).toBe(at(SAT, "10:00").toISOString());
    expect(next(at(FRI, "09:00"))).toBe(at(SAT, "10:00").toISOString());
    expect(nextOpenStart(at(SUN, "08:00"), { days: [], start: "10:00", end: "20:00" }, TZ)).toBeNull();
  });

  it("words the hours and the closed days the way the hints show them", () => {
    expect(describeHours(DEFAULT_WORKING_HOURS)).toBe("Sat–Thu 10:00–20:00");
    expect(closedDaysLabel(DEFAULT_WORKING_HOURS)).toBe("Friday closed");
    expect(closedDaysLabel({ days: [6, 0, 1, 2, 3], start: "10:00", end: "20:00" })).toBe("Friday and Thursday closed");
    expect(closedDaysLabel({ days: [0, 1, 2, 3, 4, 5, 6], start: "10:00", end: "20:00" })).toBe("");
    expect(describeHours({ days: [0, 2, 4], start: "09:00", end: "13:00" })).toBe("Sun, Tue, Thu 09:00–13:00");
    expect(clinicDayLabel(at(THU, "12:00"), TZ)).toBe("Thu 10 Jan");
  });
});
