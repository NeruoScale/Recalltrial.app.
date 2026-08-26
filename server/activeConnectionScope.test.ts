import { describe, it, expect } from "vitest";
import { isSubscriptionVisibleForActiveConnection } from "./activeConnectionScope";

describe("isSubscriptionVisibleForActiveConnection", () => {
  it("never-attributed subscription (ownerConnectionId=null) is visible even with an active connection present", () => {
    expect(isSubscriptionVisibleForActiveConnection(null, undefined, { id: "conn-B", providerAccountId: "sub-B" })).toBe(true);
  });

  it("never-attributed subscription (ownerConnectionId=null) is visible even with NO active connection at all", () => {
    expect(isSubscriptionVisibleForActiveConnection(null, undefined, null)).toBe(true);
  });

  it("owner known, but no active connection at all (Gmail fully disconnected) -> hidden", () => {
    expect(isSubscriptionVisibleForActiveConnection("conn-A", { id: "conn-A", providerAccountId: "sub-A" }, null)).toBe(false);
  });

  it("owner connection id exactly matches the active connection id -> visible", () => {
    expect(isSubscriptionVisibleForActiveConnection("conn-A", { id: "conn-A", providerAccountId: "sub-A" }, { id: "conn-A", providerAccountId: "sub-A" })).toBe(true);
  });

  it("different connection ROW, but same stable providerAccountId (reconnect of the same Gmail account) -> visible", () => {
    expect(isSubscriptionVisibleForActiveConnection(
      "conn-A-session-1",
      { id: "conn-A-session-1", providerAccountId: "sub-A" },
      { id: "conn-A-session-2", providerAccountId: "sub-A" }
    )).toBe(true);
  });

  it("different connection ROW and different providerAccountId (genuinely a different Gmail account) -> hidden", () => {
    expect(isSubscriptionVisibleForActiveConnection(
      "conn-A",
      { id: "conn-A", providerAccountId: "sub-A" },
      { id: "conn-B", providerAccountId: "sub-B" }
    )).toBe(false);
  });

  it("different connection ROW, identity unavailable on the owner side -> hidden (rows already known to differ)", () => {
    expect(isSubscriptionVisibleForActiveConnection(
      "conn-A",
      { id: "conn-A", providerAccountId: null },
      { id: "conn-B", providerAccountId: "sub-B" }
    )).toBe(false);
  });

  it("different connection ROW, identity unavailable on the active side -> hidden", () => {
    expect(isSubscriptionVisibleForActiveConnection(
      "conn-A",
      { id: "conn-A", providerAccountId: "sub-A" },
      { id: "conn-B", providerAccountId: null }
    )).toBe(false);
  });

  it("different connection ROW, owner connection object itself unavailable (undefined) -> hidden", () => {
    expect(isSubscriptionVisibleForActiveConnection("conn-A", undefined, { id: "conn-B", providerAccountId: "sub-B" })).toBe(false);
  });
});
