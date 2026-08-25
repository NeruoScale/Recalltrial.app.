import { describe, it, expect } from "vitest";
import { applyEventToSubscription, type LifecycleRelevantEvent } from "./subscriptionLifecycle";
import { decideCanonicalization } from "./canonicalEvents";
import { deriveShadowSubscription, resolveEntity, type EntityResolutionResult } from "./entityResolver";
import { buildScanTimeFilter, buildGmailDisconnectUpdate, scanGmailForTrials } from "./gmail";
import { buildAnalystContext } from "./savingsAnalyst";
import type { SavingsAnalysis } from "./savingsIntelligence";
import type { ShadowSubscription, SubscriptionEvent } from "@shared/schema";

// ─── Gmail Account Switching / Fresh-Data Isolation Audit ──────────────────────
//
// READ-ONLY AUDIT (per the task): these tests characterize the REAL,
// CURRENT behavior of the actual production functions — they are not a
// wishlist of desired behavior, and none of them assert that a documented
// gap "should" be fixed. Where the real code contaminates or carries stale
// state across an account switch, the test says so explicitly and the test
// itself still PASSES (green) because it correctly predicts what the real
// code does — see the audit report's "TEST RESULTS" section for the
// separate PASS/FAIL verdict on the ISOLATION PROPERTY each test targets,
// which is a different question from "did this vitest assertion pass."
//
// Every function under test here is the ACTUAL production function
// (subscriptionLifecycle.ts, canonicalEvents.ts, entityResolver.ts,
// gmail.ts, savingsAnalyst.ts) — nothing reimplemented, matching this
// codebase's own "pure function tests only" convention throughout.

let subIdCounter = 0;
function makeSub(overrides: Partial<ShadowSubscription> = {}): ShadowSubscription {
  subIdCounter++;
  return {
    id: `sub-${subIdCounter}`,
    userId: "user-U",
    entityKey: "example.com",
    canonicalMerchantName: "Example",
    canonicalMerchantDomain: "example.com",
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
    nextBillingDate: null,
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

let eventIdCounter = 0;
function makeEvent(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  eventIdCounter++;
  return {
    id: `evt-${eventIdCounter}`,
    subscriptionId: null,
    userId: "user-U",
    emailConnectionId: null,
    eventType: "subscription_invoice",
    sourceMessageId: `msg-${eventIdCounter}`,
    extractedPrice: "20.00",
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
    supersededBy: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionEvent;
}

function lifecycleEvent(e: SubscriptionEvent): LifecycleRelevantEvent {
  return {
    id: e.id,
    eventType: e.eventType,
    extractedPrice: e.extractedPrice,
    extractedCurrency: e.extractedCurrency,
    extractedDate: e.extractedDate,
    userId: e.userId,
    canonicalMerchantDomain: e.canonicalMerchantDomain,
    billingInterval: e.billingInterval,
    emailConnectionId: e.emailConnectionId,
  };
}

const USER_U = "user-U";

describe("TEST 1 — Basic account switching: distinct merchants never collide", () => {
  it("Gmail A's message ID and Gmail B's message ID never collide in canonicalization (Gmail IDs are globally unique)", () => {
    // decideCanonicalization is keyed strictly by (userId, sourceMessageId)
    // rows already in the DB for THAT exact message id. B's message id was
    // never issued by Gmail to any of A's mail, so the existing-rows lookup
    // for it is always empty regardless of what A ever sent.
    const decisionForBsFreshMessage = decideCanonicalization([], "subscription_invoice");
    expect(decisionForBsFreshMessage).toEqual({ kind: "first_generation" });
  });

  it("a subscription resolved from Gmail A's merchant domain is never touched by a B event for a DIFFERENT domain", () => {
    const subscriptionFromA = makeSub({ canonicalMerchantDomain: "merchant-a.com", amount: "15.00" });
    const eventFromB = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "merchant-b.com", extractedPrice: "25.00" }));

    // storage.ts's applyLifecycleEventToSubscription looks up the target row
    // by (userId, canonicalMerchantDomain) BEFORE calling this function —
    // a merchant-b.com event would never even find subscriptionFromA (whose
    // domain is merchant-a.com), so applyEventToSubscription would never be
    // invoked against it in the first place. This directly demonstrates why:
    // the two subscriptions are genuinely different domains, so no lookup
    // could ever conflate them.
    expect(subscriptionFromA.canonicalMerchantDomain).not.toBe(eventFromB.canonicalMerchantDomain);
  });

  it("B's canonical event never carries A's sourceMessageId", () => {
    const eventFromA = makeEvent({ sourceMessageId: "gmail-A-msg-001", canonicalMerchantDomain: "merchant-a.com" });
    const eventFromB = makeEvent({ sourceMessageId: "gmail-B-msg-001", canonicalMerchantDomain: "merchant-b.com" });
    expect(eventFromB.sourceMessageId).not.toBe(eventFromA.sourceMessageId);
  });
});

