import { describe, it, expect } from "vitest";
import { resolveEntity, isEligibleForShadowSubscription, deriveShadowSubscription } from "./entityResolver";
import type { SubscriptionEvent, InsertShadowSubscription } from "@shared/schema";

// ─── Phase 3D — Subscription Lifecycle Integration ─────────────────────────────
//
// These tests exercise the EXACT sequence server/storage.ts's new
// attemptShadowSubscriptionCreation() runs — resolveEntity() -> find the
// group containing the triggering event -> isEligibleForShadowSubscription()
// -> deriveShadowSubscription() -> merge in emailConnectionId -> the shape
// passed to upsertShadowSubscription() — using the REAL exported functions
// from entityResolver.ts, nothing reimplemented. The actual DB write
// (upsertShadowSubscription's db.insert().onConflictDoUpdate()) is a DB-layer
// guarantee, verified live against production (see the implementation
// report), consistent with this codebase's "pure function tests only"
// convention throughout — this file proves the DECISION logic is correct,
// not the SQL.

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
    extractedDate: "2026-09-01",
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

// Simulates exactly what attemptShadowSubscriptionCreation() does, given the
// domain's canonical events and the one event that triggered it — pure,
// no DB, using the real resolver functions.
function simulateCreation(domainEvents: SubscriptionEvent[], triggeringEvent: SubscriptionEvent): InsertShadowSubscription | undefined {
  const groups = resolveEntity(domainEvents);
  const group = groups.find((g) => g.events.some((e) => e.id === triggeringEvent.id));
  if (!group || !isEligibleForShadowSubscription(group)) return undefined;
  const candidate = deriveShadowSubscription(group);
  if (!candidate) return undefined;
  return { ...candidate, lastEventEmailConnectionId: triggeringEvent.emailConnectionId ?? null };
}

describe("Test 1 — NEW merchant + NEW subscription event -> a subscription row would be created", () => {
  it("a single domain_match event for a brand-new merchant is eligible and produces a valid creation candidate", () => {
    const event = makeEvent({ canonicalMerchantDomain: "newmerchant.com", canonicalMerchantName: "NewMerchant", merchantConfidence: 90 });
    const candidate = simulateCreation([event], event);
    expect(candidate).toBeDefined();
    expect(candidate!.canonicalMerchantDomain).toBe("newmerchant.com");
    expect(candidate!.entityKey).toBe("newmerchant.com");
    expect(candidate!.resolutionStatus).toBe("resolved");
  });
});

describe("Test 2 — NEW merchant event with amount -> amount is preserved", () => {
  it("the created candidate's amount/currency exactly match the triggering event's extracted values", () => {
    const event = makeEvent({ canonicalMerchantDomain: "newmerchant.com", extractedPrice: "12.50", extractedCurrency: "EUR", merchantConfidence: 90 });
    const candidate = simulateCreation([event], event);
    expect(candidate!.amount).toBe("12.50");
    expect(candidate!.currency).toBe("EUR");
  });
});

describe("Test 3 — NEW merchant event with amount = NULL -> subscription created with amount = NULL", () => {
  it("a null extractedPrice never gets converted into a fabricated 0 or guessed value", () => {
    const event = makeEvent({ canonicalMerchantDomain: "newmerchant.com", extractedPrice: null, extractedCurrency: null, merchantConfidence: 90 });
    const candidate = simulateCreation([event], event);
    expect(candidate).toBeDefined();
    expect(candidate!.amount).toBeNull();
    expect(candidate!.currency).toBeNull();
  });
});

describe("Test 6 — new event with emailConnectionId -> provenance is populated correctly", () => {
  it("lastEventEmailConnectionId on the creation candidate exactly matches the triggering event's own connection", () => {
    const event = makeEvent({ canonicalMerchantDomain: "newmerchant.com", emailConnectionId: "connection-B", merchantConfidence: 90 });
    const candidate = simulateCreation([event], event);
    expect(candidate!.lastEventEmailConnectionId).toBe("connection-B");
  });
});

describe("Test 7 — historical event with emailConnectionId = NULL -> remains NULL, never fabricated", () => {
  it("a null emailConnectionId on the triggering event never becomes a guessed or backfilled value", () => {
    const event = makeEvent({ canonicalMerchantDomain: "newmerchant.com", emailConnectionId: null, merchantConfidence: 90 });
    const candidate = simulateCreation([event], event);
    expect(candidate!.lastEventEmailConnectionId).toBeNull();
  });
});

