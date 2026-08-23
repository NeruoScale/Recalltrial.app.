import { describe, it, expect } from "vitest";
import { generateRecommendations } from "./savingsRecommendations";
import type { ShadowSubscription, SubscriptionEvent } from "@shared/schema";
import type { SavingsOpportunity } from "./savingsIntelligence";
import type { PriceChangeResult } from "./priceChangeDetector";

// Phase 3C.4: cross-user isolation for the REAL feature is enforced at the
// route layer (server/routes.ts's GET /api/subscriptions/recommendations
// builds its inputs from storage.getShadowSubscriptionsForUser(req.session.userId!)
// — this module never touches the DB and has no userId-scoped query to get
// wrong). The pure-function-level test below instead verifies this module
// itself never lets one subscription's facts bleed into another's
// recommendation when multiple users' subscriptions are processed together
// in one call — no DB-integration test infra exists in this codebase (see
// server/savingsIntelligence.test.ts's identical note).

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
    nextBillingDate: null,
    lastBillingDate: null,
    sourceCanonicalEventId: "evt-1",
    isShadow: false,
    potentialFalseMerge: false,
    potentialFalseSplit: false,
    promotedAt: new Date("2026-08-19T00:00:00.000Z"),
    promotionReason: "domain_match_controlled_activation",
    promotionEvidence: "resolutionMethod=domain_match, merchantConfidence=90",
    lastPriceChangeAt: null,
    lastPriceChangeType: null,
    lastPriceChangeAbsolute: null,
    lastPriceChangePercentage: null,
    lastPriceChangeAnnualImpact: null,
    userConfirmed: false,
    userConfirmedAt: null,
    userDismissed: false,
    userDismissedAt: null,
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  } as ShadowSubscription;
}

