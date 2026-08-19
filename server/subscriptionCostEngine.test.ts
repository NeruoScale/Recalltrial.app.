import { describe, it, expect } from "vitest";
import { calculateSubscriptionCosts, calculateUpcomingCharges } from "./subscriptionCostEngine";
import type { ShadowSubscription } from "@shared/schema";

let idCounter = 0;
function makeSub(overrides: Partial<ShadowSubscription> = {}): ShadowSubscription {
  idCounter++;
  return {
    id: `sub-${idCounter}`,
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

describe("Phase 3B.9.1: billing interval normalization", () => {
  it("monthly: monthly cost = amount, annual = amount x 12", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "19.99", billingInterval: "monthly" })]).subscriptions;
    expect(sub.monthlyCost).toBe(19.99);
    expect(sub.annualCost).toBeCloseTo(239.88, 5);
  });

  it("quarterly: monthly = amount/3 (rounded), annual = amount x 4", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "9.99", billingInterval: "quarterly" })]).subscriptions;
    expect(sub.monthlyCost).toBeCloseTo(3.33, 5);
    expect(sub.annualCost).toBeCloseTo(39.96, 5);
  });

  it("semi_annual: monthly = amount/6, annual = amount x 2", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "60.00", billingInterval: "semi_annual" })]).subscriptions;
    expect(sub.monthlyCost).toBeCloseTo(10.0, 5);
    expect(sub.annualCost).toBeCloseTo(120.0, 5);
  });

  it("annual: monthly = amount/12, annual = amount itself", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "139.00", billingInterval: "annual" })]).subscriptions;
    expect(sub.monthlyCost).toBeCloseTo(11.58, 5);
    expect(sub.annualCost).toBe(139);
  });

  it("weekly: monthly = amount x 52/12, annual = amount x 52", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "5.00", billingInterval: "weekly" })]).subscriptions;
    expect(sub.monthlyCost).toBeCloseTo(21.67, 5); // 5*52/12 = 21.6666... -> rounds to 21.67
    expect(sub.annualCost).toBeCloseTo(260.0, 5);
  });

  it("biweekly: monthly = amount x 26/12, annual = amount x 26", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "10.00", billingInterval: "biweekly" })]).subscriptions;
    expect(sub.monthlyCost).toBeCloseTo(21.67, 5); // 10*26/12 = 21.6666... -> rounds to 21.67
    expect(sub.annualCost).toBeCloseTo(260.0, 5);
  });
});

describe("Phase 3B.9.1: precision — exact examples from the spec", () => {
  it("$139 annual -> $11.58/month exactly", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "139.00", billingInterval: "annual" })]).subscriptions;
    expect(sub.monthlyCost).toBe(11.58);
  });

  it("$9.99 quarterly -> monthly and annual computed without float drift", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "9.99", billingInterval: "quarterly" })]).subscriptions;
    expect(sub.monthlyCost).toBe(3.33);
    expect(sub.annualCost).toBe(39.96);
  });

  it("$19.99 monthly -> exact, no rounding needed", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "19.99", billingInterval: "monthly" })]).subscriptions;
    expect(sub.monthlyCost).toBe(19.99);
    expect(sub.annualCost).toBe(239.88);
  });
});

