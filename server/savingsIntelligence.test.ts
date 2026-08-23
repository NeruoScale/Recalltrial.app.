import { describe, it, expect } from "vitest";
import { analyzeSavingsOpportunities } from "./savingsIntelligence";
import type { ShadowSubscription, SubscriptionEvent } from "@shared/schema";

// Phase 3C.2: this file covers everything analyzeSavingsOpportunities()
// itself is responsible for (dismissal filtering, userConfirmed/userDismissed
// pass-through). The mutations that WRITE those fields — storage.confirmSubscription(),
// dismissSubscription(), dismissSavingsOpportunity(), and GET /api/subscriptions'
// showDismissed filtering — are DB-atomicity/cross-user-isolation guarantees
// with no DB-integration test infrastructure in this codebase (every
// existing *.test.ts file tests a pure function only, same as
// server/aiCredits.test.ts's note on reserveCredit()/refundCredit()) —
// verified live against production instead, see the Phase 3C.2 deployment
// report for the live confirm/dismiss/cross-user results.

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

function events(subId: string, n: number, extra: Partial<SubscriptionEvent> = {}): Record<string, SubscriptionEvent[]> {
  return { [subId]: Array.from({ length: n }, () => makeEvent(subId, extra)) };
}

const NOW = new Date("2026-08-22T00:00:00.000Z");