let eventIdCounter = 0;
function makeEvent(subscriptionId: string, overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  eventIdCounter++;
  return {
    id: `evt-${eventIdCounter}`,
    subscriptionId,
    userId: "user-1",
    eventType: "subscription_invoice",
    sourceMessageId: `msg-${eventIdCounter}`,
    extractedPrice: "19.99",
    extractedCurrency: "USD",
    extractedDate: "2026-08-01",
    extractedMerchant: "Example",
    previousPrice: null,
    newPrice: null,
    billingInterval: "monthly",
    billingIntervalSource: "confirmed_email",
    billingIntervalConfidence: "high",
    amountSource: "snippet",
    intervalSource: "snippet",
    dateSource: "snippet",
    bodyFetched: false,
    confidence: 90,
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
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as SubscriptionEvent;
}

function makeOpportunity(subscriptionId: string, overrides: Partial<SavingsOpportunity> = {}): SavingsOpportunity {
  return {
    subscriptionId,
    merchant: "Example",
    score: 0,
    classification: "essential",
    monthlyCost: null,
    annualCost: null,
    currency: null,
    potentialMonthlySavings: null,
    potentialAnnualSavings: null,
    confidence: "medium",
    reasons: [],
    evidenceCount: 0,
    userConfirmed: false,
    userDismissed: false,
    ...overrides,
  };
}

const noChange: PriceChangeResult = {
  changes: [], hasIncrease: false, hasDecrease: false, hasCurrencyChange: false, hasIntervalChange: false, latestChange: null, totalAnnualImpact: null,
};

const NOW = new Date("2026-08-23T00:00:00.000Z");

describe("Phase 3C.4: recommendation type selection", () => {
  it("past_due subscription -> REVIEW_PAST_DUE", () => {
    const sub = makeSub({ subscriptionStatus: "past_due" });
    const { recommendations } = generateRecommendations([sub], [], {}, {}, NOW);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].type).toBe("REVIEW_PAST_DUE");
  });

  it("payment_failed events (not past due, amount known) -> REVIEW_PAYMENT_FAILURE", () => {
    const sub = makeSub({ subscriptionStatus: "active" });
    const events = { [sub.id]: [makeEvent(sub.id, { eventType: "payment_failed" })] };
    const { recommendations } = generateRecommendations([sub], [], {}, events, NOW);
    expect(recommendations[0].type).toBe("REVIEW_PAYMENT_FAILURE");
  });

  it("price increase detected -> REVIEW_PRICE_INCREASE", () => {
    const sub = makeSub({ lastPriceChangeType: "increase" });
    const change: PriceChangeResult = { ...noChange, hasIncrease: true, latestChange: { detectedAt: "2026-08-01", previousAmount: "10.00", previousCurrency: "USD", previousInterval: "monthly", newAmount: "12.00", newCurrency: "USD", newInterval: "monthly", absoluteChange: 2, percentageChange: 20, monthlyImpact: 2, annualImpact: 24, changeType: "increase" } };
    const { recommendations } = generateRecommendations([sub], [], { [sub.id]: change }, {}, NOW);
    expect(recommendations[0].type).toBe("REVIEW_PRICE_INCREASE");
  });

  it("currency change detected -> REVIEW_CURRENCY_CHANGE", () => {
    const sub = makeSub({ lastPriceChangeType: "currency_change" });
    const { recommendations } = generateRecommendations([sub], [], {}, {}, NOW);
    expect(recommendations[0].type).toBe("REVIEW_CURRENCY_CHANGE");
  });

  it("unknown amount + payment failures -> CONFIRM_AMOUNT (priority medium)", () => {
    const sub = makeSub({ amount: null, subscriptionStatus: "active" });
    const events = { [sub.id]: [makeEvent(sub.id, { eventType: "payment_failed" })] };
    const { recommendations } = generateRecommendations([sub], [], {}, events, NOW);
    expect(recommendations[0].type).toBe("CONFIRM_AMOUNT");
    expect(recommendations[0].priority).toBe("medium");
  });

  it("high cost + potential_savings classification -> REVIEW_COST", () => {
    const sub = makeSub({ subscriptionStatus: "active" });
    const opportunity = makeOpportunity(sub.id, { classification: "potential_savings", annualCost: 300, monthlyCost: 25, currency: "USD", potentialAnnualSavings: 300, potentialMonthlySavings: 25 });
    const { recommendations } = generateRecommendations([sub], [opportunity], {}, {}, NOW);
    expect(recommendations[0].type).toBe("REVIEW_COST");
    expect(recommendations[0].potentialAnnualSavings).toBe(300);
  });

  it("renewal approaching alone (no other signal) -> REVIEW_RENEWAL", () => {
    const sub = makeSub({ subscriptionStatus: "active", nextBillingDate: "2026-09-05" }); // 13 days out
    const { recommendations } = generateRecommendations([sub], [], {}, {}, NOW);
    expect(recommendations[0].type).toBe("REVIEW_RENEWAL");
  });
});

describe("Phase 3C.4: priority", () => {
  it("renewal <7 days + past_due -> HIGH priority", () => {
    const sub = makeSub({ subscriptionStatus: "past_due", nextBillingDate: "2026-08-27" }); // 4 days out
    const { recommendations } = generateRecommendations([sub], [], {}, {}, NOW);
    expect(recommendations[0].priority).toBe("high");
  });

  it("renewal <30 days alone -> MEDIUM priority", () => {
    const sub = makeSub({ subscriptionStatus: "active", nextBillingDate: "2026-09-10" }); // 18 days out
    const { recommendations } = generateRecommendations([sub], [], {}, {}, NOW);
    expect(recommendations[0].priority).toBe("medium");
  });

  it("2+ payment failures -> HIGH priority", () => {
    const sub = makeSub({ subscriptionStatus: "active" });
    const events = { [sub.id]: [makeEvent(sub.id, { eventType: "payment_failed" }), makeEvent(sub.id, { eventType: "payment_failed" })] };
    const { recommendations } = generateRecommendations([sub], [], {}, events, NOW);
    expect(recommendations[0].priority).toBe("high");
  });

  it("no concerning signals -> no recommendation generated at all", () => {
    const sub = makeSub({ subscriptionStatus: "active", amount: "19.99", nextBillingDate: "2027-06-01" }); // far future, no other flags
    const { recommendations } = generateRecommendations([sub], [], {}, {}, NOW);
    expect(recommendations).toHaveLength(0);
  });
});

