import { describe, it, expect } from "vitest";
import { sourcePrecedence, isEligibleToUpgrade } from "./sourcePrecedence";

describe("Phase 3B.9.7-PATCH: sourcePrecedence()", () => {
  it("ranks ai > body > snippet > metadata > null", () => {
    expect(sourcePrecedence("ai")).toBe(4);
    expect(sourcePrecedence("body")).toBe(3);
    expect(sourcePrecedence("snippet")).toBe(2);
    expect(sourcePrecedence("metadata")).toBe(1);
    expect(sourcePrecedence(null)).toBe(0);
    expect(sourcePrecedence(undefined)).toBe(0);
  });

  it("an unrecognized source string is treated as the lowest tier, not an error", () => {
    expect(sourcePrecedence("something-unexpected")).toBe(0);
  });
});

describe("Phase 3B.9.7-PATCH: isEligibleToUpgrade()", () => {
  it("higher quality source upgrades lower quality: body > snippet -> eligible", () => {
    expect(isEligibleToUpgrade("body", "snippet")).toBe(true);
  });

  it("lower quality source does not downgrade: snippet vs body -> not eligible", () => {
    expect(isEligibleToUpgrade("snippet", "body")).toBe(false);
  });

  it("same source is eligible (fresher data at the same tier): body -> body", () => {
    expect(isEligibleToUpgrade("body", "body")).toBe(true);
  });

  it("null/unknown existing source always upgrades to any real source", () => {
    expect(isEligibleToUpgrade("body", null)).toBe(true);
    expect(isEligibleToUpgrade("snippet", null)).toBe(true);
    expect(isEligibleToUpgrade("metadata", null)).toBe(true);
  });

  it("AI source is never downgraded by anything lower", () => {
    expect(isEligibleToUpgrade("body", "ai")).toBe(false);
    expect(isEligibleToUpgrade("snippet", "ai")).toBe(false);
    expect(isEligibleToUpgrade("metadata", "ai")).toBe(false);
    expect(isEligibleToUpgrade(null, "ai")).toBe(false);
  });

  it("ai -> ai is eligible (fresher AI data can still replace older AI data)", () => {
    expect(isEligibleToUpgrade("ai", "ai")).toBe(true);
  });
});