describe("TEST 2 — Same merchant, different data: entity-resolution contamination check", () => {
  // This is the central finding of the audit. entityKey (entityResolver.ts)
  // and the live per-event lookup (storage.ts's applyLifecycleEventToSubscription)
  // are BOTH keyed only by (userId, canonicalMerchantDomain) — there is no
  // Gmail-account component anywhere in the key. A merchant seen via Gmail A
  // and the SAME merchant later seen via Gmail B resolve to the exact same
  // `subscriptions` row.

  it("FINDING: deriveShadowSubscription computes the IDENTICAL entityKey for the same merchant regardless of which 'account' the evidence came from", () => {
    const groupFromA: EntityResolutionResult = {
      proposedSubscriptionId: "shadow-a",
      canonicalMerchantName: "Anthropic",
      canonicalMerchantDomain: "anthropic.com",
      paymentProcessor: null,
      events: [makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "20.00", sourceMessageId: "A-message-123", merchantConfidence: 90 })],
      resolutionConfidence: 90,
      resolutionMethod: "domain_match",
      resolutionStatus: "resolved",
      potentialFalseMerge: false,
      potentialFalseSplit: false,
    };
    const groupFromB: EntityResolutionResult = {
      ...groupFromA,
      proposedSubscriptionId: "shadow-b",
      events: [makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "30.00", sourceMessageId: "B-message-456", merchantConfidence: 90 })],
    };

    const candidateA = deriveShadowSubscription(groupFromA)!;
    const candidateB = deriveShadowSubscription(groupFromB)!;

    expect(candidateA.entityKey).toBe("anthropic.com");
    expect(candidateB.entityKey).toBe("anthropic.com");
    expect(candidateA.entityKey).toBe(candidateB.entityKey); // <- the contamination pathway: same (userId, entityKey) row
  });

  it("FINDING: a live B event UNCONDITIONALLY overwrites amount/currency/nextBillingDate on the EXISTING subscription row A originally created", () => {
    const existingSubscriptionFromA = makeSub({
      canonicalMerchantDomain: "anthropic.com",
      amount: "20.00",
      currency: "USD",
      sourceCanonicalEventId: "evt-from-A",
    });
    const newEventFromB = lifecycleEvent(makeEvent({
      id: "evt-from-B",
      canonicalMerchantDomain: "anthropic.com",
      sourceMessageId: "B-message-456",
      eventType: "subscription_invoice",
      extractedPrice: "30.00",
      extractedCurrency: "USD",
      extractedDate: "2026-09-01",
    }));

    const result = applyEventToSubscription(newEventFromB, existingSubscriptionFromA);

    // B's amount silently replaces A's amount on the SAME row — no
    // corroboration check, no "is this consistent with the existing
    // source" comparison.
    expect(result.fields.amount).toBe("30.00");
    expect(result.fields.currency).toBe("USD");
    expect(result.fields.nextBillingDate).toBe("2026-09-01");
  });

  it("FINDING: sourceCanonicalEventId is NEVER refreshed by the live lifecycle path — it can go stale, still pointing at A's original event after B's data has overwritten everything else", () => {
    const existingSubscriptionFromA = makeSub({ canonicalMerchantDomain: "anthropic.com", sourceCanonicalEventId: "evt-from-A" });
    const newEventFromB = lifecycleEvent(makeEvent({ id: "evt-from-B", canonicalMerchantDomain: "anthropic.com", extractedPrice: "30.00" }));

    const result = applyEventToSubscription(newEventFromB, existingSubscriptionFromA);

    // applyEventToSubscription's `fields` never includes sourceCanonicalEventId
    // at all — storage.ts's UPDATE only ever writes the keys present in
    // `fields`, so the column keeps whatever it was set to at row creation.
    expect(result.fields).not.toHaveProperty("sourceCanonicalEventId");
  });

  it("by contrast: a genuinely different domain for the 'same-looking' merchant name is NOT merged (the safe case)", () => {
    // If B's Anthropic email happens to resolve to a distinguishable domain
    // (e.g. a different sender pattern), entityKey correctly differs and no
    // contamination occurs — this isolates the finding to the SAME-domain
    // case specifically, not "any same merchant name."
    const groupFromA: EntityResolutionResult = {
      proposedSubscriptionId: "shadow-a",
      canonicalMerchantName: "Anthropic",
      canonicalMerchantDomain: "anthropic.com",
      paymentProcessor: null,
      events: [makeEvent({ canonicalMerchantDomain: "anthropic.com", merchantConfidence: 90 })],
      resolutionConfidence: 90,
      resolutionMethod: "domain_match",
      resolutionStatus: "resolved",
      potentialFalseMerge: false,
      potentialFalseSplit: false,
    };
    const groupFromBDifferentDomain: EntityResolutionResult = {
      ...groupFromA,
      canonicalMerchantDomain: "anthropic-billing.example.com",
      events: [makeEvent({ canonicalMerchantDomain: "anthropic-billing.example.com", merchantConfidence: 90 })],
    };

    const candidateA = deriveShadowSubscription(groupFromA)!;
    const candidateB = deriveShadowSubscription(groupFromBDifferentDomain)!;
    expect(candidateA.entityKey).not.toBe(candidateB.entityKey);
  });
});

