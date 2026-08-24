import { describe, it, expect } from "vitest";
import { determineSubscriptionIntelligenceAccess } from "./subscriptionIntelligenceGate";

describe("Subscription Intelligence V1 beta gate: determineSubscriptionIntelligenceAccess()", () => {
  it("no session -> 401, regardless of the user's flag value", () => {
    expect(determineSubscriptionIntelligenceAccess(undefined, { subscriptionIntelligenceEnabled: true })).toEqual({ status: 401 });
    expect(determineSubscriptionIntelligenceAccess(undefined, undefined)).toEqual({ status: 401 });
  });

  it("session present but user record missing -> 403 (fails safe, never 200)", () => {
    expect(determineSubscriptionIntelligenceAccess("user-1", undefined)).toEqual({
      status: 403,
      code: "SUBSCRIPTION_INTELLIGENCE_NOT_ENABLED",
    });
  });

  it("flag is false (the default) -> 403", () => {
    expect(determineSubscriptionIntelligenceAccess("user-1", { subscriptionIntelligenceEnabled: false })).toEqual({
      status: 403,
      code: "SUBSCRIPTION_INTELLIGENCE_NOT_ENABLED",
    });
  });

  it("flag is true -> 200 (only case that grants access)", () => {
    expect(determineSubscriptionIntelligenceAccess("user-1", { subscriptionIntelligenceEnabled: true })).toEqual({ status: 200 });
  });

  it("fails safe: every falsy/undefined shape of the flag denies access, never accidentally grants it", () => {
    const falsyShapes = [false, undefined, null] as any[];
    for (const shape of falsyShapes) {
      const result = determineSubscriptionIntelligenceAccess("user-1", { subscriptionIntelligenceEnabled: shape });
      expect(result.status).not.toBe(200);
    }
  });
});
