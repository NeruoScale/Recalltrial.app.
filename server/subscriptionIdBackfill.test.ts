import { describe, it, expect } from "vitest";
import { resolveSubscriptionIdForEvent, type BackfillCandidateEvent, type BackfillCandidateSubscription } from "./subscriptionIdBackfill";

function makeEvent(overrides: Partial<BackfillCandidateEvent> = {}): BackfillCandidateEvent {
  return {
    id: "evt-1",
    userId: "user-1",
    canonicalMerchantDomain: "anthropic.com",
    canonicalMerchantName: "Anthropic",
    isCanonical: true,
    subscriptionId: null,
    ...overrides,
  };
}

function makeSub(overrides: Partial<BackfillCandidateSubscription> = {}): BackfillCandidateSubscription {
  return {
    id: "sub-1",
    userId: "user-1",
    canonicalMerchantDomain: "anthropic.com",
    canonicalMerchantName: "Anthropic",
    ...overrides,
  };
}

describe("Phase 3B.9.6A: resolveSubscriptionIdForEvent()", () => {
  it("unique match by domain -> subscriptionId resolved", () => {
    const event = makeEvent({ canonicalMerchantDomain: "anthropic.com" });
    const subs = [makeSub({ id: "sub-1", canonicalMerchantDomain: "anthropic.com" })];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBe("sub-1");
  });

  it("unique match by name (event has null domain) -> subscriptionId resolved", () => {
    const event = makeEvent({ canonicalMerchantDomain: null, canonicalMerchantName: "Proton" });
    const subs = [makeSub({ id: "sub-proton", canonicalMerchantDomain: null, canonicalMerchantName: "Proton" })];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBe("sub-proton");
  });

  it("ambiguous match (2+ subscriptions) -> stays null", () => {
    const event = makeEvent({ canonicalMerchantDomain: null, canonicalMerchantName: "Google" });
    const subs = [
      makeSub({ id: "sub-a", canonicalMerchantDomain: null, canonicalMerchantName: "Google" }),
      makeSub({ id: "sub-b", canonicalMerchantDomain: null, canonicalMerchantName: "Google" }),
    ];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBeNull();
  });

  it("no match (0 subscriptions match) -> stays null", () => {
    const event = makeEvent({ canonicalMerchantDomain: "facebook.com" });
    const subs = [makeSub({ id: "sub-1", canonicalMerchantDomain: "anthropic.com" })];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBeNull();
  });

  it("superseded events (isCanonical=false) are never backfilled", () => {
    const event = makeEvent({ isCanonical: false, canonicalMerchantDomain: "anthropic.com" });
    const subs = [makeSub({ id: "sub-1", canonicalMerchantDomain: "anthropic.com" })];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBeNull();
  });

  it("events that already have a subscriptionId are never re-resolved", () => {
    const event = makeEvent({ subscriptionId: "sub-existing", canonicalMerchantDomain: "anthropic.com" });
    const subs = [makeSub({ id: "sub-1", canonicalMerchantDomain: "anthropic.com" })];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBeNull();
  });

  it("cross-user: a candidate subscription belonging to a different user is never matched", () => {
    const event = makeEvent({ userId: "user-A", canonicalMerchantDomain: "anthropic.com" });
    const subs = [makeSub({ id: "sub-userB", userId: "user-B", canonicalMerchantDomain: "anthropic.com" })];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBeNull();
  });

  it("cross-user: same domain, two different users' subscriptions -> only the matching user's counts toward uniqueness", () => {
    const event = makeEvent({ userId: "user-A", canonicalMerchantDomain: "anthropic.com" });
    const subs = [
      makeSub({ id: "sub-A", userId: "user-A", canonicalMerchantDomain: "anthropic.com" }),
      makeSub({ id: "sub-B", userId: "user-B", canonicalMerchantDomain: "anthropic.com" }),
    ];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBe("sub-A");
  });

  it("event has a domain but candidate subscription only matches by name -> no match (domain takes priority per the event's own domain-null-ness)", () => {
    const event = makeEvent({ canonicalMerchantDomain: "anthropic.com", canonicalMerchantName: "Anthropic" });
    const subs = [makeSub({ id: "sub-1", canonicalMerchantDomain: "other.com", canonicalMerchantName: "Anthropic" })];
    expect(resolveSubscriptionIdForEvent(event, subs)).toBeNull();
  });
});