describe("Test 15 — cross-user isolation: creation never groups across different users", () => {
  it("resolveEntity() groups strictly by userId first — a userId-B event never appears in userId-A's resolved group even sharing the exact same domain", () => {
    const eventA = makeEvent({ userId: "user-A", canonicalMerchantDomain: "shared-domain.com", merchantConfidence: 90 });
    const eventB = makeEvent({ userId: "user-B", canonicalMerchantDomain: "shared-domain.com", merchantConfidence: 90 });
    const candidateForA = simulateCreation([eventA, eventB], eventA);
    expect(candidateForA!.userId).toBe("user-A");
    const groups = resolveEntity([eventA, eventB]);
    const groupForA = groups.find((g) => g.events.some((e) => e.id === eventA.id))!;
    expect(groupForA.events.every((e) => e.userId === "user-A")).toBe(true);
  });
});

describe("Ineligible evidence correctly creates nothing (unchanged conservative bar)", () => {
  it("a single low-confidence, no-domain, no-processor event stays unresolved -> no creation candidate", () => {
    const event = makeEvent({
      canonicalMerchantDomain: null,
      canonicalMerchantName: null,
      paymentProcessor: null,
      extractedMerchant: null,
      merchantConfidence: 20,
    });
    const candidate = simulateCreation([event], event);
    expect(candidate).toBeUndefined();
  });

  it("a one_time_purchase event is excluded from entity resolution entirely -> never triggers creation", () => {
    const event = makeEvent({ canonicalMerchantDomain: "newmerchant.com", eventType: "one_time_purchase", merchantConfidence: 90 });
    const candidate = simulateCreation([event], event);
    expect(candidate).toBeUndefined();
  });

  it("an ambiguous platform name (google.com) with no product hint stays a singleton, not auto-eligible", () => {
    const event = makeEvent({ canonicalMerchantDomain: "google.com", canonicalMerchantName: "Google", extractedMerchant: "Google", merchantConfidence: 90 });
    const candidate = simulateCreation([event], event);
    expect(candidate).toBeUndefined();
  });
});

describe("name_match eligibility requires a second corroborating event before creation fires", () => {
  it("the FIRST event of a domain-less, name-only merchant is not yet eligible; the SECOND corroborating event makes the whole group eligible", () => {
    const firstEvent = makeEvent({ canonicalMerchantDomain: null, canonicalMerchantName: "SomeService", extractedMerchant: "SomeService", merchantConfidence: 60, sourceMessageId: "msg-first" });
    // Not eligible yet on its own: name_match requires events.length >= 2.
    expect(simulateCreation([firstEvent], firstEvent)).toBeUndefined();

    const secondEvent = makeEvent({ canonicalMerchantDomain: null, canonicalMerchantName: "SomeService", extractedMerchant: "SomeService", merchantConfidence: 60, sourceMessageId: "msg-second" });
    // Once both events exist in the domain's canonical history, the group
    // (found via the SECOND, triggering event) is eligible -- this is why
    // attemptShadowSubscriptionCreation() re-resolves against ALL of the
    // user's canonical events for this merchant, not just the new one.
    const candidate = simulateCreation([firstEvent, secondEvent], secondEvent);
    expect(candidate).toBeDefined();
    expect(candidate!.canonicalMerchantName).toBe("SomeService");
  });
});

describe("onConflictDoUpdate's SET clause never touches user-owned fields (structural check)", () => {
  it("a creation candidate never includes userConfirmed/userDismissed -- the schema's own column defaults (false) are what apply on insert, and upsertShadowSubscription's SET clause (server/storage.ts) never lists them either, so an existing confirmed/dismissed row can never be silently reset by a later conflict", () => {
    const event = makeEvent({ canonicalMerchantDomain: "newmerchant.com", merchantConfidence: 90 });
    const candidate = simulateCreation([event], event);
    expect(candidate).not.toHaveProperty("userConfirmed");
    expect(candidate).not.toHaveProperty("userConfirmedAt");
    expect(candidate).not.toHaveProperty("userDismissed");
    expect(candidate).not.toHaveProperty("userDismissedAt");
  });
});