describe("Phase 3B.9.1: edge cases", () => {
  it("$0 amount is a valid charge, not treated as missing", () => {
    const result = calculateSubscriptionCosts("user-1", [makeSub({ amount: "0.00", billingInterval: "monthly" })]);
    expect(result.subscriptions[0].monthlyCost).toBe(0);
    expect(result.summary.incompleteBillingCount).toBe(0);
    expect(result.summary.monthlyRecurringCost).toBe(0);
  });

  it("null amount -> monthlyCost/annualCost are null, never $0, counted in incompleteBillingCount", () => {
    const result = calculateSubscriptionCosts("user-1", [makeSub({ amount: null, billingInterval: "monthly" })]);
    expect(result.subscriptions[0].monthlyCost).toBeNull();
    expect(result.subscriptions[0].annualCost).toBeNull();
    expect(result.summary.incompleteBillingCount).toBe(1);
    expect(result.summary.monthlyRecurringCost).toBeNull();
  });

  it("null billingInterval -> excluded from totals, counted in unknownCostCount (amount IS known)", () => {
    const result = calculateSubscriptionCosts("user-1", [makeSub({ amount: "19.99", billingInterval: null })]);
    expect(result.subscriptions[0].monthlyCost).toBeNull();
    expect(result.summary.unknownCostCount).toBe(1);
    expect(result.summary.incompleteBillingCount).toBe(0);
  });

  it("billingInterval='unknown' -> excluded from totals, counted in unknownCostCount", () => {
    const result = calculateSubscriptionCosts("user-1", [makeSub({ amount: "19.99", billingInterval: "unknown" })]);
    expect(result.subscriptions[0].monthlyCost).toBeNull();
    expect(result.summary.unknownCostCount).toBe(1);
  });

  it("billingInterval='one_time' -> excluded from all totals", () => {
    const result = calculateSubscriptionCosts("user-1", [makeSub({ amount: "49.99", billingInterval: "one_time" })]);
    expect(result.subscriptions[0].monthlyCost).toBeNull();
    expect(result.subscriptions[0].annualCost).toBeNull();
    expect(result.summary.monthlyRecurringCost).toBeNull();
  });

  it("negative amount is treated as invalid, never a negative total", () => {
    const result = calculateSubscriptionCosts("user-1", [makeSub({ amount: "-19.99", billingInterval: "monthly" })]);
    expect(result.subscriptions[0].monthlyCost).toBeNull();
    expect(result.summary.incompleteBillingCount).toBe(1);
  });

  it("malformed amount string is treated as invalid/missing", () => {
    const result = calculateSubscriptionCosts("user-1", [makeSub({ amount: "not-a-number", billingInterval: "monthly" })]);
    expect(result.subscriptions[0].monthlyCost).toBeNull();
    expect(result.summary.incompleteBillingCount).toBe(1);
  });

  it("very large amount computes correctly with no precision loss", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ amount: "999999.99", billingInterval: "annual" })]).subscriptions;
    expect(sub.annualCost).toBe(999999.99);
    expect(sub.monthlyCost).toBeCloseTo(83333.33, 5);
  });
});

describe("Phase 3B.9.1: status eligibility", () => {
  it("active, trial, past_due are included in totals", () => {
    const subs = [
      makeSub({ subscriptionStatus: "active", amount: "10.00", billingInterval: "monthly" }),
      makeSub({ subscriptionStatus: "trial", amount: "10.00", billingInterval: "monthly" }),
      makeSub({ subscriptionStatus: "past_due", amount: "10.00", billingInterval: "monthly" }),
    ];
    const result = calculateSubscriptionCosts("user-1", subs);
    expect(result.summary.monthlyRecurringCost).toBe(30);
    expect(result.summary.activeSubscriptions).toBe(3);
  });

  it("cancelled and expired are excluded from totals but still get a per-subscription cost", () => {
    const subs = [
      makeSub({ subscriptionStatus: "canceled", amount: "10.00", billingInterval: "monthly" }),
      makeSub({ subscriptionStatus: "expired", amount: "10.00", billingInterval: "monthly" }),
    ];
    const result = calculateSubscriptionCosts("user-1", subs);
    expect(result.summary.monthlyRecurringCost).toBeNull();
    expect(result.summary.activeSubscriptions).toBe(0);
    expect(result.summary.totalSubscriptions).toBe(2);
    // Historical cost still shown on the individual subscription
    expect(result.subscriptions[0].monthlyCost).toBe(10);
    expect(result.subscriptions[1].monthlyCost).toBe(10);
  });
});

describe("Phase 3B.9.1: currency handling — never combined", () => {
  it("groups totals by currency separately", () => {
    const subs = [
      makeSub({ amount: "10.00", currency: "USD", billingInterval: "monthly" }),
      makeSub({ amount: "8.00", currency: "EUR", billingInterval: "monthly" }),
      makeSub({ amount: "7.00", currency: "GBP", billingInterval: "monthly" }),
    ];
    const result = calculateSubscriptionCosts("user-1", subs);
    expect(result.summary.byCurrency.USD).toEqual({ monthly: 10, annual: 120 });
    expect(result.summary.byCurrency.EUR).toEqual({ monthly: 8, annual: 96 });
    expect(result.summary.byCurrency.GBP).toEqual({ monthly: 7, annual: 84 });
  });

  it("multiple currencies present -> top-level monthlyRecurringCost/annualRecurringCost are null (never a blended sum), byCurrency stays authoritative", () => {
    const subs = [
      makeSub({ amount: "10.00", currency: "USD", billingInterval: "monthly" }),
      makeSub({ amount: "10.00", currency: "EUR", billingInterval: "monthly" }),
    ];
    const result = calculateSubscriptionCosts("user-1", subs);
    expect(result.summary.monthlyRecurringCost).toBeNull();
    expect(result.summary.annualRecurringCost).toBeNull();
    expect(Object.keys(result.summary.byCurrency).sort()).toEqual(["EUR", "USD"]);
    expect(result.summary.byCurrency.USD.monthly).toBe(10);
    expect(result.summary.byCurrency.EUR.monthly).toBe(10);
  });

  it("exactly one currency -> top-level monthlyRecurringCost/annualRecurringCost mirror that currency's byCurrency entry", () => {
    const subs = [
      makeSub({ amount: "10.00", currency: "USD", billingInterval: "monthly" }),
      makeSub({ amount: "15.00", currency: "USD", billingInterval: "monthly" }),
    ];
    const result = calculateSubscriptionCosts("user-1", subs);
    expect(result.summary.monthlyRecurringCost).toBe(25);
    expect(result.summary.byCurrency.USD.monthly).toBe(25);
  });
});