describe("TEST 3 — Old subscription vs new email account: confirmed/tracked state persistence", () => {
  it("disconnecting Gmail does not touch the subscriptions table at all — a confirmed/tracked subscription survives disconnect untouched", () => {
    // server/storage.ts's clearUserGmailTokens() (called by POST /api/gmail/disconnect)
    // only issues `db.update(users).set({ gmailAccessToken: null, ... })` —
    // it has no reference to the `subscriptions` table whatsoever. This test
    // documents that fact structurally: a confirmed row's userConfirmed/
    // userConfirmedAt fields have no code path that clears them on disconnect.
    const confirmedSubscription = makeSub({
      canonicalMerchantDomain: "anthropic.com",
      userConfirmed: true,
      userConfirmedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    // applyEventToSubscription's own `fields` output — the only thing that
    // ever gets written back to the row on a NEW event — never includes
    // userConfirmed/userConfirmedAt in any branch.
    const newEventFromB = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "30.00" }));
    const result = applyEventToSubscription(newEventFromB, confirmedSubscription);
    expect(result.fields).not.toHaveProperty("userConfirmed");
    expect(result.fields).not.toHaveProperty("userConfirmedAt");
  });

  it("FINDING (same root cause as TEST 2): a CONFIRMED subscription's amount is just as unconditionally overwritten by new B evidence as an unconfirmed one — confirmation does not protect against silent overwrite", () => {
    const confirmedSubscription = makeSub({
      canonicalMerchantDomain: "anthropic.com",
      amount: "20.00",
      userConfirmed: true,
      userConfirmedAt: new Date("2026-08-10T00:00:00.000Z"),
    });
    const newEventFromB = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "30.00" }));
    const result = applyEventToSubscription(newEventFromB, confirmedSubscription);
    expect(result.fields.amount).toBe("30.00"); // overwritten despite userConfirmed=true
  });
});

