import { describe, it, expect } from "vitest";
import { resolveEntity } from "./entityResolver";
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
    confidence: 50,
    detectionSource: "deterministic",
    aiModel: null,
    canonicalMerchantName: null,
    canonicalMerchantDomain: null,
    paymentProcessor: null,
    merchantConfidence: null,
    merchantResolutionStatus: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as SubscriptionEvent;
}

describe("Same merchant, multiple events -> grouped correctly", () => {
  it("groups two Spotify events sharing the same domain into one resolved entity", () => {
    const events = [
      makeEvent({ canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
      makeEvent({ canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
    ];
    const results = resolveEntity(events);
    expect(results).toHaveLength(1);
    expect(results[0].canonicalMerchantName).toBe("Spotify");
    expect(results[0].events).toHaveLength(2);
    expect(results[0].resolutionMethod).toBe("domain_match");
    expect(results[0].resolutionStatus).toBe("resolved");
  });

  it("gives a higher confidence to 3 corroborating events than to 1", () => {
    const single = resolveEntity([
      makeEvent({ canonicalMerchantName: "Netflix", canonicalMerchantDomain: "netflix.com", merchantConfidence: 85 }),
    ]);
    const triple = resolveEntity([
      makeEvent({ canonicalMerchantName: "Netflix", canonicalMerchantDomain: "netflix.com", merchantConfidence: 85 }),
      makeEvent({ canonicalMerchantName: "Netflix", canonicalMerchantDomain: "netflix.com", merchantConfidence: 85 }),
      makeEvent({ canonicalMerchantName: "Netflix", canonicalMerchantDomain: "netflix.com", merchantConfidence: 85 }),
    ]);
    expect(triple[0].resolutionConfidence).toBeGreaterThan(single[0].resolutionConfidence);
  });
});

describe("Same domain, different products -> ambiguous, not merged", () => {
  it("does NOT merge two 'Google' events with no distinguishing sub-product signal", () => {
    const events = [
      makeEvent({ canonicalMerchantName: "Google", canonicalMerchantDomain: "google.com", merchantConfidence: 75, extractedMerchant: "Google" }),
      makeEvent({ canonicalMerchantName: "Google", canonicalMerchantDomain: "google.com", merchantConfidence: 75, extractedMerchant: "Google" }),
    ];
    const results = resolveEntity(events);
    // Each stays its own singleton — never silently merged into one "Google" entity.
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.resolutionStatus).toBe("ambiguous");
      expect(r.events).toHaveLength(1);
    }
  });

  it("DOES group two Google events that share the same specific sub-product hint (e.g. both mention 'Play')", () => {
    const events = [
      makeEvent({ canonicalMerchantName: "Google", canonicalMerchantDomain: "google.com", merchantConfidence: 75, extractedMerchant: "Google Play" }),
      makeEvent({ canonicalMerchantName: "Google", canonicalMerchantDomain: "google.com", merchantConfidence: 75, extractedMerchant: "Google Play" }),
    ];
    const results = resolveEntity(events);
    expect(results).toHaveLength(1);
    expect(results[0].events).toHaveLength(2);
    expect(results[0].resolutionMethod).toBe("domain_match_with_product_hint");
  });

  it("keeps 'Google Play' and 'Google Workspace' hints as separate groups, not merged", () => {
    const events = [
      makeEvent({ canonicalMerchantName: "Google", canonicalMerchantDomain: "google.com", merchantConfidence: 75, extractedMerchant: "Google Play" }),
      makeEvent({ canonicalMerchantName: "Google", canonicalMerchantDomain: "google.com", merchantConfidence: 75, extractedMerchant: "Google Workspace" }),
    ];
    const results = resolveEntity(events);
    expect(results).toHaveLength(2);
    expect(results[0].events).toHaveLength(1);
    expect(results[1].events).toHaveLength(1);
  });
});

describe("Payment processor email -> merchant resolved, not processor as entity", () => {
  it("a Stripe-routed Canva receipt resolves to Canva, not Stripe, as the entity", () => {
    const events = [
      makeEvent({
        canonicalMerchantName: "Canva",
        canonicalMerchantDomain: null,
        paymentProcessor: "Stripe",
        extractedMerchant: "Canva",
        merchantConfidence: 75,
      }),
    ];
    const results = resolveEntity(events);
    expect(results).toHaveLength(1);
    expect(results[0].canonicalMerchantName).toBe("Canva");
    expect(results[0].paymentProcessor).toBe("Stripe");
  });

  it("two processor-routed events for the same body-extracted merchant group via processor_body_match", () => {
    const events = [
      makeEvent({ canonicalMerchantName: null, canonicalMerchantDomain: null, paymentProcessor: "PayPal", extractedMerchant: "Grammarly", merchantConfidence: 75 }),
      makeEvent({ canonicalMerchantName: null, canonicalMerchantDomain: null, paymentProcessor: "PayPal", extractedMerchant: "Grammarly", merchantConfidence: 75 }),
    ];
    const results = resolveEntity(events);
    expect(results).toHaveLength(1);
    expect(results[0].resolutionMethod).toBe("processor_body_match");
    expect(results[0].paymentProcessor).toBe("PayPal");
  });
});

describe("one_time_purchase -> excluded from grouping entirely", () => {
  it("a one_time_purchase event never appears in any output group", () => {
    const events = [
      makeEvent({ eventType: "one_time_purchase", canonicalMerchantName: "Facebook", canonicalMerchantDomain: null, merchantConfidence: 50 }),
      makeEvent({ eventType: "subscription_invoice", canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
    ];
    const results = resolveEntity(events);
    const allGroupedEventIds = results.flatMap((r) => r.events.map((e) => e.id));
    expect(allGroupedEventIds).not.toContain(events[0].id);
    expect(allGroupedEventIds).toContain(events[1].id);
  });

  it("a user with ONLY one_time_purchase events produces zero groups", () => {
    const events = [
      makeEvent({ eventType: "one_time_purchase", canonicalMerchantName: "Facebook" }),
      makeEvent({ eventType: "one_time_purchase", canonicalMerchantName: "Facebook" }),
    ];
    expect(resolveEntity(events)).toHaveLength(0);
  });
});

describe("Single event, no corroboration -> unresolved (or low-confidence resolved if the merchant signal itself was strong)", () => {
  it("a single low-confidence, no-domain event is unresolved", () => {
    const results = resolveEntity([
      makeEvent({ canonicalMerchantName: null, canonicalMerchantDomain: null, paymentProcessor: null, extractedMerchant: null, merchantConfidence: null }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].resolutionStatus).toBe("unresolved");
  });

  it("a single event with strong merchant evidence (known_domain, high confidence) is resolved even alone", () => {
    const results = resolveEntity([
      makeEvent({ canonicalMerchantName: "Netflix", canonicalMerchantDomain: "netflix.com", merchantConfidence: 85 }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].resolutionStatus).toBe("resolved");
  });
});

describe("Different userIds -> never merged", () => {
  it("two events with identical merchant/domain but different userIds produce two separate groups", () => {
    const events = [
      makeEvent({ userId: "user-1", canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
      makeEvent({ userId: "user-2", canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
    ];
    const results = resolveEntity(events);
    expect(results).toHaveLength(2);
    const userIds = results.map((r) => r.events[0].userId).sort();
    expect(userIds).toEqual(["user-1", "user-2"]);
    // Neither group's events array crosses into the other user's event.
    for (const r of results) {
      expect(new Set(r.events.map((e) => e.userId)).size).toBe(1);
    }
  });
});

describe("False merge detection", () => {
  it("flags potentialFalseMerge for a group formed on name-only matching (no domain corroboration)", () => {
    const results = resolveEntity([
      makeEvent({ canonicalMerchantName: "Acme Billing", canonicalMerchantDomain: null, merchantConfidence: 50 }),
      makeEvent({ canonicalMerchantName: "Acme Billing", canonicalMerchantDomain: null, merchantConfidence: 50 }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].resolutionMethod).toBe("name_match");
    expect(results[0].potentialFalseMerge).toBe(true);
  });

  it("does NOT flag potentialFalseMerge for a clean domain_match group", () => {
    const results = resolveEntity([
      makeEvent({ canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
      makeEvent({ canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
    ]);
    expect(results[0].potentialFalseMerge).toBe(false);
  });

  it("flags potentialFalseSplit when a weakly-grouped singleton's name fuzzy-matches an established group", () => {
    const events = [
      makeEvent({ canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
      makeEvent({ canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
      // No domain — can't safely merge into the group above, but the name
      // is a clear substring match, so it should be flagged, not merged.
      makeEvent({ canonicalMerchantName: "Spotify Premium", canonicalMerchantDomain: null, merchantConfidence: 40 }),
    ];
    const results = resolveEntity(events);
    const spotifyGroup = results.find((r) => r.resolutionMethod === "domain_match")!;
    const singleton = results.find((r) => r.events.some((e) => e.canonicalMerchantName === "Spotify Premium"))!;
    expect(spotifyGroup.events).toHaveLength(2); // not merged with the singleton
    expect(singleton.potentialFalseSplit).toBe(true);
  });

  it("upgrades resolutionStatus to 'conflict' when a domain_match group has distinct raw extractedMerchant text", () => {
    const events = [
      makeEvent({
        canonicalMerchantName: "SharedDomain", canonicalMerchantDomain: "shareddomain.com",
        extractedMerchant: "Product A", merchantConfidence: 60,
      }),
      makeEvent({
        canonicalMerchantName: "SharedDomain", canonicalMerchantDomain: "shareddomain.com",
        extractedMerchant: "Product B", merchantConfidence: 60,
      }),
    ];
    const results = resolveEntity(events);
    expect(results).toHaveLength(1);
    expect(results[0].resolutionStatus).toBe("conflict");
  });
});

describe("Purity / determinism (excluding proposedSubscriptionId, which is a fresh UUID by design)", () => {
  it("produces identical grouping/status/confidence on repeated calls with the same input", () => {
    const events = [
      makeEvent({ canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
      makeEvent({ canonicalMerchantName: "Spotify", canonicalMerchantDomain: "spotify.com", merchantConfidence: 85 }),
    ];
    const a = resolveEntity(events);
    const b = resolveEntity(events);
    expect(a[0].proposedSubscriptionId).not.toBe(b[0].proposedSubscriptionId); // fresh UUID each call, by design
    expect(a[0].canonicalMerchantName).toBe(b[0].canonicalMerchantName);
    expect(a[0].resolutionConfidence).toBe(b[0].resolutionConfidence);
    expect(a[0].resolutionMethod).toBe(b[0].resolutionMethod);
    expect(a[0].resolutionStatus).toBe(b[0].resolutionStatus);
    expect(a[0].events.map((e) => e.id)).toEqual(b[0].events.map((e) => e.id));
  });
});
