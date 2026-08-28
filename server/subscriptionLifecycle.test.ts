import { describe, it, expect } from "vitest";
import {
  computeLifecycleTransition,
  applyEventToSubscription,
  isEligibleForReminder,
  computeSubscriptionReminderPlan,
  evaluateReminderEligibility,
  type LifecycleState,
  type LifecycleRelevantEvent,
} from "./subscriptionLifecycle";
import type { ShadowSubscription } from "@shared/schema";

function makeSubscription(overrides: Partial<ShadowSubscription> = {}): ShadowSubscription {
  return {
    id: "sub-1",
    userId: "user-1",
    entityKey: "anthropic.com",
    canonicalMerchantName: "Anthropic",
    canonicalMerchantDomain: "anthropic.com",
    merchantConfidence: 90,
    resolutionMethod: "domain_match",
    resolutionStatus: "resolved",
    planName: null,
    subscriptionStatus: "active",
    amount: null,
    currency: null,
    billingInterval: null,
    nextBillingDate: null,
    lastBillingDate: null,
    sourceCanonicalEventId: "evt-1",
    isShadow: false,
    potentialFalseMerge: false,
    potentialFalseSplit: false,
    promotedAt: new Date("2026-08-19T00:00:00.000Z"),
    promotionReason: "domain_match_controlled_activation",
    promotionEvidence: "resolutionMethod=domain_match, merchantConfidence=90",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  } as ShadowSubscription;
}

function makeEvent(overrides: Partial<LifecycleRelevantEvent> = {}): LifecycleRelevantEvent {
  return {
    eventType: "subscription_invoice",
    extractedPrice: null,
    extractedCurrency: null,
    extractedDate: null,
    userId: "user-1",
    canonicalMerchantDomain: "anthropic.com",
    ...overrides,
  } as LifecycleRelevantEvent;
}

describe("Phase 3B.8: computeLifecycleTransition — the transition table", () => {
  it("payment_failed: active becomes past_due", () => {
    const t = computeLifecycleTransition("active", "payment_failed");
    expect(t).toEqual({ kind: "state_change", from: "active", to: "past_due", reason: "payment_failed event" });
  });

  it("payment_failed: past_due stays past_due (no double transition)", () => {
    const t = computeLifecycleTransition("past_due", "payment_failed");
    expect(t.kind).toBe("no_op");
  });

  it("subscription_renewed: past_due becomes active", () => {
    const t = computeLifecycleTransition("past_due", "subscription_renewed");
    expect(t).toEqual({ kind: "state_change", from: "past_due", to: "active", reason: "subscription_renewed event" });
  });

  it("subscription_invoice: state unchanged (data_update only)", () => {
    const t = computeLifecycleTransition("active", "subscription_invoice");
    expect(t.kind).toBe("data_update");
  });

  it("trial_started: creates trial state from unknown", () => {
    const t = computeLifecycleTransition("unknown", "trial_started");
    expect(t).toEqual({ kind: "state_change", from: "unknown", to: "trial", reason: "trial_started event" });
  });

  it("trial_ending: stays trial, date-only update", () => {
    const t = computeLifecycleTransition("trial", "trial_ending");
    expect(t.kind).toBe("data_update");
  });

  it("cancellation_confirmed: active becomes cancelled (canceled)", () => {
    const t = computeLifecycleTransition("active", "cancellation_confirmed");
    expect(t).toEqual({ kind: "state_change", from: "active", to: "canceled", reason: "cancellation_confirmed event" });
  });

  it("subscription_cancelled: past_due becomes cancelled (canceled)", () => {
    const t = computeLifecycleTransition("past_due", "subscription_cancelled");
    expect(t).toEqual({ kind: "state_change", from: "past_due", to: "canceled", reason: "subscription_cancelled event" });
  });

  it("price_changed: amount-only update, no state change", () => {
    const t = computeLifecycleTransition("active", "price_changed");
    expect(t.kind).toBe("data_update");
  });

  it("canceled cannot transition to active via ANY event", () => {
    for (const eventType of ["subscription_renewed", "payment_failed", "subscription_invoice", "trial_started", "price_changed"]) {
      const t = computeLifecycleTransition("canceled", eventType);
      if (t.kind === "state_change") {
        expect(t.to).not.toBe("active");
      } else {
        expect(t.kind).not.toBe("state_change");
      }
    }
  });

  it("expired cannot transition to active via ANY event", () => {
    for (const eventType of ["subscription_renewed", "payment_failed", "subscription_invoice", "trial_started", "price_changed"]) {
      const t = computeLifecycleTransition("expired", eventType);
      if (t.kind === "state_change") {
        expect(t.to).not.toBe("active");
      }
    }
  });

  it("one_time_purchase: never causes a state transition, from any state", () => {
    const states: LifecycleState[] = ["trial", "active", "past_due", "canceled", "expired", "unknown"];
    for (const state of states) {
      const t = computeLifecycleTransition(state, "one_time_purchase");
      expect(t.kind).toBe("no_op");
    }
  });

  it("unknown/unrecognized event type: no destructive transition, from any state", () => {
    const states: LifecycleState[] = ["trial", "active", "past_due", "canceled", "expired", "unknown"];
    for (const state of states) {
      const t = computeLifecycleTransition(state, "invoice_received"); // legacy, not in the recognized set
      expect(t.kind).toBe("no_op");
    }
  });

  it("unknown_subscription_event: never causes a destructive transition", () => {
    const t = computeLifecycleTransition("active", "unknown_subscription_event");
    expect(t.kind).toBe("no_op");
  });

  it("cancellation_requested (a request, not confirmation) is NOT a recognized lifecycle event", () => {
    const t = computeLifecycleTransition("active", "cancellation_requested");
    expect(t.kind).toBe("no_op");
  });

  it("applying the same event twice (re-fetching current state between calls) is idempotent — second call no-ops", () => {
    const first = computeLifecycleTransition("active", "payment_failed");
    expect(first.kind).toBe("state_change");
    const stateAfterFirst = first.kind === "state_change" ? first.to : "active";
    const second = computeLifecycleTransition(stateAfterFirst, "payment_failed");
    expect(second.kind).toBe("no_op");
  });
});

