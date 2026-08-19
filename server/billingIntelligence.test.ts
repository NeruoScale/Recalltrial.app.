import { describe, it, expect } from "vitest";
import { inferBillingInterval, shouldUpdateBillingIntelligence } from "./billingIntelligence";
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
    canonicalMerchantName: null,
    canonicalMerchantDomain: null,
    paymentProcessor: null,
    merchantConfidence: null,
    merchantResolutionStatus: null,
    canonicalEventId: null,
    classificationGeneration: 1,
    isCanonical: true,
    supersededBy: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionEvent;
}

describe("Phase 3B.9.3: inferBillingInterval() — Tier 1 (confirmed_email)", () => {
  it("'$20/month' in email -> confirmed_email, monthly, high", () => {
    const events = [makeEvent({ billingInterval: "monthly", extractedPrice: "20.00", extractedDate: "2026-01-01" })];
    const result = inferBillingInterval(events);
    expect(result).toEqual({
      billingInterval: "monthly",
      billingIntervalSource: "confirmed_email",
      billingIntervalConfidence: "high",
      evidenceCount: 1,
      inferenceMethod: "explicit billing interval extracted from email text",
    });
  });

  it("prefers the MOST RECENT event's confirmed value when events disagree", () => {
    const events = [
      makeEvent({ billingInterval: "monthly", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
      makeEvent({ billingInterval: "annual", createdAt: new Date("2026-06-01T00:00:00.000Z") }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingInterval).toBe("annual");
    expect(result.billingIntervalSource).toBe("confirmed_email");
  });
});

describe("Phase 3B.9.3: inferBillingInterval() — Tier 4 (unknown)", () => {
  it("'$20' alone (price, no interval evidence at all) -> unknown", () => {
    const events = [makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01", billingInterval: null })];
    const result = inferBillingInterval(events);
    expect(result.billingIntervalSource).toBe("unknown");
    expect(result.billingInterval).toBeNull();
  });

  it("1 event only -> unknown, never infers from a single event", () => {
    const events = [makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01" })];
    const result = inferBillingInterval(events);
    expect(result.billingIntervalSource).toBe("unknown");
  });

  it("empty event list -> unknown", () => {
    expect(inferBillingInterval([]).billingIntervalSource).toBe("unknown");
  });
});

describe("Phase 3B.9.3: inferBillingInterval() — Tier 3 (recurrence inference)", () => {
  it("2 events ~30 days apart -> inferred, monthly, medium", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-31" }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingInterval).toBe("monthly");
    expect(result.billingIntervalSource).toBe("inferred");
    expect(result.billingIntervalConfidence).toBe("medium");
    expect(result.evidenceCount).toBe(2);
  });

  it("3 events ~30 days apart -> inferred, monthly, high", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-31" }),
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-03-02" }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingInterval).toBe("monthly");
    expect(result.billingIntervalConfidence).toBe("high");
    expect(result.evidenceCount).toBe(3);
  });

  it("price change across events ($15 -> $17 -> $17) -> still monthly, cadence matters not amount equality", () => {
    const events = [
      makeEvent({ extractedPrice: "15.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "17.00", extractedDate: "2026-01-31" }),
      makeEvent({ extractedPrice: "17.00", extractedDate: "2026-03-02" }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingInterval).toBe("monthly");
    expect(result.billingIntervalSource).toBe("inferred");
  });

  it("3 events ~90 days apart -> quarterly", () => {
    const events = [
      makeEvent({ extractedPrice: "30.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "30.00", extractedDate: "2026-04-01" }),
      makeEvent({ extractedPrice: "30.00", extractedDate: "2026-06-30" }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingInterval).toBe("quarterly");
    expect(result.billingIntervalConfidence).toBe("high");
  });

  it("2 events ~365 days apart -> annual", () => {
    const events = [
      makeEvent({ extractedPrice: "120.00", extractedDate: "2025-01-01" }),
      makeEvent({ extractedPrice: "120.00", extractedDate: "2026-01-01" }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingInterval).toBe("annual");
    expect(result.billingIntervalConfidence).toBe("medium");
  });

  it("2 events ~180 days apart -> semi_annual", () => {
    const events = [
      makeEvent({ extractedPrice: "60.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "60.00", extractedDate: "2026-06-30" }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingInterval).toBe("semi_annual");
  });

  it("inconsistent gaps (one ~30 days, one ~90 days) -> no inference, unknown (never guesses)", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-31" }),
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-05-01" }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingIntervalSource).toBe("unknown");
  });

  it("a gap that matches no band at all (e.g. 10 days) -> no inference", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-11" }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingIntervalSource).toBe("unknown");
  });

  it("events missing a price are excluded from the eligible set (never infers from date-only evidence)", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: null, extractedDate: "2026-01-31" }), // no price -> excluded
    ];
    const result = inferBillingInterval(events);
    expect(result.billingIntervalSource).toBe("unknown"); // only 1 eligible event left
  });

  it("events missing a date are excluded from the eligible set", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedDate: null }),
    ];
    const result = inferBillingInterval(events);
    expect(result.billingIntervalSource).toBe("unknown");
  });
});

describe("Phase 3B.9.3: safety rules", () => {
  it("never infers monthly from price alone, regardless of the specific amount", () => {
    for (const price of ["20.00", "9.99", "199.00"]) {
      const events = [makeEvent({ extractedPrice: price, extractedDate: "2026-01-01" })];
      expect(inferBillingInterval(events).billingIntervalSource).toBe("unknown");
    }
  });

  it("never infers from merchant name/domain alone (function doesn't even see them)", () => {
    const events = [
      makeEvent({ canonicalMerchantDomain: "youtube.com", canonicalMerchantName: "YouTube", extractedPrice: "22.00", extractedDate: "2026-01-01" }),
    ];
    expect(inferBillingInterval(events).billingIntervalSource).toBe("unknown");
  });

  it("cross-user isolation: passing only user B's events never reflects user A's pattern", () => {
    const userAEvents = [
      makeEvent({ userId: "user-A", extractedPrice: "20.00", extractedDate: "2026-01-01" }),
      makeEvent({ userId: "user-A", extractedPrice: "20.00", extractedDate: "2026-01-31" }),
    ];
    const userBEvents = [makeEvent({ userId: "user-B", extractedPrice: "20.00", extractedDate: "2026-01-01" })];

    // Caller is responsible for scoping (matches every other pure engine in
    // this codebase) — passing ONLY user B's single event correctly yields
    // unknown, never "borrowing" user A's 2-event monthly pattern.
    expect(inferBillingInterval(userBEvents).billingIntervalSource).toBe("unknown");
    expect(inferBillingInterval(userAEvents).billingIntervalSource).toBe("inferred");
  });

  it("idempotent: calling twice with the same input produces the same result", () => {
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "20.00", extractedDate: "2026-01-31" }),
    ];
    const a = inferBillingInterval(events);
    const b = inferBillingInterval(events);
    expect(a).toEqual(b);
  });
});

