// ─── Shadow subscription promotion eligibility — pure mirror (Phase 3B.7.4) ────
//
// The REAL enforcement point is the SQL fragment shared by
// storage.promoteEligibleShadowSubscriptions() and
// storage.previewShadowSubscriptionPromotion() (server/storage.ts's private
// shadowPromotionEligibilityWhere()) — per the task's explicit requirement,
// eligibility must live in the SQL WHERE clause, not application code, so
// that's what the actual UPDATE and preview both run against.
//
// This file is a PURE, DB-free mirror of those exact same six rules,
// existing only so the rules themselves get fast, deterministic Vitest
// coverage — this repo has no test-database infrastructure (every existing
// *.test.ts file tests pure functions, never live SQL), so this is the only
// practical way to unit-test "does the eligibility logic classify this row
// correctly" without standing up a whole new DB-testing harness for one
// feature. isEligibleForPromotion() is never called by the real promotion
// path — if the SQL WHERE clause in storage.ts ever changes, this mirror
// must be updated to match, or the two will drift.

export type ShadowPromotionRow = {
  id: string;
  userId: string;
  canonicalMerchantDomain: string | null;
  resolutionStatus: string;
  resolutionMethod: string;
  isShadow: boolean;
  potentialFalseMerge: boolean;
};

export function isEligibleForPromotion(
  row: ShadowPromotionRow,
  allRowsForUser: ShadowPromotionRow[]
): boolean {
  const basicEligible =
    row.isShadow === true &&
    row.resolutionStatus === "resolved" &&
    row.resolutionMethod === "domain_match" &&
    row.canonicalMerchantDomain !== null &&
    row.potentialFalseMerge === false;

  if (!basicEligible) return false;

  // Mirrors the SQL's trailing NOT EXISTS: never promote a second row for a
  // (userId, canonicalMerchantDomain) pair that already has an active
  // (isShadow=false) row — this is what makes repeated promotion runs
  // idempotent and prevents duplicate active subscriptions.
  const hasActiveSiblingForSameDomain = allRowsForUser.some(
    (r) =>
      r.id !== row.id &&
      r.userId === row.userId &&
      r.canonicalMerchantDomain === row.canonicalMerchantDomain &&
      r.isShadow === false
  );

  return !hasActiveSiblingForSameDomain;
}