describe("Phase 3B.8: applyEventToSubscription", () => {
  it("payment_failed on an active subscription flips status to past_due", () => {
    const sub = makeSubscription({ subscriptionStatus: "active" });
    const result = applyEventToSubscription(makeEvent({ eventType: "payment_failed" }), sub);
    expect(result.transition.kind).toBe("state_change");
    expect(result.fields.subscriptionStatus).toBe("past_due");
    // payment_failed never carries trustworthy new billing data
    expect(result.fields.amount).toBeUndefined();
  });

  it("subscription_invoice refreshes billing fields without changing state", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", amount: "10.00" });
    const result = applyEventToSubscription(
      makeEvent({ eventType: "subscription_invoice", extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-09-01" }),
      sub
    );
    expect(result.transition.kind).toBe("data_update");
    expect(result.fields.subscriptionStatus).toBeUndefined();
    expect(result.fields.amount).toBe("20.00");
    expect(result.fields.currency).toBe("USD");
    expect(result.fields.nextBillingDate).toBe("2026-09-01");
  });

  it("one_time_purchase never updates the subscription at all", () => {
    const sub = makeSubscription({ subscriptionStatus: "active" });
    const result = applyEventToSubscription(makeEvent({ eventType: "one_time_purchase" }), sub);
    expect(result.transition.kind).toBe("no_op");
    expect(result.fields).toEqual({});
  });

  it("same event applied twice against the resulting state each time is idempotent", () => {
    const sub1 = makeSubscription({ subscriptionStatus: "active" });
    const r1 = applyEventToSubscription(makeEvent({ eventType: "payment_failed" }), sub1);
    expect(r1.fields.subscriptionStatus).toBe("past_due");

    const sub2 = makeSubscription({ subscriptionStatus: r1.fields.subscriptionStatus! });
    const r2 = applyEventToSubscription(makeEvent({ eventType: "payment_failed" }), sub2);
    expect(r2.transition.kind).toBe("no_op");
    expect(r2.fields.subscriptionStatus).toBeUndefined();
  });
});

describe("Phase 3B.8 Step 5: reminder eligibility", () => {
  it("active subscription with a known nextBillingDate is eligible", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2027-08-01" });
    expect(isEligibleForReminder(sub)).toBe(true);
  });

  it("trial subscription with a known date is eligible", () => {
    const sub = makeSubscription({ subscriptionStatus: "trial", nextBillingDate: "2026-09-01" });
    expect(isEligibleForReminder(sub)).toBe(true);
  });

  it("past_due subscription is NOT eligible for a reminder", () => {
    const sub = makeSubscription({ subscriptionStatus: "past_due", nextBillingDate: "2027-08-01" });
    expect(isEligibleForReminder(sub)).toBe(false);
  });

  it("cancelled subscription is NOT eligible for a reminder", () => {
    const sub = makeSubscription({ subscriptionStatus: "canceled", nextBillingDate: "2027-08-01" });
    expect(isEligibleForReminder(sub)).toBe(false);
  });

  it("expired subscription is NOT eligible for a reminder", () => {
    const sub = makeSubscription({ subscriptionStatus: "expired", nextBillingDate: "2027-08-01" });
    expect(isEligibleForReminder(sub)).toBe(false);
  });

  it("active subscription with NO known date is NOT eligible", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: null });
    expect(isEligibleForReminder(sub)).toBe(false);
  });

  it("non-resolved resolutionStatus is NOT eligible even if status/date look fine", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2027-08-01", resolutionStatus: "ambiguous" });
    expect(isEligibleForReminder(sub)).toBe(false);
  });
});

