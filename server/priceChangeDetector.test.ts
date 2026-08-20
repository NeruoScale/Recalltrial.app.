import { describe, it, expect } from "vitest";
import { buildPriceHistory } from "./priceHistory";
import { detectPriceChanges } from "./priceChangeDetector";
import type { SubscriptionEvent } from "@shared/schema";

let idCounter = 0;
function makeEvent(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  idCounter++;
  return {
    id: `evt-${idCounter}`,
    subscriptionId: null,
    userId: "user-1",
    eventType: "subscription_invoice",
    sourceMessageId: `msg-${idCounter}`,
    extractedPrice: null,
    extractedCurrency: null,
    extractedDate: null,
    extractedMerchant: null,
    previousPrice: null,
    newPrice: null,
    billingInterval: null,
    billingIntervalSource: null,
    billingIntervalConfidence: null,
    amountSource: null,
    intervalSource: null,
    dateSource: null,
    confidence: 50,
    detectionSource: "deterministic",
    aiModel: null,
    canonicalMerchantName: "Example",
    canonicalMerchantDomain: "example.com",
    paymentProcessor: null,
    merchantConfidence: 90,
    merchantResolutionStatus: "resolved",
    canonicalEventId: null,
    classificationGeneration: 1,
    isCanonical: true,
    supersededBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionEvent;
}

function detectFromEvents(events: SubscriptionEvent[]) {
  return detectPriceChanges(buildPriceHistory(events));
}

describe("Phase 3B.9.8: detectPriceChanges() — real production case", () => {
  it("[£18.00, £15.00] -> decrease, -16.7%, -£3/month, -£36/year (exact decimal precision)", () => {
    const events = [
      makeEvent({ extractedPrice: "18.00", extractedCurrency: "GBP", extractedDate: "2026-06-06" }),
      makeEvent({ extractedPrice: "15.00", extractedCurrency: "GBP", extractedDate: "2026-07-09" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    expect(change.changeType).toBe("decrease");
    expect(change.percentageChange).toBe(-16.7);
    expect(change.monthlyImpact).toBe(-3);
    expect(change.annualImpact).toBe(-36);
    expect(change.absoluteChange).toBe(-3);
    expect(result.hasDecrease).toBe(true);
    expect(result.hasIncrease).toBe(false);
  });
});

describe("Phase 3B.9.8: detectPriceChanges() — increase/decrease math", () => {
  it("[$15.49, $17.99] -> increase, +16.1%, +$2.50/month, +$30/year", () => {
    const events = [
      makeEvent({ extractedPrice: "15.49", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "17.99", extractedCurrency: "USD", extractedDate: "2026-02-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes[0].changeType).toBe("increase");
    expect(result.changes[0].percentageChange).toBe(16.1);
    expect(result.changes[0].monthlyImpact).toBe(2.5);
    expect(result.changes[0].annualImpact).toBe(30);
    expect(result.hasIncrease).toBe(true);
  });

  it("[$17.99, $15.49] -> decrease, -13.9%", () => {
    const events = [
      makeEvent({ extractedPrice: "17.99", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "15.49", extractedCurrency: "USD", extractedDate: "2026-02-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes[0].changeType).toBe("decrease");
    expect(result.changes[0].percentageChange).toBe(-13.9);
  });
});

describe("Phase 3B.9.8: what is NOT a price change", () => {
  it("[$20, $20] -> no change", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-02-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(0);
  });

  it("[null, $20] -> no change (first known price, not an increase)", () => {
    const events = [
      makeEvent({ extractedPrice: null, extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-02-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(0);
    expect(result.hasIncrease).toBe(false);
  });

  it("[$20, null, $20] -> no change (null gap ignored)", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: null, extractedDate: "2026-02-01" }),
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-03-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(0);
  });

  it("[null, null] -> no changes", () => {
    const events = [
      makeEvent({ extractedPrice: null, extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: null, extractedDate: "2026-02-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(0);
    expect(result.latestChange).toBeNull();
    expect(result.totalAnnualImpact).toBeNull();
  });

  it("single observation -> no changes", () => {
    const events = [makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" })];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(0);
    expect(result.latestChange).toBeNull();
  });

  it("[USD $20, EUR €18] -> currency_change, no percentage calculated", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "18.00", extractedCurrency: "EUR", extractedDate: "2026-02-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].changeType).toBe("currency_change");
    expect(result.changes[0].percentageChange).toBe(0);
    expect(result.hasCurrencyChange).toBe(true);
    expect(result.hasIncrease).toBe(false);
    expect(result.hasDecrease).toBe(false);
  });

  it("[$20/month, $180/year] -> interval_change, normalized ($20 -> $15/month = decrease)", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", billingInterval: "monthly", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "180.00", extractedCurrency: "USD", billingInterval: "annual", extractedDate: "2026-02-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    expect(change.changeType).toBe("interval_change");
    expect(change.monthlyImpact).toBe(-5); // 180/12=15, 15-20=-5
    expect(change.annualImpact).toBe(-60);
    expect(result.hasIntervalChange).toBe(true);
    expect(result.hasIncrease).toBe(false);
    expect(result.hasDecrease).toBe(false);
  });
});

describe("Phase 3B.9.8: multiple changes, idempotency, cross-eventType", () => {
  it("tracks multiple changes chronologically, each compared to its own immediate predecessor", () => {
    const events = [
      makeEvent({ extractedPrice: "10.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "15.00", extractedCurrency: "USD", extractedDate: "2026-02-01" }),
      makeEvent({ extractedPrice: "12.00", extractedCurrency: "USD", extractedDate: "2026-03-01" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].changeType).toBe("increase"); // 10 -> 15
    expect(result.changes[0].previousAmount).toBe("10.00");
    expect(result.changes[0].newAmount).toBe("15.00");
    expect(result.changes[1].changeType).toBe("decrease"); // 15 -> 12
    expect(result.changes[1].previousAmount).toBe("15.00");
    expect(result.changes[1].newAmount).toBe("12.00");
    expect(result.latestChange).toEqual(result.changes[1]);
  });

  it("duplicate events are idempotent (buildPriceHistory collapses them before this function ever sees them)", () => {
    const event = makeEvent({ extractedPrice: "18.00", extractedCurrency: "GBP", extractedDate: "2026-06-06" });
    const once = detectFromEvents([event]);
    const twice = detectFromEvents([event, event]);
    expect(twice).toEqual(once);
    expect(twice.changes).toHaveLength(0);
  });

  it("calling detectPriceChanges twice on the identical priceHistory input is idempotent", () => {
    const events = [
      makeEvent({ extractedPrice: "18.00", extractedCurrency: "GBP", extractedDate: "2026-06-06" }),
      makeEvent({ extractedPrice: "15.00", extractedCurrency: "GBP", extractedDate: "2026-07-09" }),
    ];
    const priceHistory = buildPriceHistory(events);
    expect(detectPriceChanges(priceHistory)).toEqual(detectPriceChanges(priceHistory));
  });

  it("one_time_purchase events with a known price contribute to price observations and are compared like any other event", () => {
    const events = [
      makeEvent({ eventType: "one_time_purchase", extractedPrice: "18.00", extractedCurrency: "GBP", extractedDate: "2026-06-06" }),
      makeEvent({ eventType: "one_time_purchase", extractedPrice: "15.00", extractedCurrency: "GBP", extractedDate: "2026-07-09" }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].changeType).toBe("decrease");
    expect(result.changes[0].percentageChange).toBe(-16.7);
  });

  it("superseded (isCanonical=false) events are excluded, matching buildPriceHistory()'s own boundary", () => {
    const events = [
      makeEvent({ extractedPrice: "18.00", extractedCurrency: "GBP", extractedDate: "2026-06-06" }),
      makeEvent({ extractedPrice: "15.00", extractedCurrency: "GBP", extractedDate: "2026-07-09", isCanonical: false }),
    ];
    const result = detectFromEvents(events);
    expect(result.changes).toHaveLength(0);
  });
});

describe("Phase 3B.9.8: totalAnnualImpact", () => {
  it("sums annualImpact across all detected changes", () => {
    const events = [
      makeEvent({ extractedPrice: "10.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "15.00", extractedCurrency: "USD", extractedDate: "2026-02-01" }), // +5/month = +60/year
      makeEvent({ extractedPrice: "17.00", extractedCurrency: "USD", extractedDate: "2026-03-01" }), // +2/month = +24/year
    ];
    const result = detectFromEvents(events);
    expect(result.totalAnnualImpact).toBe(84);
  });
});