describe("Phase 3B.9.3: shouldUpdateBillingIntelligence() — tier override protection", () => {
  it("confirmed_email cannot be overwritten by inferred", () => {
    expect(shouldUpdateBillingIntelligence({ source: "confirmed_email" }, { source: "inferred" })).toBe(false);
  });

  it("confirmed_email cannot be overwritten by merchant_knowledge", () => {
    expect(shouldUpdateBillingIntelligence({ source: "confirmed_email" }, { source: "merchant_knowledge" })).toBe(false);
  });

  it("merchant_knowledge cannot be overwritten by inferred", () => {
    expect(shouldUpdateBillingIntelligence({ source: "merchant_knowledge" }, { source: "inferred" })).toBe(false);
  });

  it("a higher tier CAN overwrite a lower one", () => {
    expect(shouldUpdateBillingIntelligence({ source: "unknown" }, { source: "inferred" })).toBe(true);
    expect(shouldUpdateBillingIntelligence({ source: "inferred" }, { source: "merchant_knowledge" })).toBe(true);
    expect(shouldUpdateBillingIntelligence({ source: "merchant_knowledge" }, { source: "confirmed_email" })).toBe(true);
  });

  it("same tier can refresh (e.g. a newer confirmed_email superseding an older one)", () => {
    expect(shouldUpdateBillingIntelligence({ source: "confirmed_email" }, { source: "confirmed_email" })).toBe(true);
  });
});