describe("Phase 3B.8 Step 5: computeSubscriptionReminderPlan — 3/2/1-day math", () => {
  it("a date far enough in the future produces exactly 3 reminders (3, 2, 1 day before)", () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const plans = computeSubscriptionReminderPlan("2027-08-01", now, "UTC");
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.type)).toEqual(["THREE_DAYS", "TWO_DAYS", "ONE_DAY"]);
  });

  it("a date only 1 day away produces just the ONE_DAY reminder (the others would be in the past)", () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const plans = computeSubscriptionReminderPlan("2026-08-20", now, "UTC");
    expect(plans.map((p) => p.type)).toEqual(["ONE_DAY"]);
  });

  it("calling it twice with identical inputs is deterministic/idempotent (same plans both times)", () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    const a = computeSubscriptionReminderPlan("2027-08-01", now, "UTC");
    const b = computeSubscriptionReminderPlan("2027-08-01", now, "UTC");
    expect(a.map((p) => ({ type: p.type, at: p.remindAt.getTime() }))).toEqual(
      b.map((p) => ({ type: p.type, at: p.remindAt.getTime() }))
    );
  });
});

describe("Phase 4.1: evaluateReminderEligibility — explicit eligibility + reason", () => {
  const now = new Date("2026-08-19T00:00:00.000Z");

  it("Eligibility 1: a valid future renewal date is eligible and returns the real plans", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2027-08-01" });
    const result = evaluateReminderEligibility(sub, now, "UTC");
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.targetDate).toBe("2027-08-01");
      expect(result.plans.map((p) => p.type)).toEqual(["THREE_DAYS", "TWO_DAYS", "ONE_DAY"]);
    }
  });

  it("Eligibility 2: a missing nextBillingDate is ineligible with an explicit reason", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: null });
    const result = evaluateReminderEligibility(sub, now, "UTC");
    expect(result).toEqual({ eligible: false, reason: "nextBillingDate is missing" });
  });

  it("Eligibility 3: an unparseable nextBillingDate is ineligible with an explicit reason, never silently treated as 'not due yet'", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "not-a-real-date" });
    const result = evaluateReminderEligibility(sub, now, "UTC");
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toContain("could not be parsed");
    }
  });

  it("Eligibility 4: a renewal date that has already fully elapsed produces no ordinary reminder, with an explicit reason", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2026-01-01" });
    const result = evaluateReminderEligibility(sub, now, "UTC");
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toContain("already passed");
    }
  });

  it("past_due/cancelled/expired remain ineligible via the same lifecycle-state check isEligibleForReminder already enforced", () => {
    for (const status of ["past_due", "canceled", "expired"] as const) {
      const sub = makeSubscription({ subscriptionStatus: status, nextBillingDate: "2027-08-01" });
      const result = evaluateReminderEligibility(sub, now, "UTC");
      expect(result.eligible).toBe(false);
    }
  });

  it("User state 16: a user-dismissed subscription is ineligible even with an otherwise perfectly valid future date", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2027-08-01", userDismissed: true });
    const result = evaluateReminderEligibility(sub, now, "UTC");
    expect(result).toEqual({ eligible: false, reason: "subscription is user-dismissed" });
  });

  it("User state 15: userConfirmed has no bearing on eligibility either way -- both an unconfirmed and a confirmed subscription with the same valid date are equally eligible", () => {
    const unconfirmed = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2027-08-01", userConfirmed: false });
    const confirmed = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2027-08-01", userConfirmed: true });
    const a = evaluateReminderEligibility(unconfirmed, now, "UTC");
    const b = evaluateReminderEligibility(confirmed, now, "UTC");
    expect(a.eligible).toBe(true);
    expect(b.eligible).toBe(true);
  });

  describe("Time boundaries 19-23: exact offset windows", () => {
    it("Boundary 19: renewal exactly 3 days away produces all three offsets", () => {
      const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2026-08-22" });
      const result = evaluateReminderEligibility(sub, now, "UTC");
      expect(result.eligible).toBe(true);
      if (result.eligible) expect(result.plans.map((p) => p.type)).toEqual(["THREE_DAYS", "TWO_DAYS", "ONE_DAY"]);
    });

    it("Boundary 20: renewal exactly 2 days away produces TWO_DAYS and ONE_DAY only (THREE_DAYS would already be in the past)", () => {
      const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2026-08-21" });
      const result = evaluateReminderEligibility(sub, now, "UTC");
      expect(result.eligible).toBe(true);
      if (result.eligible) expect(result.plans.map((p) => p.type)).toEqual(["TWO_DAYS", "ONE_DAY"]);
    });

    it("Boundary 21: renewal exactly 1 day away produces ONE_DAY only", () => {
      const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2026-08-20" });
      const result = evaluateReminderEligibility(sub, now, "UTC");
      expect(result.eligible).toBe(true);
      if (result.eligible) expect(result.plans.map((p) => p.type)).toEqual(["ONE_DAY"]);
    });

    it("Boundary 22: renewal less than 1 day away produces zero offsets but is still 'eligible' (not yet due, not passed)", () => {
      const almostNow = new Date("2026-08-19T23:58:00.000Z"); // renewal end-of-day is 2026-08-19T23:59:59Z, ~2 min away
      const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2026-08-19" });
      const result = evaluateReminderEligibility(sub, almostNow, "UTC");
      // minFutureMs (2 minutes) guard means even ONE_DAY has already elapsed
      // its own remindAt point -- but the renewal itself is still technically
      // in the future by 1-2 minutes, so this is "no plans yet", not "passed".
      expect(result.eligible).toBe(true);
      if (result.eligible) expect(result.plans).toHaveLength(0);
    });

    it("Boundary 23: a renewal far beyond the 3-day window is still eligible with all three offsets scheduled ahead of time -- this system pre-schedules reminders, it does not wait until the window opens to create the rows", () => {
      const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2026-09-30" });
      const result = evaluateReminderEligibility(sub, now, "UTC");
      expect(result.eligible).toBe(true);
      if (result.eligible) expect(result.plans.map((p) => p.type)).toEqual(["THREE_DAYS", "TWO_DAYS", "ONE_DAY"]);
    });
  });

  it("Idempotency: calling evaluateReminderEligibility twice with identical inputs is fully deterministic", () => {
    const sub = makeSubscription({ subscriptionStatus: "active", nextBillingDate: "2026-08-22" });
    const a = evaluateReminderEligibility(sub, now, "UTC");
    const b = evaluateReminderEligibility(sub, now, "UTC");
    expect(a).toEqual(b);
  });
});