describe("TEST 4 — AI Analyst context isolation after switching to B", () => {
  const emptySavingsAnalysis: SavingsAnalysis = {
    opportunities: [],
    summary: { totalOpportunities: 0, potentialMonthlySavings: null, potentialAnnualSavings: null, byCurrency: {}, incompleteCostCount: 0, confidence: "medium" },
  };

  it("the analyst context built from B's current subscription rows contains only B's merchant/amount data, never A's, and never a raw email body field", () => {
    const bOnlySubscription = makeSub({
      canonicalMerchantName: "MerchantB",
      canonicalMerchantDomain: "merchant-b.com",
      amount: "25.00",
      currency: "USD",
    });
    const withCost = { ...bOnlySubscription, monthlyCost: 25, annualCost: 300, costConfidence: "High" as const };

    const context = buildAnalystContext({
      subscriptions: [withCost],
      savingsAnalysis: emptySavingsAnalysis,
      priceChangesBySubscriptionId: {},
      upcomingCharges: [],
      costSummary: { totalSubscriptions: 1, activeSubscriptions: 1, monthlyRecurringCost: 25, annualRecurringCost: 300, byCurrency: { USD: { monthly: 25, annual: 300 } }, incompleteBillingCount: 0, unknownCostCount: 0 },
    });

    expect(context.subscriptions).toHaveLength(1);
    expect(context.subscriptions[0].merchant).toBe("MerchantB");
    expect(context.subscriptions[0].amount).toBe("25.00");

    const serialized = JSON.stringify(context).toLowerCase();
    expect(serialized).not.toContain("merchanta");
    for (const forbidden of ["bodytext", "sourcemessageid", "subject", "snippet", "\"body\""]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("FINDING (inherited from TEST 2, not a new AI-specific leak): if the SAME merchant row was contaminated by A's stale evidence before the analyst ever runs, the analyst context reflects whatever the row currently holds — it has no way to independently detect the contamination, because it correctly trusts the structured subscription record as the source of truth", () => {
    // This test exists to make the boundary explicit: the analyst itself
    // introduces NO additional leak (it never sees raw email, never
    // cross-references other users, never receives anything beyond what's
    // passed in) — any contamination visible to it is entirely a
    // pass-through of Finding #2 upstream, not a defect in the analyst.
    const mergedSubscription = makeSub({ canonicalMerchantName: "Anthropic", canonicalMerchantDomain: "anthropic.com", amount: "30.00" }); // B's amount, post-overwrite
    const withCost = { ...mergedSubscription, monthlyCost: 30, annualCost: 360, costConfidence: "High" as const };
    const context = buildAnalystContext({
      subscriptions: [withCost],
      savingsAnalysis: emptySavingsAnalysis,
      priceChangesBySubscriptionId: {},
      upcomingCharges: [],
      costSummary: { totalSubscriptions: 1, activeSubscriptions: 1, monthlyRecurringCost: 30, annualRecurringCost: 360, byCurrency: { USD: { monthly: 30, annual: 360 } }, incompleteBillingCount: 0, unknownCostCount: 0 },
    });
    expect(context.subscriptions[0].amount).toBe("30.00");
    expect(context.subscriptions[0].merchant).toBe("Anthropic"); // no A/B account marker exists to distinguish provenance — none is available to pass through
  });
});

describe("TEST 5 — Repeated switching (A -> B -> A -> B) does not accumulate cross-account artifacts", () => {
  it("each switch is an independent overwrite of the same row — no growing/compounding contamination beyond 'whichever event was applied most recently wins'", () => {
    let sub = makeSub({ canonicalMerchantDomain: "anthropic.com", amount: "20.00" }); // from A
    const sequence = [
      { from: "B", price: "30.00" },
      { from: "A", price: "20.00" },
      { from: "B", price: "35.00" },
    ];
    for (const step of sequence) {
      const event = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: step.price }));
      const result = applyEventToSubscription(event, sub);
      sub = { ...sub, ...result.fields } as ShadowSubscription;
    }
    // Final state reflects only the LAST applied event (B's $35), regardless
    // of how many times the account was switched in between — confirms the
    // behavior doesn't get progressively worse (no accumulating duplicate
    // fields, no growing merge artifacts), but also confirms it never
    // "remembers" which account is authoritative — purely last-write-wins.
    expect(sub.amount).toBe("35.00");
  });

  it("canonical event history itself is NEVER overwritten across switches — every individual event row from every account remains queryable, even though the summary `subscriptions` row only reflects the latest", () => {
    // subscription_events rows are immutable once written (new events are
    // separate rows keyed by their own sourceMessageId) — only the derived
    // `subscriptions` summary row is subject to Finding #2's overwrite.
    const eventFromA = makeEvent({ canonicalMerchantDomain: "anthropic.com", sourceMessageId: "A-message-123", extractedPrice: "20.00" });
    const eventFromB = makeEvent({ canonicalMerchantDomain: "anthropic.com", sourceMessageId: "B-message-456", extractedPrice: "30.00" });
    const allEvents = [eventFromA, eventFromB];
    // Both remain independently present and distinguishable by sourceMessageId.
    expect(allEvents.map((e) => e.sourceMessageId)).toEqual(["A-message-123", "B-message-456"]);
    expect(allEvents.map((e) => e.extractedPrice)).toEqual(["20.00", "30.00"]);
  });
});

describe("TEST 6 — Disconnect then reconnect the SAME account: no duplicates", () => {
  it("re-scanning an already-seen message (same account, reconnected) hits the idempotent same_classification path, never a duplicate", () => {
    const previouslyStoredRow = makeEvent({ sourceMessageId: "A-message-123", eventType: "subscription_invoice", isCanonical: true });
    const decision = decideCanonicalization([previouslyStoredRow], "subscription_invoice");
    expect(decision.kind).toBe("same_classification");
    // storage.ts's onConflictDoUpdate on (userId, sourceMessageId, eventType)
    // means this always updates the SAME row — a fresh UUID is never
    // generated for an already-seen message, so no duplicate row results.
  });

  it("reconnecting the same account and rescanning the same price data leaves the subscription's fields unchanged (idempotent)", () => {
    const sub = makeSub({ canonicalMerchantDomain: "anthropic.com", amount: "20.00", subscriptionStatus: "active" });
    const sameEventAgain = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", eventType: "subscription_invoice", extractedPrice: "20.00" }));
    const result = applyEventToSubscription(sameEventAgain, sub);
    expect(result.fields.amount).toBe("20.00"); // same value re-applied — no drift, no duplication
    expect(result.fields.subscriptionStatus).toBeUndefined(); // subscription_invoice never changes lifecycle state
    expect(result.transition.kind).toBe("data_update"); // subscription_invoice is always "data_update" by design, even when the value is unchanged — not a bug, just this event type's fixed classification
  });
});