describe("Phase 3C.1: classification", () => {
  it("active + high cost + payment failure -> potential_savings (score >= 50)", () => {
    const sub = makeSub({ subscriptionStatus: "active", amount: "25.00" }); // $300/yr -> 30pts
    const evs = [
      ...Array.from({ length: 5 }, () => makeEvent(sub.id)),
      makeEvent(sub.id, { eventType: "payment_failed" }), // +20pts
    ];
    const { opportunities } = analyzeSavingsOpportunities([sub], { [sub.id]: evs }, {}, NOW);
    expect(opportunities[0].score).toBeGreaterThanOrEqual(50);
    expect(opportunities[0].classification).toBe("potential_savings");
  });

  it("past_due scores higher than an otherwise-identical active subscription (+15)", () => {
    const active = makeSub({ subscriptionStatus: "active" });
    const pastDue = makeSub({ subscriptionStatus: "past_due" });
    const evs = { [active.id]: [makeEvent(active.id)], [pastDue.id]: [makeEvent(pastDue.id)] };
    const { opportunities } = analyzeSavingsOpportunities([active, pastDue], evs, {}, NOW);
    const activeScore = opportunities.find((o) => o.subscriptionId === active.id)!.score;
    const pastDueScore = opportunities.find((o) => o.subscriptionId === pastDue.id)!.score;
    expect(pastDueScore).toBe(activeScore + 15);
  });

  it("payment failure evidence increases score by exactly 20", () => {
    const clean = makeSub();
    const failed = makeSub();
    const { opportunities } = analyzeSavingsOpportunities(
      [clean, failed],
      { [clean.id]: [makeEvent(clean.id)], [failed.id]: [makeEvent(failed.id), makeEvent(failed.id, { eventType: "payment_failed" })] },
      {},
      NOW
    );
    const cleanScore = opportunities.find((o) => o.subscriptionId === clean.id)!.score;
    const failedScore = opportunities.find((o) => o.subscriptionId === failed.id)!.score;
    expect(failedScore).toBe(cleanScore + 20);
  });

  it("a persisted price increase (lastPriceChangeType='increase') adds exactly 15 points", () => {
    const noIncrease = makeSub({ lastPriceChangeType: null });
    const increased = makeSub({ lastPriceChangeType: "increase" });
    const { opportunities } = analyzeSavingsOpportunities(
      [noIncrease, increased],
      { [noIncrease.id]: [makeEvent(noIncrease.id)], [increased.id]: [makeEvent(increased.id)] },
      {},
      NOW
    );
    const base = opportunities.find((o) => o.subscriptionId === noIncrease.id)!.score;
    const withIncrease = opportunities.find((o) => o.subscriptionId === increased.id)!.score;
    expect(withIncrease).toBe(base + 15);
  });

  it("unknown amount -> insufficient_data, excluded from currency totals", () => {
    const sub = makeSub({ amount: null, subscriptionStatus: "past_due" });
    const { opportunities, summary } = analyzeSavingsOpportunities([sub], events(sub.id, 1, { eventType: "payment_failed" }), {}, NOW);
    expect(opportunities[0].classification).toBe("insufficient_data");
    expect(opportunities[0].currency).toBeNull();
    expect(summary.byCurrency).toEqual({});
  });

  it("unknown billing interval -> insufficient_data", () => {
    const sub = makeSub({ billingInterval: null });
    const { opportunities } = analyzeSavingsOpportunities([sub], events(sub.id, 1), {}, NOW);
    expect(opportunities[0].classification).toBe("insufficient_data");
  });

  it("multiple currencies are never combined into a single summary total", () => {
    const usd = makeSub({ amount: "300.00", currency: "USD" }); // 30pts alone
    const eur = makeSub({ amount: "300.00", currency: "EUR" });
    const evs = {
      [usd.id]: [makeEvent(usd.id, { eventType: "payment_failed" })], // +20 = 50 -> potential_savings
      [eur.id]: [makeEvent(eur.id, { eventType: "payment_failed" })],
    };
    const { summary } = analyzeSavingsOpportunities([usd, eur], evs, {}, NOW);
    expect(summary.potentialMonthlySavings).toBeNull();
    expect(summary.potentialAnnualSavings).toBeNull();
    expect(summary.byCurrency.USD).toBeDefined();
    expect(summary.byCurrency.EUR).toBeDefined();
  });

  it("zero known cost yields the lowest cost score (essential, absent other risk signals)", () => {
    const sub = makeSub({ amount: "0.00" });
    const { opportunities } = analyzeSavingsOpportunities([sub], events(sub.id, 5), {}, NOW);
    expect(opportunities[0].classification).toBe("essential");
    expect(opportunities[0].score).toBeLessThan(25);
  });

  it("a single-event subscription reflects uncertainty via the low-event-count score bonus and low confidence", () => {
    const sub = makeSub();
    const { opportunities } = analyzeSavingsOpportunities([sub], events(sub.id, 1), {}, NOW);
    expect(opportunities[0].evidenceCount).toBe(1);
    expect(opportunities[0].confidence).toBe("low");
  });

  it("canceled and expired subscriptions are excluded from opportunities entirely", () => {
    const canceled = makeSub({ subscriptionStatus: "canceled" });
    const expired = makeSub({ subscriptionStatus: "expired" });
    const active = makeSub({ subscriptionStatus: "active" });
    const { opportunities } = analyzeSavingsOpportunities(
      [canceled, expired, active],
      { [active.id]: [makeEvent(active.id)] },
      {},
      NOW
    );
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].subscriptionId).toBe(active.id);
  });

  it("score is never below 0 or above 100", () => {
    const worst = makeSub({
      amount: "500.00",
      subscriptionStatus: "past_due",
      lastPriceChangeType: "increase",
      nextBillingDate: "2026-08-25",
    });
    const best = makeSub({ amount: "5.00" });
    const { opportunities } = analyzeSavingsOpportunities(
      [worst, best],
      { [worst.id]: [makeEvent(worst.id, { eventType: "payment_failed" })], [best.id]: Array.from({ length: 5 }, () => makeEvent(best.id)) },
      {},
      NOW
    );
    for (const o of opportunities) {
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(100);
    }
  });

  it("exact cent arithmetic: $19.99/mo = $239.88/yr exactly, passed through unchanged", () => {
    const sub = makeSub({ amount: "19.99", billingInterval: "monthly" });
    const { opportunities } = analyzeSavingsOpportunities([sub], events(sub.id, 3), {}, NOW);
    expect(opportunities[0].annualCost).toBe(239.88);
  });
});