describe("Phase 3C.4: language rules", () => {
  const bannedWords = ["cancel", "wasting", "unused", "guaranteed", "$0"];

  it("no description across a wide range of fixtures contains a banned word", () => {
    const scenarios: ShadowSubscription[] = [
      makeSub({ subscriptionStatus: "past_due" }),
      makeSub({ amount: null, subscriptionStatus: "past_due" }),
      makeSub({ lastPriceChangeType: "increase" }),
      makeSub({ lastPriceChangeType: "currency_change" }),
      makeSub({ nextBillingDate: "2026-08-25" }),
    ];
    const eventsBySub: Record<string, SubscriptionEvent[]> = {};
    for (const s of scenarios) eventsBySub[s.id] = [makeEvent(s.id, { eventType: "payment_failed" })];
    const opportunities = scenarios.map((s) => makeOpportunity(s.id, { classification: "potential_savings", annualCost: 300 }));

    const { recommendations } = generateRecommendations(scenarios, opportunities, {}, eventsBySub, NOW);
    expect(recommendations.length).toBeGreaterThan(0);
    for (const rec of recommendations) {
      const text = (rec.title + " " + rec.description).toLowerCase();
      for (const banned of bannedWords) {
        expect(text).not.toContain(banned);
      }
    }
  });

  it("potentialAnnualSavings is null when amount is unknown", () => {
    const sub = makeSub({ amount: null });
    const opportunity = makeOpportunity(sub.id, { classification: "insufficient_data", annualCost: null, potentialAnnualSavings: null });
    const { recommendations } = generateRecommendations([sub], [opportunity], {}, {}, NOW);
    expect(recommendations[0].potentialAnnualSavings).toBeNull();
  });
});

describe("Phase 3C.4: structural guarantees", () => {
  it("evidence array always has at least 1 entry for every generated recommendation", () => {
    const sub = makeSub({ subscriptionStatus: "past_due" });
    const { recommendations } = generateRecommendations([sub], [], {}, {}, NOW);
    expect(recommendations[0].evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("recommendation id is deterministic: same input produces the same id", () => {
    const sub = makeSub({ subscriptionStatus: "past_due", id: "fixed-id" });
    const r1 = generateRecommendations([sub], [], {}, {}, NOW).recommendations[0];
    const r2 = generateRecommendations([sub], [], {}, {}, NOW).recommendations[0];
    expect(r1.id).toBe(r2.id);
    expect(r1.id).toBe("fixed-id-REVIEW_PAST_DUE");
  });

  it("is idempotent: identical inputs produce identical output", () => {
    const sub = makeSub({ subscriptionStatus: "past_due", nextBillingDate: "2026-08-25" });
    const events = { [sub.id]: [makeEvent(sub.id, { eventType: "payment_failed" })] };
    const r1 = generateRecommendations([sub], [], {}, events, NOW);
    const r2 = generateRecommendations([sub], [], {}, events, NOW);
    expect(r2).toEqual(r1);
  });

  it("cancelled and expired subscriptions are excluded from recommendations entirely", () => {
    const canceled = makeSub({ subscriptionStatus: "canceled", amount: null }); // amount=null would otherwise trigger CONFIRM_AMOUNT
    const expired = makeSub({ subscriptionStatus: "expired", lastPriceChangeType: "increase" });
    const active = makeSub({ subscriptionStatus: "past_due" });
    const { recommendations } = generateRecommendations([canceled, expired, active], [], {}, {}, NOW);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].subscriptionId).toBe(active.id);
  });

  it("processing multiple users' subscriptions together never bleeds facts across subscriptions", () => {
    const userASub = makeSub({ userId: "user-a", id: "sub-a", subscriptionStatus: "past_due" });
    const userBSub = makeSub({ userId: "user-b", id: "sub-b", subscriptionStatus: "active", amount: "19.99" });
    const events = { "sub-a": [makeEvent("sub-a", { userId: "user-a", eventType: "payment_failed" })] };
    const { recommendations } = generateRecommendations([userASub, userBSub], [], {}, events, NOW);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].subscriptionId).toBe("sub-a");
  });
});