describe("Phase 3B.9.2A Step 3: billingInterval propagation", () => {
  it("null -> value: fills the gap when the subscription has no known interval yet", () => {
    const sub = makeSubscription({ billingInterval: null });
    const result = applyEventToSubscription(makeEvent({ eventType: "subscription_invoice", billingInterval: "monthly" }), sub);
    expect(result.fields.billingInterval).toBe("monthly");
    expect(result.billingIntervalChange).toEqual({ from: null, to: "monthly" });
  });

  it("value -> different value: updates to the most recent canonical event's value and reports the change", () => {
    const sub = makeSubscription({ billingInterval: "monthly" });
    const result = applyEventToSubscription(makeEvent({ eventType: "subscription_invoice", billingInterval: "annual" }), sub);
    expect(result.fields.billingInterval).toBe("annual");
    expect(result.billingIntervalChange).toEqual({ from: "monthly", to: "annual" });
  });

  it("value -> same value: no change reported (already correct)", () => {
    const sub = makeSubscription({ billingInterval: "monthly" });
    const result = applyEventToSubscription(makeEvent({ eventType: "subscription_invoice", billingInterval: "monthly" }), sub);
    expect(result.fields.billingInterval).toBeUndefined();
    expect(result.billingIntervalChange).toBeNull();
  });

  it("event carries no interval evidence (null) -> a known interval is NEVER overwritten with null", () => {
    const sub = makeSubscription({ billingInterval: "annual" });
    const result = applyEventToSubscription(makeEvent({ eventType: "subscription_invoice", billingInterval: null }), sub);
    expect(result.fields.billingInterval).toBeUndefined();
    expect(result.billingIntervalChange).toBeNull();
  });

  it("propagation is unconditional: happens even for a no_op state transition (e.g. payment_failed on an already past_due subscription)", () => {
    const sub = makeSubscription({ subscriptionStatus: "past_due", billingInterval: null });
    const result = applyEventToSubscription(makeEvent({ eventType: "payment_failed", billingInterval: "monthly" }), sub);
    expect(result.transition.kind).toBe("no_op"); // payment_failed only transitions from active
    expect(result.fields.billingInterval).toBe("monthly"); // but the interval still propagates
  });
});
