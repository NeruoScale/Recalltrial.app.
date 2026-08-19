import { describe, it, expect } from "vitest";
import { getTimezoneOffsetMs, computeReminders } from "./reminderScheduling";

describe("maintenance patch: ICU midnight-formatting bug in getTimezoneOffsetMs()", () => {
  it("UTC, now exactly at local midnight -> offset is 0, not a spurious ~24h shift", () => {
    // This is the exact bug scenario: refDate's LOCAL hour in the target
    // timezone is 0, which some ICU builds format as "24" instead of "00".
    const midnightUtc = new Date("2026-08-19T00:00:00.000Z");
    expect(getTimezoneOffsetMs("UTC", midnightUtc)).toBe(0);
  });

  it("UTC+ timezone (Asia/Qatar, UTC+3), refDate at the instant local time is exactly midnight", () => {
    // 21:00 UTC on the 18th = 00:00 the next day in Qatar (UTC+3).
    const refDate = new Date("2026-08-18T21:00:00.000Z");
    expect(getTimezoneOffsetMs("Asia/Qatar", refDate)).toBe(3 * 60 * 60 * 1000);
  });

  it("UTC- timezone (America/Los_Angeles), refDate at the instant local time is exactly midnight", () => {
    // Aug 19 is PDT (UTC-7): 07:00 UTC = 00:00 local.
    const refDate = new Date("2026-08-19T07:00:00.000Z");
    expect(getTimezoneOffsetMs("America/Los_Angeles", refDate)).toBe(-7 * 60 * 60 * 1000);
  });

  it("date one day before the UTC day boundary: local midnight in a UTC+ zone still resolves correctly", () => {
    // 21:00 UTC on Dec 31 = 00:00 Jan 1 in Qatar — crosses a year boundary too.
    const refDate = new Date("2026-12-31T21:00:00.000Z");
    expect(getTimezoneOffsetMs("Asia/Qatar", refDate)).toBe(3 * 60 * 60 * 1000);
  });

  it("date one day after the UTC day boundary: 1 second past local midnight is NOT hit by the bug (sanity check)", () => {
    const refDate = new Date("2026-08-18T21:00:01.000Z"); // one second after Qatar midnight
    expect(getTimezoneOffsetMs("Asia/Qatar", refDate)).toBe(3 * 60 * 60 * 1000);
  });

  it("DST boundary (America/New_York spring-forward, March 8 2026): offset shifts from -5h to -4h, no crash, no bug", () => {
    const beforeSpringForward = new Date("2026-03-08T06:59:00.000Z"); // 01:59 EST
    const afterSpringForward = new Date("2026-03-08T07:01:00.000Z"); // 03:01 EDT (2am is skipped)
    expect(getTimezoneOffsetMs("America/New_York", beforeSpringForward)).toBe(-5 * 60 * 60 * 1000);
    expect(getTimezoneOffsetMs("America/New_York", afterSpringForward)).toBe(-4 * 60 * 60 * 1000);
  });

  it("DST boundary (America/New_York fall-back, Nov 1 2026): offset shifts from -4h to -5h, no crash, no bug", () => {
    const beforeFallBack = new Date("2026-11-01T04:00:00.000Z"); // 00:00 EDT (local midnight — the bug's exact trigger condition, during a DST-transition day)
    const wellAfterFallBack = new Date("2026-11-01T08:00:00.000Z"); // 03:00 EST
    expect(getTimezoneOffsetMs("America/New_York", beforeFallBack)).toBe(-4 * 60 * 60 * 1000);
    expect(getTimezoneOffsetMs("America/New_York", wellAfterFallBack)).toBe(-5 * 60 * 60 * 1000);
  });
});

describe("maintenance patch: computeReminders() unaffected in logic/behavior — still 3/2/1-day offsets", () => {
  it("a normal case still produces exactly 3 reminders (3, 2, 1 day before), unchanged", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const plans = computeReminders("2026-08-10", now, "UTC");
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.type)).toEqual(["THREE_DAYS", "TWO_DAYS", "ONE_DAY"]);
  });

  it("now exactly at local midnight in a UTC+ zone no longer shifts reminders by a spurious day", () => {
    const now = new Date("2026-08-18T21:00:00.000Z"); // exactly midnight in Asia/Qatar
    const plans = computeReminders("2026-08-25", now, "Asia/Qatar");
    expect(plans).toHaveLength(3);
    // Qatar end-of-day for 2026-08-25 is 2026-08-25T20:59:59.000Z in UTC
    // (23:59:59 local minus the +3h offset). ONE_DAY = 24h before that.
    const expectedOneDay = new Date("2026-08-24T20:59:59.000Z");
    const oneDayPlan = plans.find((p) => p.type === "ONE_DAY")!;
    expect(oneDayPlan.remindAt.getTime()).toBe(expectedOneDay.getTime());
  });

  it("now exactly at local midnight in a UTC- zone no longer shifts reminders by a spurious day", () => {
    const now = new Date("2026-08-19T07:00:00.000Z"); // exactly midnight in America/Los_Angeles
    const plans = computeReminders("2026-08-26", now, "America/Los_Angeles");
    expect(plans).toHaveLength(3);
    // LA end-of-day for 2026-08-26 is 2026-08-27T06:59:59.000Z in UTC
    // (23:59:59 local minus the -7h offset).
    const expectedThreeDay = new Date("2026-08-24T06:59:59.000Z");
    const threeDayPlan = plans.find((p) => p.type === "THREE_DAYS")!;
    expect(threeDayPlan.remindAt.getTime()).toBe(expectedThreeDay.getTime());
  });

  it("end date crossing a year boundary (Jan 1) still produces correct, non-shifted reminders", () => {
    const now = new Date("2026-12-29T00:00:00.000Z");
    const plans = computeReminders("2027-01-01", now, "UTC");
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.remindAt.toISOString().slice(0, 10))).toEqual(["2026-12-29", "2026-12-30", "2026-12-31"]);
  });

  it("DST transition day (America/New_York, Nov 1 2026 fall-back): reminder computation runs cleanly with no thrown error and correct 3/2/1-day count", () => {
    const now = new Date("2026-11-01T04:00:00.000Z"); // local midnight, the DST transition day
    const plans = computeReminders("2026-11-10", now, "America/New_York");
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.type)).toEqual(["THREE_DAYS", "TWO_DAYS", "ONE_DAY"]);
  });
});
