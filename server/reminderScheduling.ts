// ─── Trial reminder scheduling — extracted for testability (maintenance patch) ─
//
// getTimezoneOffsetMs()/computeReminders() used to live inline in
// server/routes.ts, unexported — meaning they could never be unit tested
// without importing the whole routes.ts module (which transitively pulls in
// storage.ts's live DB pool construction, something every existing test file
// in this repo deliberately avoids — see gmail.test.ts's vi.mock("./storage")).
// Moved here verbatim, ONE bug fixed (see below), zero other behavior change:
// same function names, same signatures, same 3/2/1-day offsets, same
// minFutureMs guard. routes.ts now imports both from here instead of
// defining them locally.
//
// THE BUG (found empirically while building Phase 3B.8's parallel
// subscription-reminder code, which duplicated this function and hit the
// same issue): some ICU builds format local midnight as "24" instead of
// "00" even with hour12:false. When refDate's LOCAL hour in the target
// timezone is exactly midnight, Intl.DateTimeFormat.formatToParts() can
// return { type: "hour", value: "24" } — parseInt gives 24, not 0 — which
// then feeds into `(localH - utcH) * 60` and produces a spurious ~24-hour
// timezone offset for that one hour of every day. This silently shifted
// every reminder's remindAt by up to a full day whenever a trial's
// endDate/reminder computation happened to run during that user's local
// midnight hour.

export type ReminderPlan = { remindAt: Date; type: string };

export function getTimezoneOffsetMs(timezone: string, refDate: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(refDate);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "0");

    // The original implementation subtracted local/UTC hour-of-day and
    // minute-of-hour as bare scalars — which silently assumed the local
    // calendar date always equals the UTC calendar date for refDate. That's
    // false for a |offset|-hour window around midnight in ANY non-UTC
    // timezone (once a day, in one direction or the other), so the naive
    // formula was already wrong there even before considering the ICU
    // quirk below — confirmed empirically: it produced -21h instead of the
    // correct +3h for Asia/Qatar exactly at its own local midnight.
    //
    // The ICU quirk found in Phase 3B.8: at exactly local midnight, some
    // ICU builds format hour as "24" instead of "00" — but ICU DOES
    // correctly roll the year/month/day fields forward to the next day
    // already (verified empirically), so the fix is to build a UTC
    // timestamp from ALL the formatted local parts (with hour normalized
    // via %24) and diff it against refDate's own UTC parts — this fixes
    // the midnight quirk AND the day-rollover blindness in one correct
    // calculation. Deliberately still minute-granularity (no seconds
    // fetched/used on either side), matching the original formula's
    // precision exactly — this is a correctness fix for the two bugs
    // above, not a precision upgrade.
    const localAsUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
    const refAsUtcMs = Date.UTC(
      refDate.getUTCFullYear(),
      refDate.getUTCMonth(),
      refDate.getUTCDate(),
      refDate.getUTCHours(),
      refDate.getUTCMinutes()
    );
    return localAsUtcMs - refAsUtcMs;
  } catch {
    return 0;
  }
}

export function computeReminders(endDateStr: string, now: Date, timezone: string): ReminderPlan[] {
  const tzOffsetMs = getTimezoneOffsetMs(timezone, now);
  const endDateTimeUtc = new Date(new Date(endDateStr + "T23:59:59.000Z").getTime() - tzOffsetMs);

  const minFutureMs = 2 * 60 * 1000;
  const offsets = [
    { hoursBeforeEnd: 72, type: "THREE_DAYS" },
    { hoursBeforeEnd: 48, type: "TWO_DAYS" },
    { hoursBeforeEnd: 24, type: "ONE_DAY" },
  ];

  const results: ReminderPlan[] = [];
  for (const offset of offsets) {
    const remindAt = new Date(endDateTimeUtc.getTime() - offset.hoursBeforeEnd * 60 * 60 * 1000);
    if (remindAt.getTime() > now.getTime() + minFutureMs) {
      results.push({ remindAt, type: offset.type as any });
    }
  }

  return results;
}