describe("Phase 3C.1: cross-user isolation and purity", () => {
  it("events for one subscription never leak into another subscription's evidence, even across different users", () => {
    const subA = makeSub({ userId: "user-a", id: "sub-a" });
    const subB = makeSub({ userId: "user-b", id: "sub-b" });
    const evs = {
      "sub-a": [makeEvent("sub-a", { userId: "user-a", eventType: "payment_failed" })],
      "sub-b": [makeEvent("sub-b", { userId: "user-b" })],
    };
    const { opportunities } = analyzeSavingsOpportunities([subA, subB], evs, {}, NOW);
    const a = opportunities.find((o) => o.subscriptionId === "sub-a")!;
    const b = opportunities.find((o) => o.subscriptionId === "sub-b")!;
    expect(a.evidenceCount).toBe(1);
    expect(b.evidenceCount).toBe(1);
    expect(a.score).toBeGreaterThan(b.score); // only A has the payment failure
  });

  it("is idempotent: calling twice with identical inputs produces identical output", () => {
    const sub = makeSub({ subscriptionStatus: "past_due", lastPriceChangeType: "increase" });
    const evs = events(sub.id, 4, { eventType: "payment_failed" });
    const first = analyzeSavingsOpportunities([sub], evs, {}, NOW);
    const second = analyzeSavingsOpportunities([sub], evs, {}, NOW);
    expect(second).toEqual(first);
  });
});

describe("Phase 3C.2: dismissal and tracking pass-through", () => {
  it("a dismissed subscription id is excluded from opportunities entirely", () => {
    const kept = makeSub();
    const dismissed = makeSub();
    const { opportunities } = analyzeSavingsOpportunities(
      [kept, dismissed],
      { [kept.id]: [makeEvent(kept.id)], [dismissed.id]: [makeEvent(dismissed.id)] },
      {},
      NOW,
      [dismissed.id]
    );
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].subscriptionId).toBe(kept.id);
  });

  it("userConfirmed and userDismissed pass through from the subscription row unchanged", () => {
    const confirmed = makeSub({ userConfirmed: true, userConfirmedAt: new Date("2026-08-20T00:00:00.000Z") });
    const untouched = makeSub();
    const { opportunities } = analyzeSavingsOpportunities(
      [confirmed, untouched],
      { [confirmed.id]: [makeEvent(confirmed.id)], [untouched.id]: [makeEvent(untouched.id)] },
      {},
      NOW
    );
    expect(opportunities.find((o) => o.subscriptionId === confirmed.id)!.userConfirmed).toBe(true);
    expect(opportunities.find((o) => o.subscriptionId === untouched.id)!.userConfirmed).toBe(false);
  });
});

describe("Phase 3C.1: language rules", () => {
  it("reasons never contain 'unused' or \"don't use\" style phrasing", () => {
    const sub = makeSub({ amount: null, subscriptionStatus: "past_due" });
    const { opportunities } = analyzeSavingsOpportunities([sub], {}, {}, NOW);
    const joined = opportunities[0].reasons.join(" ").toLowerCase();
    expect(joined).not.toContain("unused");
    expect(joined).not.toContain("don't use");
    expect(joined).not.toContain("don't need");
  });

  it("potential savings are never phrased as guaranteed", () => {
    const sub = makeSub({ amount: "300.00" });
    const { opportunities } = analyzeSavingsOpportunities([sub], events(sub.id, 1, { eventType: "payment_failed" }), {}, NOW);
    const joined = opportunities[0].reasons.join(" ").toLowerCase();
    expect(joined).not.toContain("guarantee");
    expect(opportunities[0].potentialAnnualSavings).not.toBeNull();
  });

  it("zero recent events is reported as 'No recent subscription-related activity found', never as 'unused'", () => {
    const sub = makeSub();
    const { opportunities } = analyzeSavingsOpportunities([sub], {}, {}, NOW);
    expect(opportunities[0].reasons).toContain("No recent subscription-related activity found");
  });
});
