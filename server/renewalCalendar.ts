// ─── Renewal calendar — pure, deterministic (Phase 3B.9.4) ─────────────────────
//
// Same separation-of-concerns pattern as the rest of this feature line: no
// DB access, operates strictly on `subscriptions` rows already passed in by
// the caller (server/routes.ts), never on raw subscription_events. Turns
// nextBillingDate into a forward-looking calendar WITHOUT ever inventing a
// date or an amount — a subscription with no known date goes in
// unknownDateSubscriptions, never a guessed slot on the calendar; a
// subscription with no known amount still appears (amountKnown=false),
// never silently as $0.
//
// STRICT BOUNDARY this module respects: it is driven entirely by the
// SINGLE stored nextBillingDate value, never by projecting future
// occurrences from billingInterval (no "if monthly, also show Sep 19, Oct
// 19, ...") — this is a calendar of what's actually known, not a simulation
// of what might repeat.

import type { ShadowSubscription } from "@shared/schema";
import { getTimezoneOffsetMs } from "./reminderScheduling";
import { parseAmountToCents, centsToDollars } from "./subscriptionCostEngine";

export type RenewalCalendarEntry = {
  subscriptionId: string;
  merchant: string;
  dueDate: string;
  amount: string | null;
  currency: string | null;
  status: ShadowSubscription["subscriptionStatus"];
  billingInterval: string | null;
  billingIntervalSource: string | null;
  amountKnown: boolean;
  intervalKnown: boolean;
  isPastDue: boolean;
};

export type UnknownDateSubscription = {
  subscriptionId: string;
  merchant: string;
  amount: string | null;
  currency: string | null;
  status: ShadowSubscription["subscriptionStatus"];
  billingInterval: string | null;
};

export type RenewalCalendarResult = {
  upcomingRenewals: RenewalCalendarEntry[];
  unknownDateSubscriptions: UnknownDateSubscription[];
  upcomingSummary: {
    windowDays: number;
    byCurrency: Record<string, number>;
    knownChargeCount: number;
    unknownAmountCount: number;
  };
};

const RENEWAL_ELIGIBLE_STATUSES = new Set(["active", "trial", "past_due"]);

// ── Timezone-aware "local calendar day" helpers ──────────────────────────────
//
// nextBillingDate is a bare YYYY-MM-DD value with no time component, so the
// question this calendar actually needs answered is "which calendar day is
// it right now, from this user's perspective" — reusing
// getTimezoneOffsetMs() (server/reminderScheduling.ts, the ICU-midnight-bug
// fix from the maintenance patch) rather than reimplementing timezone math,
// per this phase's explicit instruction. Once "today" is a plain date
// string, comparing it against nextBillingDate is just string/calendar
// arithmetic — no further timezone reasoning needed.

function getLocalTodayDateStr(now: Date, timezone: string): string {
  const offsetMs = getTimezoneOffsetMs(timezone, now);
  const local = new Date(now.getTime() + offsetMs);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * calculateRenewalCalendar(): subscriptions[] must already be scoped to one
 * user by the caller (no userId parameter — same convention as
 * calculateUpcomingCharges() in subscriptionCostEngine.ts). `now` defaults
 * to the real current time; exposed as an optional param purely for
 * deterministic tests.
 *
 * isPastDue reflects the subscription's LIFECYCLE STATUS
 * (subscriptionStatus === "past_due"), not the date itself — a past_due
 * subscription's nextBillingDate is very often still in the FUTURE (the
 * next attempt/renewal date; confirmed against real production data: an
 * Anthropic subscription sits at status=past_due with nextBillingDate
 * several weeks out) and STEP 3's own dashboard example shows exactly that
 * shape ("Sep 15  Anthropic  ...  Past due"), so isPastDue answers "does
 * this need attention," which is a status question, not a date question.
 * A nextBillingDate that is ITSELF in the past is a separate, stricter
 * case — handled below by simply not including that entry in
 * upcomingRenewals at all ("never present a past date as an upcoming
 * charge" — the DATE rule, distinct from the STATUS rule above).
 */
export function calculateRenewalCalendar(
  subscriptions: ShadowSubscription[],
  windowDays: 30 | 90,
  userTimezone: string,
  now: Date = new Date()
): RenewalCalendarResult {
  const todayLocalStr = getLocalTodayDateStr(now, userTimezone);
  const windowEndStr = addDaysToDateStr(todayLocalStr, windowDays);

  const upcomingRenewals: RenewalCalendarEntry[] = [];
  const unknownDateSubscriptions: UnknownDateSubscription[] = [];
  const byCurrencyCents: Record<string, number> = {};
  let knownChargeCount = 0;
  let unknownAmountCount = 0;

  for (const sub of subscriptions) {
    if (!RENEWAL_ELIGIBLE_STATUSES.has(sub.subscriptionStatus)) continue;

    if (!sub.nextBillingDate) {
      unknownDateSubscriptions.push({
        subscriptionId: sub.id,
        merchant: sub.canonicalMerchantName,
        amount: sub.amount,
        currency: sub.currency,
        status: sub.subscriptionStatus,
        billingInterval: sub.billingInterval,
      });
      continue;
    }

    // A genuinely overdue date (already in the past) is never presented as
    // an upcoming charge — the DATE rule, independent of status.
    if (sub.nextBillingDate < todayLocalStr) continue;
    // Beyond the requested window — not this view's concern (30 vs 90).
    if (sub.nextBillingDate > windowEndStr) continue;

    const amountKnown = sub.amount !== null;
    const intervalKnown = sub.billingInterval !== null;

    upcomingRenewals.push({
      subscriptionId: sub.id,
      merchant: sub.canonicalMerchantName,
      dueDate: sub.nextBillingDate,
      amount: sub.amount,
      currency: sub.currency,
      status: sub.subscriptionStatus,
      billingInterval: sub.billingInterval,
      billingIntervalSource: sub.billingIntervalSource,
      amountKnown,
      intervalKnown,
      isPastDue: sub.subscriptionStatus === "past_due",
    });

    if (amountKnown) {
      knownChargeCount++;
      if (sub.currency) {
        const cents = parseAmountToCents(sub.amount);
        if (cents !== null) {
          byCurrencyCents[sub.currency] = (byCurrencyCents[sub.currency] || 0) + cents;
        }
      }
    } else {
      unknownAmountCount++;
    }
  }

  upcomingRenewals.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  const byCurrency: Record<string, number> = {};
  for (const [currency, cents] of Object.entries(byCurrencyCents)) {
    byCurrency[currency] = centsToDollars(cents);
  }

  return {
    upcomingRenewals,
    unknownDateSubscriptions,
    upcomingSummary: { windowDays, byCurrency, knownChargeCount, unknownAmountCount },
  };
}