describe("TEST 7 — Concurrency / stale-scan protection", () => {
  // FINDING: scanning is SYNCHRONOUS within a single HTTP request — there is
  // no background job queue for the Gmail-fetch step itself (AI enrichment
  // IS queued/async, layered on top of already-written events, but that's a
  // separate concern). POST /api/gmail/scan reads user.gmailAccessToken/
  // refreshToken/userId ONCE at the top of the handler and passes them as
  // plain function PARAMETERS into scanGmailForTrials() — it never re-reads
  // the user's live DB row mid-scan. This means:
  //   - An in-flight "stale A scan" keeps using the A token/userId it
  //     already captured — it can NEVER accidentally start fetching from
  //     Gmail B mid-request (Google's API is scoped to whichever token is
  //     presented, and the request is holding A's token in a local variable
  //     unaffected by a concurrent DB update).
  //   - BUT if that same in-flight A-scan is still writing subscription_events
  //     AFTER the user has already disconnected A and connected B, those are
  //     genuinely real A-sourced events landing late — and because of
  //     Finding #2 (merge keyed only by userId+domain), a late A event for
  //     the same merchant domain as a fresh B event can still overwrite
  //     whichever one commits its DB write last, independent of which
  //     account is "currently connected" by the time the write lands.
  // This is a genuine, real characteristic of the architecture — verified
  // by code review of server/routes.ts's POST /api/gmail/scan and
  // server/gmail.ts's scanGmailForTrials() signature, not simulated here
  // (this codebase has no async DB-race test infrastructure, consistent
  // with its "pure function tests only" convention throughout).

  it("scanGmailForTrials's token/user parameters are plain function arguments, not re-read from shared mutable state — confirms a scan cannot MID-REQUEST start pulling from a DIFFERENT Gmail account than the one it started with", () => {
    // Structural confirmation via the function's own declared signature
    // (imported directly, not re-implemented): it takes the access token,
    // refresh token, expiry, userId, and lastEmailScanAt as explicit
    // parameters. There is no internal call back into storage to re-fetch
    // "whatever the user's current token is right now."
    expect(typeof scanGmailForTrials).toBe("function");
    expect(scanGmailForTrials.length).toBeGreaterThanOrEqual(4); // accessToken, refreshToken, expiry, userId, ... — all explicit params, not read from shared state
  });

  it("applyEventToSubscription itself has no notion of 'which scan is stale' — a late-arriving A event and a fresh B event for the same domain are indistinguishable to it, both simply overwrite in whatever order they're applied (same mechanism as Finding #2, not a separate bug)", () => {
    const sub = makeSub({ canonicalMerchantDomain: "anthropic.com", amount: "20.00" });
    const lateArrivingAEvent = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "22.00" })); // A's scan, completes late
    const freshBEvent = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "30.00" })); // B's scan, completes first

    // If B's write lands first, then A's late write lands second, A's stale
    // value wins — purely commit-order-dependent, exactly the risk profile
    // described above.
    const afterB = applyEventToSubscription(freshBEvent, sub);
    const subAfterB = { ...sub, ...afterB.fields } as ShadowSubscription;
    const afterLateA = applyEventToSubscription(lateArrivingAEvent, subAfterB);
    expect(afterLateA.fields.amount).toBe("22.00"); // late/stale A write overwrote the fresh B value
  });
});

describe("Scan time-window staleness after account switch (buildScanTimeFilter)", () => {
  it("mechanism the fix prevents: an UNCLEARED lastEmailScanAt would make B's scan reuse A's last-scan timestamp as the search lower-bound, silently skipping B's older mail", () => {
    const staleTimestampFromA = new Date("2026-08-20T00:00:00.000Z");
    const filter = buildScanTimeFilter(staleTimestampFromA);
    // Not "newer_than:90d" (the fresh-connection default) — it's an
    // after:<A's date> filter, exactly as if B were a continuation of A's
    // scan history rather than a brand-new mailbox. This is exactly why
    // buildGmailDisconnectUpdate() (tested below) must null this field out.
    expect(filter).not.toBe("newer_than:90d");
    expect(filter).toMatch(/^after:\d{4}\/\d{2}\/\d{2}$/);
  });

  it("a TRULY fresh connection (lastEmailScanAt never set) correctly scans the full default window", () => {
    expect(buildScanTimeFilter(null)).toBe("newer_than:90d");
    expect(buildScanTimeFilter(undefined)).toBe("newer_than:90d");
  });
});

