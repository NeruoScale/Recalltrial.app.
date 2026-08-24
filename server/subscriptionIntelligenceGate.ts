// ─── Subscription Intelligence V1 — controlled-beta access gate ───────────────
//
// Same "pure, unit-testable access decision" pattern as server/subscriptionVault.ts's
// determineSubscriptionAccessResult() — the actual Express middleware
// (server/routes.ts's requireSubscriptionIntelligence) is thin plumbing that
// just calls this and translates the result to an HTTP response; this
// function is what's actually testable without a database or a live request.
//
// Gates ONLY the Phase 3C.1-3C.4 intelligence layer (savings opportunities,
// recommendations, AI analyst, track/confirm/dismiss) — never the underlying
// subscription detection/vault (Phase 3B, already fully launched), which has
// no dependency on this gate at all.

export type SubscriptionIntelligenceAccessResult =
  | { status: 401 }
  | { status: 403; code: "SUBSCRIPTION_INTELLIGENCE_NOT_ENABLED" }
  | { status: 200 };

export function determineSubscriptionIntelligenceAccess(
  sessionUserId: string | undefined,
  user: { subscriptionIntelligenceEnabled: boolean } | undefined
): SubscriptionIntelligenceAccessResult {
  if (!sessionUserId) return { status: 401 };
  if (!user || !user.subscriptionIntelligenceEnabled) {
    return { status: 403, code: "SUBSCRIPTION_INTELLIGENCE_NOT_ENABLED" };
  }
  return { status: 200 };
}
