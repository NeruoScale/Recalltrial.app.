import { describe, it, expect } from "vitest";
import { calculateRenewalCalendar } from "./renewalCalendar";
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
    amount: "10.00",
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
    promotionEvidence: "resolutionMethod=domain_match",
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  } as ShadowSubscription;
}

const NOW = new Date("2026-08-19T12:00:00.000Z"); // midday UTC, avoids incidental midnight edge cases

describe("Phase 3B.9.4: date windows", () => {
  it("subscription due in 15 days appears in the 30-day view", () => {
    const sub = makeSub({ nextBillingDate: "2026-09-03" }); // 15 days out
    const result = calculateRenewalCalendar([sub], 30, "UTC", NOW);
    expect(result.upcomingRenewals).toHaveLength(1);
  });

  it("subscription due in 45 days appears in the 90-day view but NOT the 30-day view", () => {
    const sub = makeSub({ nextBillingDate: "2026-10-03" }); // 45 days out
    expect(calculateRenewalCalendar([sub], 30, "UTC", NOW).upcomingRenewals).toHaveLength(0);
    expect(calculateRenewalCalendar([sub], 90, "UTC", NOW).upcomingRenewals).toHaveLength(1);
  });

  it("subscription due in 100 days appears in neither view", () => {
    const sub = makeSub({ nextBillingDate: "2026-11-27" }); // 100 days out
    expect(calculateRenewalCalendar([sub], 30, "UTC", NOW).upcomingRenewals).toHaveLength(0);
    expect(calculateRenewalCalendar([sub], 90, "UTC", NOW).upcomingRenewals).toHaveLength(0);
  });
});

describe("Phase 3B.9.4: unknown data", () => {
  it("nextBillingDate=null -> unknownDateSubscriptions, NOT upcomingRenewals", () => {
    const sub = makeSub({ nextBillingDate: null });
    const result = calculateRenewalCalendar([sub], 30, "UTC", NOW);
    expect(result.upcomingRenewals).toHaveLength(0);
    expect(result.unknownDateSubscriptions).toHaveLength(1);
    expect(result.unknownDateSubscriptions[0].merchant).toBe(sub.canonicalMerchantName);
  });

  it("amount=null -> amountKnown=false, excluded from byCurrency totals", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-25", amount: null });
    const result = calculateRenewalCalendar([sub], 30, "UTC", NOW);
    expect(result.upcomingRenewals[0].amountKnown).toBe(false);
    expect(result.upcomingRenewals[0].amount).toBeNull();
    expect(result.upcomingSummary.byCurrency).toEqual({});
    expect(result.upcomingSummary.unknownAmountCount).toBe(1);
    expect(result.upcomingSummary.knownChargeCount).toBe(0);
  });

  it("billingInterval=null -> intervalKnown=false, still appears in calendar (date-driven, not interval-driven)", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-25", billingInterval: null, billingIntervalSource: null });
    const result = calculateRenewalCalendar([sub], 30, "UTC", NOW);
    expect(result.upcomingRenewals).toHaveLength(1);
    expect(result.upcomingRenewals[0].intervalKnown).toBe(false);
    expect(result.upcomingRenewals[0].billingInterval).toBeNull();
  });
});

describe("Phase 3B.9.4: status rules", () => {
  it("active is included", () => {
    const sub = makeSub({ subscriptionStatus: "active", nextBillingDate: "2026-08-25" });
    expect(calculateRenewalCalendar([sub], 30, "UTC", NOW).upcomingRenewals).toHaveLength(1);
  });

  it("trial is included", () => {
    const sub = makeSub({ subscriptionStatus: "trial", nextBillingDate: "2026-08-25" });
    expect(calculateRenewalCalendar([sub], 30, "UTC", NOW).upcomingRenewals).toHaveLength(1);
  });

  it("past_due is included with isPastDue=true, even with a FUTURE nextBillingDate", () => {
    // Mirrors real production data: a past_due subscription's nextBillingDate
    // is the NEXT attempt date, which is very often still in the future.
    const sub = makeSub({ subscriptionStatus: "past_due", nextBillingDate: "2026-09-15" });
    const result = calculateRenewalCalendar([sub], 30, "UTC", NOW);
    expect(result.upcomingRenewals).toHaveLength(1);
    expect(result.upcomingRenewals[0].isPastDue).toBe(true);
  });

  it("cancelled is excluded", () => {
    const sub = makeSub({ subscriptionStatus: "canceled", nextBillingDate: "2026-08-25" });
    expect(calculateRenewalCalendar([sub], 30, "UTC", NOW).upcomingRenewals).toHaveLength(0);
  });

  it("expired is excluded", () => {
    const sub = makeSub({ subscriptionStatus: "expired", nextBillingDate: "2026-08-25" });
    expect(calculateRenewalCalendar([sub], 30, "UTC", NOW).upcomingRenewals).toHaveLength(0);
  });
});

describe("Phase 3B.9.4: past dates", () => {
  it("nextBillingDate in the past -> not shown as an upcoming charge at all", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-01", subscriptionStatus: "active" }); // before NOW
    const result = calculateRenewalCalendar([sub], 30, "UTC", NOW);
    expect(result.upcomingRenewals).toHaveLength(0);
    expect(result.unknownDateSubscriptions).toHaveLength(0); // it HAS a date, just a past one -- not "unknown" either
  });

  it("a date exactly today is included (0 days out), not treated as past", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-19" }); // same as NOW's UTC date
    const result = calculateRenewalCalendar([sub], 30, "UTC", NOW);
    expect(result.upcomingRenewals).toHaveLength(1);
  });
});

