import { describe, it, expect } from "vitest";
import { isEligibleForPromotion, type ShadowPromotionRow } from "./shadowPromotion";

let idCounter = 0;
function makeRow(overrides: Partial<ShadowPromotionRow> = {}): ShadowPromotionRow {
  idCounter++;
  return {
    id: `sub-${idCounter}`,
    userId: "user-1",
    canonicalMerchantDomain: "anthropic.com",
    resolutionStatus: "resolved",
    resolutionMethod: "domain_match",
    isShadow: true,
    potentialFalseMerge: false,
    ...overrides,
  };
}

describe("Phase 3B.7.4: shadow subscription promotion eligibility", () => {
  it("eligible domain_match row -> promoted", () => {
    const row = makeRow();
    expect(isEligibleForPromotion(row, [row])).toBe(true);
  });

  it("name_match only (e.g. Proton, Urban) -> NOT promoted", () => {
    const row = makeRow({ resolutionMethod: "name_match", canonicalMerchantDomain: null });
    expect(isEligibleForPromotion(row, [row])).toBe(false);
  });

  it("processor-only (processor_body_match) -> NOT promoted", () => {
    const row = makeRow({ resolutionMethod: "processor_body_match", canonicalMerchantDomain: null });
    expect(isEligibleForPromotion(row, [row])).toBe(false);
  });

  it("ambiguous_platform_name (Google singleton rows) -> NOT promoted", () => {
    const row = makeRow({ resolutionMethod: "ambiguous_platform_name", canonicalMerchantDomain: "google.com" });
    expect(isEligibleForPromotion(row, [row])).toBe(false);
  });

  it("potentialFalseMerge=true -> NOT promoted, even for domain_match", () => {
    const row = makeRow({ potentialFalseMerge: true });
    expect(isEligibleForPromotion(row, [row])).toBe(false);
  });

  it("resolutionStatus=conflict -> NOT promoted", () => {
    const row = makeRow({ resolutionStatus: "conflict" });
    expect(isEligibleForPromotion(row, [row])).toBe(false);
  });

  it("canonicalMerchantDomain is null -> NOT promoted even if method says domain_match", () => {
    const row = makeRow({ canonicalMerchantDomain: null });
    expect(isEligibleForPromotion(row, [row])).toBe(false);
  });

  it("already-active sibling for the same (userId, domain) -> NOT promoted again (idempotency precondition)", () => {
    const alreadyActive = makeRow({ id: "sub-active", isShadow: false });
    const candidate = makeRow({ id: "sub-candidate", canonicalMerchantDomain: alreadyActive.canonicalMerchantDomain });
    expect(isEligibleForPromotion(candidate, [alreadyActive, candidate])).toBe(false);
  });

  it("a row that IS the already-active one is unaffected by its own presence in the sibling list", () => {
    const row = makeRow({ isShadow: false });
    // isShadow=false already fails basicEligible on its own (re-promoting an
    // already-promoted row is a no-op) — this locks that in explicitly.
    expect(isEligibleForPromotion(row, [row])).toBe(false);
  });

  it("cross-user isolation: an active subscription for a DIFFERENT user never blocks this user's eligible row", () => {
    const otherUserActive = makeRow({ id: "sub-other", userId: "user-2", isShadow: false });
    const candidate = makeRow({ id: "sub-mine", userId: "user-1" });
    expect(isEligibleForPromotion(candidate, [otherUserActive, candidate])).toBe(true);
  });

  it("running eligibility twice on the same immutable input set is deterministic (idempotent by construction)", () => {
    const row = makeRow();
    const first = isEligibleForPromotion(row, [row]);
    const second = isEligibleForPromotion(row, [row]);
    expect(first).toBe(second);
    expect(first).toBe(true);
  });
});
