import { describe, it, expect } from "vitest";
import { decideReminderDeliveryAction } from "./reminderDelivery";
import { buildSubscriptionReminderEmail } from "./email";
import type { ShadowSubscription, SubscriptionReminder } from "@shared/schema";

let subIdCounter = 0;
function makeSub(overrides: Partial<ShadowSubscription> = {}): ShadowSubscription {
  subIdCounter++;
  return {
    id: `sub-${subIdCounter}`,
    userId: "user-U",
    entityKey: "anthropic.com",
    canonicalMerchantName: "Anthropic",
    canonicalMerchantDomain: "anthropic.com",
    merchantConfidence: 90,
    resolutionMethod: "domain_match",
    resolutionStatus: "resolved",
    planName: null,
    subscriptionStatus: "active",
    amount: "20.00",
    currency: "USD",
    billingInterval: "monthly",
    billingIntervalSource: "confirmed_email",
    billingIntervalConfidence: "high",
    nextBillingDate: "2026-08-22",
    lastBillingDate: null,
    sourceCanonicalEventId: "evt-original",
    isShadow: false,
    potentialFalseMerge: false,
    potentialFalseSplit: false,
    promotedAt: new Date("2026-08-01T00:00:00.000Z"),
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
    lastEventEmailConnectionId: null,
    crossAccountConflict: false,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as ShadowSubscription;
}

function makeReminder(overrides: Partial<SubscriptionReminder> = {}): SubscriptionReminder {
  return {
    id: "reminder-1",
    subscriptionId: "sub-1",
    userId: "user-U",
    remindAt: new Date("2026-08-19T00:00:00.000Z"),
    type: "THREE_DAYS",
    status: "PENDING",
    sentAt: null,
    provider: "resend",
    providerMessageId: null,
    lastError: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionReminder;
}

const NOW = new Date("2026-08-19T00:00:00.000Z");

describe("decideReminderDeliveryAction — Phase 4.2 delivery re-check", () => {
  it("Test 1/6/9: eligible + active connection -> attempt delivery", () => {
    const sub = makeSub();
    const result = decideReminderDeliveryAction(sub, true, NOW, "UTC");
    expect(result).toEqual({ action: "attempt" });
  });

  it("Test 7/8/10 (connection isolation): still eligible on paper, but isCurrentlyActive=false (owning connection disconnected, a different Gmail account is now active, or no active connection at all) -> skip, never attempt", () => {
    const sub = makeSub();
    const result = decideReminderDeliveryAction(sub, false, NOW, "UTC");
    expect(result).toEqual({ action: "skip", reason: "hidden by active Gmail connection isolation" });
  });

  it("Test 24/27: subscription became ineligible since the reminder was created (e.g. cancelled) -> skip, even if the owning connection is still active", () => {
    const sub = makeSub({ subscriptionStatus: "canceled" });
    const result = decideReminderDeliveryAction(sub, true, NOW, "UTC");
    expect(result.action).toBe("skip");
    if (result.action === "skip") expect(result.reason).toContain("no longer eligible");
  });

  it("Test 25: dismissed subscription -> skip even with a perfectly valid date and active connection", () => {
    const sub = makeSub({ userDismissed: true });
    const result = decideReminderDeliveryAction(sub, true, NOW, "UTC");
    expect(result).toEqual({ action: "skip", reason: "no longer eligible: subscription is user-dismissed" });
  });

  it("Test 26: renewal date became invalid/missing since the reminder was created -> skip", () => {
    const sub = makeSub({ nextBillingDate: null });
    const result = decideReminderDeliveryAction(sub, true, NOW, "UTC");
    expect(result.action).toBe("skip");
    if (result.action === "skip") expect(result.reason).toContain("nextBillingDate is missing");
  });

  it("eligibility is checked BEFORE connection isolation, but either failing alone is sufficient to skip (order does not change the outcome)", () => {
    const sub = makeSub({ userDismissed: true });
    const bothFail = decideReminderDeliveryAction(sub, false, NOW, "UTC");
    expect(bothFail.action).toBe("skip");
    // the eligibility reason wins when both would fail, since it's checked first
    if (bothFail.action === "skip") expect(bothFail.reason).toContain("user-dismissed");
  });

  it("determinism: identical inputs always produce the identical decision", () => {
    const sub = makeSub();
    const a = decideReminderDeliveryAction(sub, true, NOW, "UTC");
    const b = decideReminderDeliveryAction(sub, true, NOW, "UTC");
    expect(a).toEqual(b);
  });
});

describe("buildSubscriptionReminderEmail — Phase 4.2 email content, no fabricated data", () => {
  it("Test 19/22/23: known amount, correct renewal date, correct merchant name all appear", () => {
    const reminder = makeReminder({ type: "THREE_DAYS" });
    const sub = makeSub({ canonicalMerchantName: "Anthropic", amount: "20.00", currency: "USD", nextBillingDate: "2026-09-15" });
    const { subject, html } = buildSubscriptionReminderEmail(reminder, sub);
    expect(subject).toContain("Anthropic");
    expect(subject).toContain("3 day");
    expect(html).toContain("Anthropic");
    expect(html).toContain("September 15, 2026");
    expect(html).toContain("Amount: 20.00 USD");
  });

  it("Test 20: a null amount NEVER renders as $0 or 0.00 -- it renders the explicit 'we don't have it yet' message", () => {
    const reminder = makeReminder();
    const sub = makeSub({ amount: null, currency: null });
    const { html } = buildSubscriptionReminderEmail(reminder, sub);
    expect(html).toContain("We don't have the billing amount yet.");
    expect(html).not.toContain("$0");
    expect(html).not.toContain("0.00");
  });

  it("Test 21: a known amount with an unknown currency never fabricates a currency code", () => {
    const reminder = makeReminder();
    const sub = makeSub({ amount: "20.00", currency: null });
    const { html } = buildSubscriptionReminderEmail(reminder, sub);
    expect(html).toContain("Amount: 20.00 (currency not confirmed)");
    expect(html).not.toMatch(/20\.00\s+(USD|EUR|GBP)/);
  });

  it("correctly maps each reminder type to its day count in both subject and heading", () => {
    const sub = makeSub();
    for (const [type, days] of [["THREE_DAYS", 3], ["TWO_DAYS", 2], ["ONE_DAY", 1]] as const) {
      const { subject } = buildSubscriptionReminderEmail(makeReminder({ type }), sub);
      expect(subject).toContain(`${days} day${days !== 1 ? "s" : ""}`);
    }
  });

  it("never includes cancel/urgency language the task explicitly forbids", () => {
    const sub = makeSub({ amount: null, currency: null });
    const { html, subject } = buildSubscriptionReminderEmail(makeReminder(), sub);
    const combined = (html + subject).toLowerCase();
    for (const forbidden of ["guaranteed", "wasting", "unused", "cancel now"]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it("never leaks internal database ids into the email content", () => {
    const reminder = makeReminder({ id: "reminder-secret-id-123" });
    const sub = makeSub({ id: "sub-secret-id-456" });
    const { html, subject } = buildSubscriptionReminderEmail(reminder, sub);
    expect(html).not.toContain("reminder-secret-id-123");
    expect(html).not.toContain("sub-secret-id-456");
    expect(subject).not.toContain("reminder-secret-id-123");
    expect(subject).not.toContain("sub-secret-id-456");
  });
});

// Idempotency/concurrency (Tests 3/4/11-14) and failure-state transitions
// (Tests 2/5/15-18) note: the actual guarantee lives in the SQL itself --
// server/storage.ts's getDueSubscriptionReminders() only ever selects rows
// WHERE status IN ('PENDING','FAILED'), and claimSubscriptionReminderForSending()
// performs a single conditional UPDATE ... WHERE status IN ('PENDING','FAILED')
// RETURNING * -- Postgres's own row-level locking during that UPDATE is what
// makes it impossible for two concurrent callers to both receive a non-empty
// result for the same row. This is a DB-layer guarantee, verified live
// against production (see the implementation report), not simulated here --
// the exact same "DB-layer guarantees verified live, not simulated"
// convention this codebase uses everywhere else (PHASE G #8/#9,
// aiCredits.test.ts's reserveCredit()/refundCredit(), Phase 4.1's own
// idempotency note above). A SENT or SKIPPED reminder can never be
// reselected by the same WHERE clause, structurally -- there is no code
// path that widens that status filter.
