import { describe, it, expect } from "vitest";
import {
  eventTypeLabel,
  billingDisplayLabel,
  buildHistory,
  buildSubscriptionVaultResponse,
  determineSubscriptionAccessResult,
} from "./subscriptionVault";
import { buildPriceHistory } from "./priceHistory";
import { detectPriceChanges } from "./priceChangeDetector";
import type { ShadowSubscription, SubscriptionEvent } from "@shared/schema";

// Fixture conventions mirror subscriptionCostEngine.test.ts's makeSub() —
// same field set, same "override what the test cares about" shape.
let subIdCounter = 0;
function makeSub(overrides: Partial<ShadowSubscription> = {}): ShadowSubscription {
  subIdCounter++;
  return {
    id: `sub-${subIdCounter}`,
    userId: "user-1",
    entityKey: "example.com",
    canonicalMerchantName: "Example",
    canonicalMerchantDomain: "example.com",
    merchantConfidence: 90,
    resolutionMethod: "domain_match",
    resolutionStatus: "resolved",
    planName: null,
    subscriptionStatus: "active",
    amount: "19.99",
    currency: "USD",
    billingInterval: "monthly",
    billingIntervalSource: "confirmed_email",
    billingIntervalConfidence: "high",
    nextBillingDate: "2026-09-01",
    lastBillingDate: "2026-08-01",
    sourceCanonicalEventId: "evt-1",
    isShadow: false,
    potentialFalseMerge: false,
    potentialFalseSplit: false,
    promotedAt: new Date("2026-08-19T00:00:00.000Z"),
    promotionReason: "domain_match_controlled_activation",
    promotionEvidence: "resolutionMethod=domain_match, merchantConfidence=90",
    userConfirmed: false,
    userConfirmedAt: null,
    userDismissed: false,
    userDismissedAt: null,
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  } as ShadowSubscription;
}