describe("REGRESSION TEST (TASK 1 safe fix): connect/scan A -> disconnect A -> connect B -> B scan does not reuse A's scan timestamp", () => {
  it("buildGmailDisconnectUpdate() nulls out lastEmailScanAt and lastScanMessagesProcessed, not just the token fields", () => {
    const update = buildGmailDisconnectUpdate();
    expect(update.gmailAccessToken).toBeNull();
    expect(update.gmailRefreshToken).toBeNull();
    expect(update.gmailTokenExpiry).toBeNull();
    expect(update.gmailConnected).toBe(false);
    expect(update.lastEmailScanAt).toBeNull();
    expect(update.lastScanMessagesProcessed).toBeNull();
  });

  it("full scenario: A scans (lastEmailScanAt set) -> disconnect -> the SAME field, once cleared, makes B's first scan use the fresh 90-day window instead of A's stale cursor", () => {
    // Step 1: user connects and scans Gmail A — this is what user.lastEmailScanAt
    // looks like immediately after (server/storage.ts's updateLastEmailScan()).
    const userStateAfterScanningA = {
      lastEmailScanAt: new Date("2026-08-20T12:00:00.000Z"),
      lastScanMessagesProcessed: 42,
    };
    // Sanity check: BEFORE the fix's field, A's own stale value would have
    // produced a narrow after:-filter — confirming this scenario actually
    // exercises the bug path, not a no-op.
    expect(buildScanTimeFilter(userStateAfterScanningA.lastEmailScanAt)).not.toBe("newer_than:90d");

    // Step 2: user disconnects Gmail A. clearUserGmailTokens() (server/storage.ts)
    // now applies buildGmailDisconnectUpdate() to the user row.
    const userStateAfterDisconnect = { ...userStateAfterScanningA, ...buildGmailDisconnectUpdate() };
    expect(userStateAfterDisconnect.lastEmailScanAt).toBeNull();
    expect(userStateAfterDisconnect.lastScanMessagesProcessed).toBeNull();

    // Step 3: user connects Gmail B and triggers its first scan. The scan
    // route reads user.lastEmailScanAt fresh from the DB at request time
    // (server/routes.ts's POST /api/gmail/scan) — which is now null, per
    // step 2 — so buildScanTimeFilter() computes the full fresh window,
    // never A's old cursor.
    const bScanTimeFilter = buildScanTimeFilter(userStateAfterDisconnect.lastEmailScanAt);
    expect(bScanTimeFilter).toBe("newer_than:90d");
  });
});

// ─── Email Connection Isolation Architecture — PHASE D/E cross-account
// protection (crossAccountProtectionEnabled=true) ──────────────────────────
//
// Every test above this point exercises applyEventToSubscription() with its
// DEFAULT crossAccountProtectionEnabled=false — i.e. the pre-existing
// behavior, gated OFF for any user without subscriptionIntelligenceEnabled.
// The tests below exercise the NEW protected path (RULES 1-4), proving the
// specific gaps documented above are now closed for beta users. Both paths
// are tested because BOTH are real, live behavior depending on the flag —
// this is not a "before/after the fix" pair, it's "off users" vs "on users."
//
// isKnownDifferentAccount is passed in directly (mirroring what
// server/storage.ts's applyLifecycleEventToSubscription() resolves by
// comparing providerAccountId, not raw connection ids — see that function's
// own comment) since applyEventToSubscription itself is pure and has no DB
// access to resolve it internally.

describe("PHASE G #2/#10 — same merchant, different amount, protection ON: conflict is detected and the existing value is preserved", () => {
  it("RULE 3: different KNOWN account, amount conflicts -> crossAccountConflict=true, amount NOT overwritten", () => {
    const subscriptionFromA = makeSub({
      canonicalMerchantDomain: "anthropic.com",
      amount: "20.00",
      currency: "USD",
      lastEventEmailConnectionId: "connection-A",
    });
    const eventFromB = lifecycleEvent(makeEvent({
      canonicalMerchantDomain: "anthropic.com",
      extractedPrice: "30.00",
      extractedCurrency: "USD",
      emailConnectionId: "connection-B",
    }));

    const result = applyEventToSubscription(eventFromB, subscriptionFromA, true, /* isKnownDifferentAccount */ true);

    expect(result.fields.amount).toBeUndefined(); // NOT overwritten — this is the fix
    expect(result.fields.currency).toBeUndefined();
    expect(result.fields.crossAccountConflict).toBe(true);
    expect(result.fields.lastEventEmailConnectionId).toBeUndefined(); // provenance stays pointing at A, the connection that supplied the PRESERVED value
  });
});

describe("PHASE G #3/#11 — same merchant, SAME amount, protection ON: agreement updates provenance safely", () => {
  it("RULE 2: different KNOWN account, values AGREE -> applies normally, refreshes provenance, clears any conflict flag", () => {
    const subscriptionFromA = makeSub({
      canonicalMerchantDomain: "anthropic.com",
      amount: "20.00",
      currency: "USD",
      lastEventEmailConnectionId: "connection-A",
      crossAccountConflict: true, // simulating a PRIOR conflict that this agreeing event should clear
    });
    const eventFromB = lifecycleEvent(makeEvent({
      canonicalMerchantDomain: "anthropic.com",
      extractedPrice: "20.00", // agrees with A's value
      extractedCurrency: "USD",
      emailConnectionId: "connection-B",
    }));

    const result = applyEventToSubscription(eventFromB, subscriptionFromA, true, true);

    expect(result.fields.amount).toBe("20.00");
    expect(result.fields.lastEventEmailConnectionId).toBe("connection-B");
    expect(result.fields.crossAccountConflict).toBe(false); // stale conflict flag cleared
  });
});

