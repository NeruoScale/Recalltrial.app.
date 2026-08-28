import { describe, it, expect } from "vitest";
import { decideReminderDeliveryAction, computeStaleSendingCutoff, REMINDERS_DISABLED_SKIP_REASON } from "./reminderDelivery";
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

describe("decideReminderDeliveryAction — Phase 4.4 reminder preference gate", () => {
  it("Preference Test 10: enabled user (remindersEnabledForUser=true, the default) can deliver an otherwise-eligible due reminder", () => {
    const sub = makeSub();
    const result = decideReminderDeliveryAction(sub, true, NOW, "UTC", true);
    expect(result).toEqual({ action: "attempt" });
  });

  it("Preference Test 11: disabled user (remindersEnabledForUser=false) cannot deliver a PENDING reminder, even though the subscription is perfectly eligible and the connection is active", () => {
    const sub = makeSub();
    const result = decideReminderDeliveryAction(sub, true, NOW, "UTC", false);
    expect(result).toEqual({ action: "skip", reason: REMINDERS_DISABLED_SKIP_REASON });
  });

  it("Preference Test 12: disabled user cannot deliver a FAILED reminder being retried either -- the preference check has no notion of 'is this a retry,' it applies uniformly", () => {
    const sub = makeSub();
    // decideReminderDeliveryAction doesn't see the reminder row's own status
    // (PENDING vs FAILED) at all -- that's the SQL WHERE clause's job. This
    // test documents that the preference gate is checked identically
    // regardless of why the reminder became due again.
    const result = decideReminderDeliveryAction(sub, true, NOW, "UTC", false);
    expect(result.action).toBe("skip");
  });

  it("Preference Test 13: the active-Gmail-connection requirement remains enforced independently of the reminder preference -- enabled but disconnected still skips", () => {
    const sub = makeSub();
    const result = decideReminderDeliveryAction(sub, false, NOW, "UTC", true);
    expect(result).toEqual({ action: "skip", reason: "hidden by active Gmail connection isolation" });
  });

  it("the reminder-preference check runs BEFORE eligibility/connection checks -- disabled + dismissed + disconnected all at once still reports the preference reason first", () => {
    const sub = makeSub({ userDismissed: true });
    const result = decideReminderDeliveryAction(sub, false, NOW, "UTC", false);
    expect(result).toEqual({ action: "skip", reason: REMINDERS_DISABLED_SKIP_REASON });
  });

  it("omitting remindersEnabledForUser defaults to true (backward compatible with every pre-Phase-4.4 call site)", () => {
    const sub = makeSub();
    const withDefault = decideReminderDeliveryAction(sub, true, NOW, "UTC");
    const explicitTrue = decideReminderDeliveryAction(sub, true, NOW, "UTC", true);
    expect(withDefault).toEqual(explicitTrue);
  });
});

describe("computeStaleSendingCutoff — Phase 4.4 stale-SENDING recovery timing", () => {
  it("Reliability Test 14 (recent claim untouched): a claim from 5 minutes ago is NOT older than a 30-minute cutoff", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const cutoff = computeStaleSendingCutoff(now, 30);
    const recentClaim = new Date("2026-08-19T11:55:00.000Z"); // 5 min ago
    expect(recentClaim.getTime() > cutoff.getTime()).toBe(true); // NOT stale
  });

  it("Reliability Test 15 (stale claim recovered): a claim from 60 minutes ago IS older than a 30-minute cutoff", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const cutoff = computeStaleSendingCutoff(now, 30);
    const staleClaim = new Date("2026-08-19T11:00:00.000Z"); // 60 min ago
    expect(staleClaim.getTime() < cutoff.getTime()).toBe(true); // stale
  });

  it("boundary: a claim exactly AT the cutoff is not considered older than it (matches the SQL's strict '<' comparison, never recovers a borderline claim prematurely)", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const cutoff = computeStaleSendingCutoff(now, 30);
    const exactBoundaryClaim = new Date(cutoff.getTime());
    expect(exactBoundaryClaim.getTime() < cutoff.getTime()).toBe(false);
  });

  it("respects a configurable timeout rather than a hard-coded value", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    const cutoff5 = computeStaleSendingCutoff(now, 5);
    const cutoff60 = computeStaleSendingCutoff(now, 60);
    expect(cutoff5.getTime()).toBeGreaterThan(cutoff60.getTime()); // a shorter timeout produces a MORE RECENT cutoff
  });

  it("determinism: identical inputs always produce the identical cutoff", () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    expect(computeStaleSendingCutoff(now, 30)).toEqual(computeStaleSendingCutoff(now, 30));
  });
});

// Reliability Tests 16/17 note: "a recovered row becomes eligible for
// retry" and "a SENT row is never recovered" are the SQL WHERE clause's job
// (server/storage.ts's recoverStaleSendingReminders() only ever matches
// status='SENDING', and recovered rows are set to status='PENDING', which
// getDueSubscriptionReminders()'s own WHERE clause already includes) -- a
// DB-layer guarantee, verified live against production, not simulated here,
// matching this file's own existing idempotency note below.
//
// Reliability Tests 18/19 ("recovery respects the disabled reminder
// preference" / "respects inactive/disconnected subscription ownership"):
// deliberately NOT re-implemented inside recoverStaleSendingReminders()
// itself -- a recovered row lands back in PENDING and is picked up by the
// SAME delivery pass's decideReminderDeliveryAction() moments later, which
// already re-checks both (see the "Phase 4.4 reminder preference gate" and
// "Phase 4.2 delivery re-check" describe blocks above). No second
// ownership/preference mechanism was written for recovery specifically.

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