describe("Phase 3B.9.1: user isolation", () => {
  it("subscriptions belonging to a different userId never appear in the result, even if passed in", () => {
    const subs = [
      makeSub({ userId: "user-A", canonicalMerchantName: "A-Service", amount: "10.00", billingInterval: "monthly" }),
      makeSub({ userId: "user-B", canonicalMerchantName: "B-Service", amount: "20.00", billingInterval: "monthly" }),
    ];
    const resultA = calculateSubscriptionCosts("user-A", subs);
    expect(resultA.subscriptions).toHaveLength(1);
    expect(resultA.subscriptions[0].canonicalMerchantName).toBe("A-Service");
    expect(resultA.summary.monthlyRecurringCost).toBe(10);

    const resultB = calculateSubscriptionCosts("user-B", subs);
    expect(resultB.subscriptions).toHaveLength(1);
    expect(resultB.subscriptions[0].canonicalMerchantName).toBe("B-Service");
    expect(resultB.summary.monthlyRecurringCost).toBe(20);
  });
});

describe("Phase 3B.9.1: no event-level double counting", () => {
  it("a single subscription row contributes exactly one cost line, regardless of how many events fed it", () => {
    // The engine only ever sees `subscriptions` rows (already deduplicated
    // by entity resolution long before this engine runs) — this test locks
    // in that 1 row = 1 contribution, simulating what would happen if 7
    // Anthropic events had all resolved to the same subscription (which is
    // exactly what entity resolution guarantees: one row per real-world
    // subscription no matter how many source events corroborate it).
    const anthropicSubscription = makeSub({
      canonicalMerchantName: "Anthropic",
      amount: "20.00",
      billingInterval: "monthly",
      sourceCanonicalEventId: "evt-most-recent-of-7",
    });
    const result = calculateSubscriptionCosts("user-1", [anthropicSubscription]);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.summary.totalSubscriptions).toBe(1);
    expect(result.summary.monthlyRecurringCost).toBe(20);
  });
});

describe("Phase 3B.9.1: cost confidence", () => {
  it("high merchantConfidence -> High", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ merchantConfidence: 90 })]).subscriptions;
    expect(sub.costConfidence).toBe("High");
  });

  it("medium merchantConfidence -> Medium", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ merchantConfidence: 50 })]).subscriptions;
    expect(sub.costConfidence).toBe("Medium");
  });

  it("low/null merchantConfidence -> Low", () => {
    const [sub] = calculateSubscriptionCosts("user-1", [makeSub({ merchantConfidence: null })]).subscriptions;
    expect(sub.costConfidence).toBe("Low");
  });
});

describe("Phase 3B.9.1: strict boundaries — nothing beyond cost normalization", () => {
  it("does not mutate or drop any existing field from the subscription row", () => {
    const sub = makeSub({ canonicalMerchantDomain: "anthropic.com" });
    const [result] = calculateSubscriptionCosts("user-1", [sub]).subscriptions;
    expect(result.id).toBe(sub.id);
    expect(result.canonicalMerchantDomain).toBe("anthropic.com");
    expect(result.resolutionStatus).toBe(sub.resolutionStatus);
  });
});