let evtIdCounter = 0;
function makeEvent(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  evtIdCounter++;
  return {
    id: `evt-${evtIdCounter}`,
    subscriptionId: null,
    userId: "user-1",
    eventType: "subscription_renewed",
    sourceMessageId: `msg-${evtIdCounter}`,
    extractedPrice: "19.99",
    extractedCurrency: "USD",
    extractedDate: "2026-08-01",
    extractedMerchant: "Example",
    previousPrice: null,
    newPrice: null,
    billingInterval: "monthly",
    billingIntervalSource: "confirmed_email",
    billingIntervalConfidence: "high",
    confidence: 85,
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
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionEvent;
}

describe("Phase 3B.9.5: eventTypeLabel", () => {
  it("translates every real enum value to a user-friendly label (not the raw enum string)", () => {
    const cases: Record<string, string> = {
      trial_started: "Trial started",
      trial_ending: "Trial ending",
      subscription_started: "Subscription started",
      subscription_renewed: "Renewed",
      payment_received: "Payment received",
      invoice_received: "Invoice received",
      price_changed: "Price changed",
      cancellation_requested: "Cancellation requested",
      cancellation_confirmed: "Cancellation confirmed",
      subscription_expired: "Expired",
      subscription_paused: "Paused",
      unknown_subscription_event: "Subscription activity",
      subscription_invoice: "Invoice",
      one_time_purchase: "One-time purchase",
      subscription_cancelled: "Cancelled",
      payment_failed: "Payment failed",
    };
    for (const [eventType, label] of Object.entries(cases)) {
      expect(eventTypeLabel(eventType)).toBe(label);
    }
  });

  it("never returns the raw snake_case string for a known event type", () => {
    expect(eventTypeLabel("payment_failed")).not.toContain("_");
  });

  it("falls back to a readable Title Case label for an unrecognized value, never the raw string verbatim", () => {
    expect(eventTypeLabel("some_future_event")).toBe("Some Future Event");
  });
});

describe("Phase 3B.9.5: billingDisplayLabel", () => {
  it("maps every real BillingIntervalSource to its exact specified phrase", () => {
    expect(billingDisplayLabel("confirmed_email")).toBe("Confirmed from email");
    expect(billingDisplayLabel("merchant_knowledge")).toBe("Based on plan details");
    expect(billingDisplayLabel("inferred")).toBe("Based on recurring billing pattern");
  });

  it("returns Unknown for the unknown source and for null", () => {
    expect(billingDisplayLabel("unknown")).toBe("Unknown");
    expect(billingDisplayLabel(null)).toBe("Unknown");
  });
});

describe("Phase 3B.9.5: buildHistory — canonical-only, STRICT BOUNDARY", () => {
  it("excludes isCanonical=false rows entirely — a superseded classification must never reach the response", () => {
    const canonical = makeEvent({ id: "evt-canonical", isCanonical: true });
    const superseded = makeEvent({ id: "evt-superseded", isCanonical: false, supersededBy: "evt-canonical" });
    const history = buildHistory([canonical, superseded]);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("evt-canonical");
    expect(history.some((h) => h.id === "evt-superseded")).toBe(false);
  });

  it("orders most-recent-first by date", () => {
    const older = makeEvent({ id: "evt-old", extractedDate: "2026-06-01" });
    const newer = makeEvent({ id: "evt-new", extractedDate: "2026-08-01" });
    const middle = makeEvent({ id: "evt-mid", extractedDate: "2026-07-01" });
    const history = buildHistory([older, newer, middle]);
    expect(history.map((h) => h.id)).toEqual(["evt-new", "evt-mid", "evt-old"]);
  });

  it("falls back to createdAt when extractedDate is null, never omitting the row", () => {
    const event = makeEvent({ extractedDate: null, createdAt: new Date("2026-08-10T00:00:00.000Z") });
    const history = buildHistory([event]);
    expect(history).toHaveLength(1);
    expect(history[0].date).toBe("2026-08-10");
  });

  it("produces user-friendly eventTypeLabel, not the raw eventType, on every entry", () => {
    const event = makeEvent({ eventType: "payment_failed" });
    const [entry] = buildHistory([event]);
    expect(entry.eventType).toBe("payment_failed");
    expect(entry.eventTypeLabel).toBe("Payment failed");
  });

  it("passes through amount/currency/confidence/sourceMessageId unchanged", () => {
    const event = makeEvent({ extractedPrice: "22.00", extractedCurrency: "USD", confidence: 77, sourceMessageId: "msg-abc" });
    const [entry] = buildHistory([event]);
    expect(entry.amount).toBe("22.00");
    expect(entry.currency).toBe("USD");
    expect(entry.confidence).toBe(77);
    expect(entry.sourceMessageId).toBe("msg-abc");
  });
});

describe("Phase 3B.9.5: buildSubscriptionVaultResponse", () => {
  it("reuses subscriptionCostEngine for cost math — monthly sub: monthlyCost = amount, annualCost = amount x 12", () => {
    const sub = makeSub({ amount: "22.00", billingInterval: "monthly", currency: "USD" });
    const response = buildSubscriptionVaultResponse(sub, [], null);
    expect(response.cost.monthlyCost).toBe(22);
    expect(response.cost.annualCost).toBeCloseTo(264, 5);
  });

  it("monthlyEquivalent/annualEquivalent mirror monthlyCost/annualCost exactly (same computation, not a second one)", () => {
    const sub = makeSub({ amount: "199.00", billingInterval: "annual", currency: "USD" });
    const response = buildSubscriptionVaultResponse(sub, [], null);
    expect(response.cost.monthlyEquivalent).toBe(response.cost.monthlyCost);
    expect(response.cost.annualEquivalent).toBe(response.cost.annualCost);
  });

  it("never shows $0 for an unknown amount — cost fields are null, not zero", () => {
    const sub = makeSub({ amount: null, currency: null });
    const response = buildSubscriptionVaultResponse(sub, [], null);
    expect(response.cost.monthlyCost).toBeNull();
    expect(response.cost.annualCost).toBeNull();
  });

  it("billing.displayLabel matches the subscription's billingIntervalSource", () => {
    const sub = makeSub({ billingIntervalSource: "inferred" });
    const response = buildSubscriptionVaultResponse(sub, [], null);
    expect(response.billing.displayLabel).toBe("Based on recurring billing pattern");
    expect(response.billing.source).toBe("inferred");
  });

  it("history contains only canonical events, ordered most-recent-first", () => {
    const sub = makeSub();
    const events = [
      makeEvent({ id: "evt-1", extractedDate: "2026-07-01", isCanonical: true }),
      makeEvent({ id: "evt-2", extractedDate: "2026-08-01", isCanonical: true }),
      makeEvent({ id: "evt-3", extractedDate: "2026-08-15", isCanonical: false, supersededBy: "evt-2" }),
    ];
    const response = buildSubscriptionVaultResponse(sub, events, null);
    expect(response.history.map((h) => h.id)).toEqual(["evt-2", "evt-1"]);
    expect(response.detection.eventCount).toBe(2);
  });

  it("detection.confidence reuses the subscription's own merchantConfidence", () => {
    const sub = makeSub({ merchantConfidence: 65 });
    const response = buildSubscriptionVaultResponse(sub, [], null);
    expect(response.detection.confidence).toBe(65);
  });

  it("detection.resolutionMethod passes through from the subscription row", () => {
    const sub = makeSub({ resolutionMethod: "domain_match" });
    const response = buildSubscriptionVaultResponse(sub, [], null);
    expect(response.detection.resolutionMethod).toBe("domain_match");
  });

  it("carries the paymentProcessor the caller resolved from events, without recomputing it", () => {
    const sub = makeSub();
    const response = buildSubscriptionVaultResponse(sub, [], "stripe");
    expect(response.subscription.paymentProcessor).toBe("stripe");
  });

  it("subscription.id/canonicalMerchantName/subscriptionStatus/amount/nextBillingDate reflect the real row", () => {
    const sub = makeSub({
      id: "sub-real",
      canonicalMerchantName: "Anthropic",
      subscriptionStatus: "active",
      amount: "20.00",
      nextBillingDate: "2027-08-01",
    });
    const response = buildSubscriptionVaultResponse(sub, [], null);
    expect(response.subscription.id).toBe("sub-real");
    expect(response.subscription.canonicalMerchantName).toBe("Anthropic");
    expect(response.subscription.subscriptionStatus).toBe("active");
    expect(response.subscription.amount).toBe("20.00");
    expect(response.renewal.nextBillingDate).toBe("2027-08-01");
  });

  it("Track UX follow-up: exposes userConfirmed/userConfirmedAt read-only from the row, never derived", () => {
    const confirmedAt = new Date("2026-08-23T01:55:02.877Z");
    const confirmed = buildSubscriptionVaultResponse(makeSub({ userConfirmed: true, userConfirmedAt: confirmedAt }), [], null);
    expect(confirmed.subscription.userConfirmed).toBe(true);
    expect(confirmed.subscription.userConfirmedAt).toBe(confirmedAt.toISOString());

    const notConfirmed = buildSubscriptionVaultResponse(makeSub({ userConfirmed: false, userConfirmedAt: null }), [], null);
    expect(notConfirmed.subscription.userConfirmed).toBe(false);
    expect(notConfirmed.subscription.userConfirmedAt).toBeNull();
  });
});

describe("Phase 3B.9.6B: buildSubscriptionVaultResponse includes priceHistory", () => {
  it("GET /api/subscriptions/:id response includes a priceHistory field matching buildPriceHistory(events) exactly", () => {
    const sub = makeSub();
    const events = [
      makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" }),
      makeEvent({ extractedPrice: "22.00", extractedCurrency: "USD", extractedDate: "2026-06-01" }),
    ];
    const response = buildSubscriptionVaultResponse(sub, events, null);
    expect(response.priceHistory).toEqual(buildPriceHistory(events));
    expect(response.priceHistory.observationCount).toBe(2);
    expect(response.priceHistory.currentPrice).toEqual({ amount: "22.00", currency: "USD", billingInterval: "monthly" });
  });

  it("no priced events -> priceHistory is empty, not omitted", () => {
    const sub = makeSub();
    const response = buildSubscriptionVaultResponse(sub, [], null);
    expect(response.priceHistory.observations).toEqual([]);
    expect(response.priceHistory.observationCount).toBe(0);
    expect(response.priceHistory.currentPrice).toBeNull();
  });
});

describe("Phase 3B.9.8: buildSubscriptionVaultResponse includes priceChanges", () => {
  it("GET /api/subscriptions/:id response includes a priceChanges field matching detectPriceChanges(priceHistory) exactly", () => {
    const sub = makeSub();
    const events = [
      makeEvent({ extractedPrice: "18.00", extractedCurrency: "GBP", extractedDate: "2026-06-06" }),
      makeEvent({ extractedPrice: "15.00", extractedCurrency: "GBP", extractedDate: "2026-07-09" }),
    ];
    const response = buildSubscriptionVaultResponse(sub, events, null);
    expect(response.priceChanges).toEqual(detectPriceChanges(buildPriceHistory(events)));
    expect(response.priceChanges.hasDecrease).toBe(true);
    expect(response.priceChanges.latestChange?.percentageChange).toBe(-16.7);
  });

  it("no changes -> priceChanges.changes is empty, not omitted", () => {
    const sub = makeSub();
    const events = [makeEvent({ extractedPrice: "20.00", extractedCurrency: "USD", extractedDate: "2026-01-01" })];
    const response = buildSubscriptionVaultResponse(sub, events, null);
    expect(response.priceChanges.changes).toEqual([]);
    expect(response.priceChanges.latestChange).toBeNull();
    expect(response.priceChanges.hasIncrease).toBe(false);
    expect(response.priceChanges.hasDecrease).toBe(false);
  });

  it("a one_time_purchase event with a price still contributes to priceChanges, per the approved architectural decision", () => {
    const sub = makeSub();
    const events = [
      makeEvent({ eventType: "one_time_purchase", extractedPrice: "18.00", extractedCurrency: "GBP", extractedDate: "2026-06-06" }),
      makeEvent({ eventType: "one_time_purchase", extractedPrice: "15.00", extractedCurrency: "GBP", extractedDate: "2026-07-09" }),
    ];
    const response = buildSubscriptionVaultResponse(sub, events, null);
    expect(response.priceChanges.hasDecrease).toBe(true);
    // The subscription's own `amount` field must never be mutated by this
    // pure response builder — it only reflects whatever the caller already
    // passed in on `sub`.
    expect(response.subscription.amount).toBe(sub.amount);
  });
});

// Phase 3B.9.6A Step 4's "primary subscriptionId FK, fallback to merchant
// match" branching lives in server/storage.ts's getCanonicalEventsForSubscription()
// — a live DB query (SELECT ... WHERE subscription_id = $1, falling back to
// a second SELECT), which this codebase has no mocking infrastructure for
// (every existing *.test.ts file tests a pure function only; storage.ts
// itself has zero unit tests anywhere in this repo). That specific
// branching is verified against real production data instead, the same way
// every other storage.ts DB-query behavior in this codebase has been
// verified throughout this project — not skipped, just verified at a
// different layer than unit tests. What IS unit-tested here is the pure
// half of the same guarantee: buildSubscriptionVaultResponse() and
// buildPriceHistory() only ever reflect the events actually passed in,
// never anything else, which is what makes the DB layer's scoping
// meaningful in the first place.
describe("Phase 3B.9.6B: cross-user isolation (pure-function level)", () => {
  it("two independent calls for two different users' subscriptions never leak into each other's response", () => {
    const subA = makeSub({ id: "sub-A", userId: "user-A", canonicalMerchantName: "A-Service" });
    const eventsA = [makeEvent({ userId: "user-A", canonicalMerchantName: "A-Service", extractedPrice: "10.00", extractedCurrency: "USD", extractedDate: "2026-01-01" })];

    const subB = makeSub({ id: "sub-B", userId: "user-B", canonicalMerchantName: "B-Service" });
    const eventsB = [makeEvent({ userId: "user-B", canonicalMerchantName: "B-Service", extractedPrice: "99.00", extractedCurrency: "EUR", extractedDate: "2026-02-01" })];

    const responseA = buildSubscriptionVaultResponse(subA, eventsA, null);
    const responseB = buildSubscriptionVaultResponse(subB, eventsB, null);

    expect(responseA.subscription.canonicalMerchantName).toBe("A-Service");
    expect(responseA.priceHistory.currentPrice?.amount).toBe("10.00");
    expect(responseB.subscription.canonicalMerchantName).toBe("B-Service");
    expect(responseB.priceHistory.currentPrice?.amount).toBe("99.00");

    // Neither response contains any trace of the other user's data.
    expect(JSON.stringify(responseA)).not.toContain("B-Service");
    expect(JSON.stringify(responseB)).not.toContain("A-Service");
  });
});

describe("Phase 3B.9.5: determineSubscriptionAccessResult — STRICT SECURITY", () => {
  it("returns 401 when there is no session user", () => {
    const result = determineSubscriptionAccessResult(undefined, makeSub({ userId: "user-1" }));
    expect(result.status).toBe(401);
  });

  it("returns 404 (never 403) when no subscription was found", () => {
    const result = determineSubscriptionAccessResult("user-1", undefined);
    expect(result.status).toBe(404);
  });

  it("returns 404 (never 403) for a different user's subscription — cross-user isolation, no existence leak", () => {
    const otherUsersSub = makeSub({ userId: "user-B" });
    const result = determineSubscriptionAccessResult("user-A", otherUsersSub);
    expect(result.status).toBe(404);
  });

  it("returns 200 with the subscription for the actual owner", () => {
    const ownSub = makeSub({ userId: "user-1", id: "sub-mine" });
    const result = determineSubscriptionAccessResult("user-1", ownSub);
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.subscription.id).toBe("sub-mine");
    }
  });
});
