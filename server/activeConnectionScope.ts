// ─── Active Connection Isolation — Subscription Intelligence scoping ──────────
//
// Product rule (RecallTrial — Active Gmail Subscription Isolation task):
//   Active Subscription Intelligence = subscription data derived from the
//   CURRENTLY ACTIVE email connection. It is not a permanent user-wide cache
//   across every Gmail account a user has ever connected.
//
// This module answers exactly one pure question — given a subscription's
// recorded connection ownership and the user's current active connection (if
// any), should this subscription appear in the ACTIVE view (vault/savings/
// recommendations/analyst)? It never deletes or rewrites history; it only
// decides visibility for the caller (server/storage.ts).
//
// Audit finding this module is built on (see the implementation report for
// the full write-up): the existing schema — email_connections,
// subscription_events.emailConnectionId, subscriptions.lastEventEmailConnectionId
// — is SUFFICIENT for this. No new column was added. lastEventEmailConnectionId
// (introduced by the earlier Email Connection Isolation Architecture phase to
// track "which connection last supplied this subscription's billing data")
// doubles as the ownership pointer here — see storage.ts's
// getShadowSubscriptionsForUser/attributeUnownedSubscriptionsToConnection for
// how it's kept correct at read time and at disconnect time.
export type ConnectionIdentity = { id: string; providerAccountId: string | null } | null | undefined;

/**
 * isSubscriptionVisibleForActiveConnection(): pure ownership check.
 *
 * ownerConnectionId === null means "never attributed to any connection" —
 * either a legacy row that predates this architecture, or a subscription
 * whose user has never disconnected since Phase B/C shipped. This is
 * deliberately treated as VISIBLE, never hidden without POSITIVE evidence it
 * belongs to a different account — this is what keeps every existing user
 * who has never switched Gmail accounts completely unaffected by this
 * feature shipping.
 */
export function isSubscriptionVisibleForActiveConnection(
  ownerConnectionId: string | null,
  ownerConnection: ConnectionIdentity,
  activeConnection: ConnectionIdentity
): boolean {
  if (ownerConnectionId === null) return true;

  // Owner is known, but there is currently no active connection at all
  // (Gmail fully disconnected) — nothing is visible.
  if (!activeConnection) return false;

  // Exact same connection row — the common case, no switch has happened.
  if (ownerConnectionId === activeConnection.id) return true;

  // A different connection ROW could still be the same real Gmail account
  // reconnected (a fresh session always creates a new row). Compare the
  // STABLE Google identity, never the raw row id — same reasoning as
  // storage.ts's applyLifecycleEventToSubscription uses for cross-account
  // conflict detection.
  if (ownerConnection?.providerAccountId && activeConnection.providerAccountId) {
    return ownerConnection.providerAccountId === activeConnection.providerAccountId;
  }

  // Different row, and identity can't be verified on one/both sides — the
  // rows are already known to differ, so treat this as a different account.
  return false;
}