describe("Phase 3B.9.2B: calculateUpcomingCharges()", () => {
  const NOW = new Date("2026-08-19T00:00:00.000Z");

  it("includes a charge within the 7-day window", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-24", subscriptionStatus: "active" }); // 5 days out
    const result = calculateUpcomingCharges([sub], 7, NOW);
    expect(result.charges).toHaveLength(1);
    expect(result.charges[0].dueDate).toBe("2026-08-24");
    expect(result.summary.days).toBe(7);
  });

  it("excludes a charge outside the 7-day window but includes it within 30", () => {
    const sub = makeSub({ nextBillingDate: "2026-09-05", subscriptionStatus: "active" }); // 17 days out
    expect(calculateUpcomingCharges([sub], 7, NOW).charges).toHaveLength(0);
    expect(calculateUpcomingCharges([sub], 30, NOW).charges).toHaveLength(1);
  });

  it("includes a charge within the 90-day window that's outside 30", () => {
    const sub = makeSub({ nextBillingDate: "2026-11-01", subscriptionStatus: "active" }); // ~74 days out
    expect(calculateUpcomingCharges([sub], 30, NOW).charges).toHaveLength(0);
    expect(calculateUpcomingCharges([sub], 90, NOW).charges).toHaveLength(1);
  });

  it("cancelled and expired subscriptions are excluded even with a near-term nextBillingDate", () => {
    const subs = [
      makeSub({ nextBillingDate: "2026-08-25", subscriptionStatus: "canceled" }),
      makeSub({ nextBillingDate: "2026-08-25", subscriptionStatus: "expired" }),
    ];
    const result = calculateUpcomingCharges(subs, 30, NOW);
    expect(result.charges).toHaveLength(0);
  });

  it("null amount is shown honestly (date + merchant, amount null) — never invented", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-25", amount: null, subscriptionStatus: "active" });
    const result = calculateUpcomingCharges([sub], 30, NOW);
    expect(result.charges).toHaveLength(1);
    expect(result.charges[0].amount).toBeNull();
    expect(result.charges[0].merchant).toBe(sub.canonicalMerchantName);
    expect(result.charges[0].dueDate).toBe("2026-08-25");
    // Doesn't contribute to any currency total since there's nothing to sum
    expect(result.summary.byCurrency).toEqual({});
  });

  it("multiple currencies are never combined in the summary total", () => {
    const subs = [
      makeSub({ nextBillingDate: "2026-08-25", amount: "10.00", currency: "USD", subscriptionStatus: "active" }),
      makeSub({ nextBillingDate: "2026-08-26", amount: "8.00", currency: "EUR", subscriptionStatus: "active" }),
    ];
    const result = calculateUpcomingCharges(subs, 30, NOW);
    expect(result.summary.byCurrency).toEqual({ USD: 10, EUR: 8 });
  });

  it("user isolation: only subscriptions actually passed in ever appear — caller is responsible for scoping", () => {
    const userASubs = [makeSub({ userId: "user-A", canonicalMerchantName: "A-Service", nextBillingDate: "2026-08-25", subscriptionStatus: "active" })];
    const result = calculateUpcomingCharges(userASubs, 30, NOW);
    expect(result.charges).toHaveLength(1);
    expect(result.charges.every((c) => c.merchant === "A-Service")).toBe(true);
  });

  it("idempotent: calling twice with the same input returns the same result", () => {
    const subs = [makeSub({ nextBillingDate: "2026-08-25", amount: "10.00", currency: "USD", subscriptionStatus: "active" })];
    const a = calculateUpcomingCharges(subs, 30, NOW);
    const b = calculateUpcomingCharges(subs, 30, NOW);
    expect(a).toEqual(b);
  });

  it("no upcoming charges when nextBillingDate is null", () => {
    const sub = makeSub({ nextBillingDate: null, subscriptionStatus: "active" });
    const result = calculateUpcomingCharges([sub], 30, NOW);
    expect(result.charges).toHaveLength(0);
  });

  it("past_due is included only when its date is still genuinely in the future (not an already-missed date)", () => {
    const futureDated = makeSub({ nextBillingDate: "2026-08-25", subscriptionStatus: "past_due" });
    const overdue = makeSub({ nextBillingDate: "2026-08-01", subscriptionStatus: "past_due" }); // before NOW
    const result = calculateUpcomingCharges([futureDated, overdue], 30, NOW);
    expect(result.charges).toHaveLength(1);
    expect(result.charges[0].dueDate).toBe("2026-08-25");
  });

  it("trial status is included", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-25", subscriptionStatus: "trial" });
    const result = calculateUpcomingCharges([sub], 30, NOW);
    expect(result.charges).toHaveLength(1);
  });

  it("charges are sorted by dueDate ascending", () => {
    const subs = [
      makeSub({ nextBillingDate: "2026-09-01", canonicalMerchantName: "Later", subscriptionStatus: "active" }),
      makeSub({ nextBillingDate: "2026-08-20", canonicalMerchantName: "Sooner", subscriptionStatus: "active" }),
    ];
    const result = calculateUpcomingCharges(subs, 30, NOW);
    expect(result.charges.map((c) => c.merchant)).toEqual(["Sooner", "Later"]);
  });

  it("a due date exactly today is included (0 days out)", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-19", subscriptionStatus: "active" });
    const result = calculateUpcomingCharges([sub], 7, NOW);
    expect(result.charges).toHaveLength(1);
  });
});