describe("Phase 3B.9.4: financial rules", () => {
  it("multiple currencies are never combined", () => {
    const subs = [
      makeSub({ nextBillingDate: "2026-08-25", amount: "10.00", currency: "USD" }),
      makeSub({ nextBillingDate: "2026-08-26", amount: "8.00", currency: "EUR" }),
    ];
    const result = calculateRenewalCalendar(subs, 30, "UTC", NOW);
    expect(result.upcomingSummary.byCurrency).toEqual({ USD: 10, EUR: 8 });
  });

  it("known amounts are correctly summed per currency", () => {
    const subs = [
      makeSub({ nextBillingDate: "2026-08-25", amount: "10.00", currency: "USD" }),
      makeSub({ nextBillingDate: "2026-08-26", amount: "15.50", currency: "USD" }),
    ];
    const result = calculateRenewalCalendar(subs, 30, "UTC", NOW);
    expect(result.upcomingSummary.byCurrency.USD).toBe(25.5);
    expect(result.upcomingSummary.knownChargeCount).toBe(2);
  });

  it("unknown amounts are counted in unknownAmountCount, never contribute to a total", () => {
    const subs = [
      makeSub({ nextBillingDate: "2026-08-25", amount: "10.00", currency: "USD" }),
      makeSub({ nextBillingDate: "2026-08-26", amount: null }),
    ];
    const result = calculateRenewalCalendar(subs, 30, "UTC", NOW);
    expect(result.upcomingSummary.byCurrency.USD).toBe(10);
    expect(result.upcomingSummary.unknownAmountCount).toBe(1);
    expect(result.upcomingSummary.knownChargeCount).toBe(1);
  });
});

describe("Phase 3B.9.4: timezone handling", () => {
  it("a date near midnight in a UTC+ timezone (Asia/Qatar, +3h) resolves to the correct local day", () => {
    // 21:00 UTC on Aug 18 = local midnight Aug 19 in Qatar.
    const nowAtQatarMidnight = new Date("2026-08-18T21:00:00.000Z");
    const sub = makeSub({ nextBillingDate: "2026-08-19" }); // "today" in Qatar
    const result = calculateRenewalCalendar([sub], 30, "Asia/Qatar", nowAtQatarMidnight);
    expect(result.upcomingRenewals).toHaveLength(1); // included, not treated as past
  });

  it("a date near midnight in a UTC- timezone (America/Los_Angeles, -7h) resolves to the correct local day", () => {
    // 07:00 UTC on Aug 19 = local midnight Aug 19 in LA (PDT).
    const nowAtLaMidnight = new Date("2026-08-19T07:00:00.000Z");
    const sub = makeSub({ nextBillingDate: "2026-08-19" });
    const result = calculateRenewalCalendar([sub], 30, "America/Los_Angeles", nowAtLaMidnight);
    expect(result.upcomingRenewals).toHaveLength(1);
  });

  it("month boundary is handled correctly (window spanning Aug -> Sep)", () => {
    const sub = makeSub({ nextBillingDate: "2026-09-01" }); // 13 days from Aug 19
    const result = calculateRenewalCalendar([sub], 30, "UTC", NOW);
    expect(result.upcomingRenewals).toHaveLength(1);
  });

  it("year boundary is handled correctly (window spanning Dec -> Jan)", () => {
    const decNow = new Date("2026-12-20T12:00:00.000Z");
    const sub = makeSub({ nextBillingDate: "2027-01-10" }); // 21 days out, crosses year boundary
    const result = calculateRenewalCalendar([sub], 30, "UTC", decNow);
    expect(result.upcomingRenewals).toHaveLength(1);
  });
});

describe("Phase 3B.9.4: user isolation", () => {
  it("subscriptions belonging to a different user never appear — caller is responsible for scoping", () => {
    const subs = [
      makeSub({ userId: "user-A", canonicalMerchantName: "A-Service", nextBillingDate: "2026-08-25" }),
    ];
    const result = calculateRenewalCalendar(subs, 30, "UTC", NOW);
    expect(result.upcomingRenewals).toHaveLength(1);
    expect(result.upcomingRenewals[0].merchant).toBe("A-Service");
  });
});

describe("Phase 3B.9.4: idempotency", () => {
  it("calling twice with the same input returns an identical result", () => {
    const subs = [
      makeSub({ nextBillingDate: "2026-08-25", amount: "10.00", currency: "USD" }),
      makeSub({ nextBillingDate: null }),
    ];
    const a = calculateRenewalCalendar(subs, 30, "UTC", NOW);
    const b = calculateRenewalCalendar(subs, 30, "UTC", NOW);
    expect(a).toEqual(b);
  });
});

describe("Phase 3B.9.4: strict boundaries", () => {
  it("does not project future recurring occurrences beyond the single stored nextBillingDate", () => {
    const sub = makeSub({ nextBillingDate: "2026-08-25", billingInterval: "monthly" });
    const result = calculateRenewalCalendar([sub], 90, "UTC", NOW);
    // Only ONE entry — never Sep 25, Oct 25 projected from the monthly interval.
    expect(result.upcomingRenewals).toHaveLength(1);
    expect(result.upcomingRenewals[0].dueDate).toBe("2026-08-25");
  });
});
