import { describe, it, expect } from "vitest";
import { buildPriceHistory } from "./priceHistory";
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

describe("Phase 3B.9.6B: buildPriceHistory()", () => {
  it("[$20, $20, $22, $22] -> 2 observations ($20 first, $22 second)", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-02-01" }),
      makeEvent({ extractedPrice: "22.00", extractedCurrency: "USD", extractedDate: "2026-03-01" }),
      makeEvent({ extractedPrice: "22.00", extractedCurrency: "USD", extractedDate: "2026-04-01" }),
    ];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(2);
    expect(result.observations[0].amount).toBe("20.00");
    expect(result.observations[0].observedAt).toBe("2026-01-01"); // first date that price was seen
    expect(result.observations[1].amount).toBe("22.00");
    expect(result.observations[1].observedAt).toBe("2026-03-01");
  });

  it("[null, null, $20, $20] -> 1 observation, isFirstKnownPrice=true", () => {
    const events = [
      makeEvent({ extractedPrice: null, extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: null, extractedDate: "2026-01-15" }),
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-02-01" }),
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-03-01" }),
    ];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(1);
    expect(result.observations[0].isFirstKnownPrice).toBe(true);
    expect(result.observations[0].amount).toBe("20.00");
  });

  it("[$20, null, $20] -> 1 observation (null gap ignored, never an Unknown entry)", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: null, extractedDate: "2026-02-01" }),
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-03-01" }),
    ];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(1);
    expect(result.observations[0].amount).toBe("20.00");
  });

  it("[USD $20, EUR 18] -> 2 observations, isCurrencyChange=true", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "18.00", extractedCurrency: "EUR", extractedDate: "2026-02-01" }),
    ];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(2);
    expect(result.observations[0].isCurrencyChange).toBe(false);
    expect(result.observations[1].isCurrencyChange).toBe(true);
    expect(result.observations[1].currency).toBe("EUR");
  });

  it("[$20/month, $180/year] -> 2 observations, isIntervalChange=true", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", billingInterval: "monthly", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "180.00", extractedCurrency: "USD", billingInterval: "annual", extractedDate: "2026-02-01" }),
    ];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(2);
    expect(result.observations[0].isIntervalChange).toBe(false);
    expect(result.observations[1].isIntervalChange).toBe(true);
    expect(result.observations[1].billingInterval).toBe("annual");
  });

  it("empty input -> { observations: [], hasMultiplePrices: false }", () => {
    const result = buildPriceHistory([]);
    expect(result.observations).toEqual([]);
    expect(result.hasMultiplePrices).toBe(false);
    expect(result.observationCount).toBe(0);
    expect(result.currentPrice).toBeNull();
  });

  it("out-of-order dates are correctly sorted before processing", () => {
    const events = [
      makeEvent({ extractedPrice: "22.00", extractedCurrency: "USD", extractedDate: "2026-03-01" }),
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
    ];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(2);
    expect(result.observations[0].amount).toBe("20.00"); // earliest date first
    expect(result.observations[1].amount).toBe("22.00");
  });

  it("the same event passed twice is idempotent (same result as passing it once)", () => {
    const event = makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" });
    const once = buildPriceHistory([event]);
    const twice = buildPriceHistory([event, event]);
    expect(twice).toEqual(once);
  });

  it("currentPrice reflects the LAST (most recent) observation", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", billingInterval: "monthly", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "25.00", extractedCurrency: "USD", billingInterval: "monthly", extractedDate: "2026-06-01" }),
    ];
    const result = buildPriceHistory(events);
    expect(result.currentPrice).toEqual({ amount: "25.00", currency: "USD", billingInterval: "monthly" });
    expect(result.hasMultiplePrices).toBe(true);
  });

  it("a single known price -> observationCount=1, hasMultiplePrices=false", () => {
    const events = [makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" })];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(1);
    expect(result.hasMultiplePrices).toBe(false);
  });

  it("an event with a known amount but unknown currency is skipped entirely (never guessed)", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: null, extractedDate: "2026-01-01" }),
    ];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(0);
  });

  it("superseded events (isCanonical=false) are excluded from price history", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01", isCanonical: false }),
    ];
    const result = buildPriceHistory(events);
    expect(result.observationCount).toBe(0);
  });

  it("does not compute a percentage change or savings figure anywhere in the output (strict boundary)", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "25.00", extractedCurrency: "USD", extractedDate: "2026-06-01" }),
    ];
    const result = buildPriceHistory(events);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/percent|increase|savings/i);
  });
});