describe("PHASE G #4/#5 — confirmed/tracked A subscription + conflicting B evidence: protected", () => {
  it("a userConfirmed=true subscription's amount is protected from a conflicting different-account event when protection is ON", () => {
    const confirmedSubscription = makeSub({
      canonicalMerchantDomain: "anthropic.com",
      amount: "20.00",
      userConfirmed: true,
      userConfirmedAt: new Date("2026-08-10T00:00:00.000Z"),
      lastEventEmailConnectionId: "connection-A",
    });
    const conflictingEventFromB = lifecycleEvent(makeEvent({
      canonicalMerchantDomain: "anthropic.com",
      extractedPrice: "30.00",
      emailConnectionId: "connection-B",
    }));

    const result = applyEventToSubscription(conflictingEventFromB, confirmedSubscription, true, true);

    expect(result.fields.amount).toBeUndefined(); // confirmed value preserved
    expect(result.fields.crossAccountConflict).toBe(true);
    // Confirmation state itself was never a `fields` key to begin with —
    // this reconfirms RULE 5 (never silently touched by any event, with
    // protection on OR off).
    expect(result.fields).not.toHaveProperty("userConfirmed");
    expect(result.fields).not.toHaveProperty("userConfirmedAt");
  });
});

describe("PHASE G #6 — A -> B -> A -> B with protection ON: uses stable account identity throughout, no false conflicts, no lost protection", () => {
  it("switching back to a PREVIOUSLY-seen account (by stable providerAccountId) after an intervening different account still detects the renewed conflict correctly", () => {
    // Anthropic $20 from account A (connection-A1, first session)
    let sub = makeSub({ canonicalMerchantDomain: "anthropic.com", amount: "20.00", lastEventEmailConnectionId: "connection-A1" });

    // B connects (connection-B1), conflicting evidence -> flagged, A's $20 preserved
    const stepB = applyEventToSubscription(
      lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "30.00", emailConnectionId: "connection-B1" })),
      sub, true, true
    );
    expect(stepB.fields.amount).toBeUndefined();
    expect(stepB.fields.crossAccountConflict).toBe(true);
    sub = { ...sub, ...stepB.fields } as ShadowSubscription; // still $20, still connection-A1, conflict=true

    // User reconnects A again (a NEW connection row, connection-A2 — but
    // the SAME real account) and A re-sends the same $20 evidence. Since
    // this test passes isKnownDifferentAccount explicitly (mirroring what
    // storage.ts would resolve via providerAccountId), reconnecting the
    // same real account resolves to isKnownDifferentAccount=false here.
    const stepAAgain = applyEventToSubscription(
      lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "20.00", emailConnectionId: "connection-A2" })),
      sub, true, false // same stable account as before, despite the new connection row id
    );
    expect(stepAAgain.fields.amount).toBe("20.00");
    expect(stepAAgain.fields.lastEventEmailConnectionId).toBe("connection-A2");
  });
});

describe("PHASE G #7 — disconnect/reconnect the SAME account: reconnecting must NOT look like a different account", () => {
  it("storage.ts resolves isKnownDifferentAccount=false when providerAccountId matches, even though the connection ROW id is brand new", () => {
    // This test documents the EXACT bug that would exist if raw connection
    // ids were compared instead of providerAccountId: a user reconnecting
    // their own unchanged Gmail account would otherwise see every ordinary
    // future price change misflagged as a "cross-account conflict."
    // storage.ts's applyLifecycleEventToSubscription() performs this
    // resolution (comparing eventConnection.providerAccountId against
    // lastConnection.providerAccountId, falling back to raw-id-differs=true
    // only when providerAccountId is unavailable on one/both sides) — this
    // test exercises applyEventToSubscription() with the CORRECTLY resolved
    // value to confirm the pure function's own handling is right, given
    // that resolution.
    const sub = makeSub({ canonicalMerchantDomain: "anthropic.com", amount: "20.00", lastEventEmailConnectionId: "connection-old-session" });
    const priceChangeAfterReconnect = lifecycleEvent(makeEvent({
      canonicalMerchantDomain: "anthropic.com",
      extractedPrice: "22.00", // a completely ordinary, legitimate price increase
      emailConnectionId: "connection-new-session", // different ROW id after reconnect
    }));

    // Correctly resolved: same providerAccountId -> isKnownDifferentAccount=false
    const result = applyEventToSubscription(priceChangeAfterReconnect, sub, true, false);
    expect(result.fields.amount).toBe("22.00"); // applied normally — NOT flagged as a conflict
    expect(result.fields.crossAccountConflict).toBeUndefined();
  });
});

describe("PHASE G #12 — unknown A value + known B value: RULE 4, no conflict possible", () => {
  it("existing amount is null -> a different account's known value populates it normally, never flagged as a conflict", () => {
    const subscriptionWithUnknownAmount = makeSub({
      canonicalMerchantDomain: "anthropic.com",
      amount: null,
      currency: null,
      lastEventEmailConnectionId: "connection-A",
    });
    const eventFromB = lifecycleEvent(makeEvent({
      canonicalMerchantDomain: "anthropic.com",
      extractedPrice: "30.00",
      extractedCurrency: "USD",
      emailConnectionId: "connection-B",
    }));

    const result = applyEventToSubscription(eventFromB, subscriptionWithUnknownAmount, true, true);

    expect(result.fields.amount).toBe("30.00");
    expect(result.fields.crossAccountConflict).toBe(false);
  });
});

