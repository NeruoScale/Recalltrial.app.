import { describe, it, expect } from "vitest";
import {
  computeLifecycleTransition,
  applyEventToSubscription,
  isEligibleForReminder,
  computeSubscriptionReminderPlan,
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
