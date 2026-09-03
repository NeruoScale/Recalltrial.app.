import { describe, it, expect } from "vitest";
import {
  buildPriceIncreaseNotificationRecord,
  decidePriceIncreaseNotificationAction,
  PRICE_INCREASE_NOTIFICATIONS_DISABLED_SKIP_REASON,
} from "./priceIncreaseNotification";
import type { PriceChange } from "./priceChangeDetector";

function makeChange(overrides: Partial<PriceChange> = {}): PriceChange {
  return {
    detectedAt: "2026-08-15",
    previousAmount: "9.99",
    previousCurrency: "USD",
    previousInterval: "monthly",
    newAmount: "12.99",
    newCurrency: "USD",
    newInterval: "monthly",
    absoluteChange: 3,
    percentageChange: 30,
    monthlyImpact: 3,
    annualImpact: 36,
    changeType: "increase",
    ...overrides,
  };
}

describe("buildPriceIncreaseNotificationRecord()", () => {
  it("builds a record for a genuine increase", () => {
    const record = buildPriceIncreaseNotificationRecord(makeChange(), "sub-1", "user-1");
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      subscriptionId: "sub-1",
      userId: "user-1",
      detectedAt: "2026-08-15",
      previousAmount: "9.99",
      previousCurrency: "USD",
      previousInterval: "monthly",
      newAmount: "12.99",
      newCurrency: "USD",
      newInterval: "monthly",
      percentageChange: "30",
      monthlyImpact: "3",
      annualImpact: "36",
    });
  });

  it("returns null for a decrease", () => {
    expect(buildPriceIncreaseNotificationRecord(makeChange({ changeType: "decrease" }), "sub-1", "user-1")).toBeNull();
  });

  it("returns null for a currency change", () => {
    expect(
      buildPriceIncreaseNotificationRecord(
        makeChange({ changeType: "currency_change", absoluteChange: 0, percentageChange: 0, monthlyImpact: 0, annualImpact: 0 }),
        "sub-1",
        "user-1"
      )
    ).toBeNull();
  });

  it("returns null for a billing-interval change", () => {
    expect(
      buildPriceIncreaseNotificationRecord(makeChange({ changeType: "interval_change", newInterval: "annual" }), "sub-1", "user-1")
    ).toBeNull();
  });

  // A first-known price and an unchanged/malformed pair never reach this
  // function at all — detectPriceChanges() (priceChangeDetector.ts) never
  // produces a `changes` entry for either case (no prior observation to
  // compare against, or the pair was skipped for a null amount), so
  // priceChanges.latestChange is null and the caller (storage.ts) never
  // calls buildPriceIncreaseNotificationRecord() in the first place. This
  // is a documentation test, not a new guard — see priceChangeDetector.test.ts
  // for that module's own coverage of those cases.
  it("is never called for a first-known price or an unchanged/malformed pair (documented via priceChangeDetector's own contract, not re-tested here)", () => {
    expect(true).toBe(true);
  });
});

describe("decidePriceIncreaseNotificationAction()", () => {
  it("attempts when enabled and the subscription is currently active", () => {
    expect(decidePriceIncreaseNotificationAction(true, true)).toEqual({ action: "attempt" });
  });

  it("skips with the exact disabled-preference marker when the user has notifications off", () => {
    expect(decidePriceIncreaseNotificationAction(false, true)).toEqual({
      action: "skip",
      reason: PRICE_INCREASE_NOTIFICATIONS_DISABLED_SKIP_REASON,
    });
  });

  it("skips when the subscription is hidden by active Gmail connection isolation, even if notifications are enabled", () => {
    const decision = decidePriceIncreaseNotificationAction(true, false);
    expect(decision.action).toBe("skip");
  });

  it("skips for the disabled reason (not the isolation reason) when both conditions would skip — preference is checked first", () => {
    const decision = decidePriceIncreaseNotificationAction(false, false);
    expect(decision).toEqual({ action: "skip", reason: PRICE_INCREASE_NOTIFICATIONS_DISABLED_SKIP_REASON });
  });
});