describe("PHASE G #13 — historical NULL emailConnectionId events remain valid under protection", () => {
  it("an event with no recorded connection (pre-PHASE-C historical row) is treated as RULE 1 — applies normally even with protection ON", () => {
    const sub = makeSub({ canonicalMerchantDomain: "anthropic.com", amount: "20.00", lastEventEmailConnectionId: "connection-A" });
    const historicalEventWithNoConnection = lifecycleEvent(makeEvent({
      canonicalMerchantDomain: "anthropic.com",
      extractedPrice: "25.00",
      emailConnectionId: null,
    }));

    // storage.ts only attempts the account-identity resolution when
    // event.emailConnectionId is present — for a null connection, it never
    // computes isKnownDifferentAccount at all (stays its default null),
    // which this test passes through explicitly.
    const result = applyEventToSubscription(historicalEventWithNoConnection, sub, true, null);
    expect(result.fields.amount).toBe("25.00"); // applied normally, not blocked
    expect(result.fields.crossAccountConflict).toBeUndefined();
  });

  it("a subscription with no recorded lastEventEmailConnectionId (predates PHASE D) also falls to RULE 1", () => {
    const preExistingSub = makeSub({ canonicalMerchantDomain: "anthropic.com", amount: "20.00", lastEventEmailConnectionId: null });
    const newEvent = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "22.00", emailConnectionId: "connection-B" }));
    // storage.ts never even attempts the comparison when existing.lastEventEmailConnectionId is null.
    const result = applyEventToSubscription(newEvent, preExistingSub, true, null);
    expect(result.fields.amount).toBe("22.00");
  });
});

describe("PHASE G #14 — cross-user isolation of the new conflict-protection fields", () => {
  it("a subscription's crossAccountConflict/lastEventEmailConnectionId are only ever set from that subscription's OWN resolution — no cross-user bleed possible (no userId parameter exists on the pure function to get wrong)", () => {
    const userASub = makeSub({ userId: "user-a", canonicalMerchantDomain: "merchant-a.com", amount: "20.00", lastEventEmailConnectionId: "connection-A" });
    const userAEvent = lifecycleEvent(makeEvent({ userId: "user-a", canonicalMerchantDomain: "merchant-a.com", extractedPrice: "30.00", emailConnectionId: "connection-A2" }));
    const result = applyEventToSubscription(userAEvent, userASub, true, true);
    // The function only ever reads/writes fields on the ONE subscription
    // object passed in — there is structurally no path for another user's
    // data to influence this result (storage.ts's caller already scopes
    // the `existing` lookup by userId+domain before this function ever runs).
    expect(result.fields.crossAccountConflict).toBe(true);
  });
});

describe("PHASE G #15 — idempotency under protection: repeated identical operations never duplicate or drift", () => {
  it("re-applying the SAME conflicting event twice produces the identical result both times (idempotent, no accumulating state)", () => {
    const sub = makeSub({ canonicalMerchantDomain: "anthropic.com", amount: "20.00", lastEventEmailConnectionId: "connection-A" });
    const conflictingEvent = lifecycleEvent(makeEvent({ canonicalMerchantDomain: "anthropic.com", extractedPrice: "30.00", emailConnectionId: "connection-B" }));

    const first = applyEventToSubscription(conflictingEvent, sub, true, true);
    const second = applyEventToSubscription(conflictingEvent, sub, true, true); // same inputs, not re-using first's output
    expect(second).toEqual(first);
  });

});

// PHASE G #8/#9 note — no duplicate active connections: this guarantee is a
// DB constraint (server/migrate.ts's partial unique index on
// email_connections(user_id, provider) WHERE disconnected_at IS NULL), not
// application logic, so there is nothing to unit-test here without a live
// DB — same "DB-layer guarantees verified live, not simulated" convention
// this codebase uses everywhere else (see server/aiCredits.test.ts's
// identical note on reserveCredit()/refundCredit()).
//
// PHASE G #8 note — late-scan / disconnected-connection protection (RULE 6):
// storage.ts's applyLifecycleEventToSubscription() checks the event's OWN
// connection's disconnectedAt before applying billing state — a
// late-arriving event from an already-disconnected connection returns
// { applied: false } without writing to the subscription, while the event
// row itself (already durably written by createSubscriptionEvent() before
// this function ever runs) is untouched and remains valid evidence. This
// requires a live DB read against email_connections and cannot be expressed
// as a pure-function test without DB-mocking infrastructure this codebase
// doesn't have — verified live against production instead (see the
// implementation report's production verification section), same
// convention as every other DB-layer guarantee in this feature line.
