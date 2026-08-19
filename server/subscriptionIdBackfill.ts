// ─── subscriptionId FK backfill — matching decision (Phase 3B.9.6A) ────────────
//
// The REAL enforcement point is the SQL in server/migrate.ts's idempotent
// boot-time backfill (mirrors the exact same match/unique-resolution rule
// as a single UPDATE ... FROM, per this task's requirement that eligibility
// be computed in the database, not row-by-row in application code for a
// table this size). This file is a PURE, DB-free mirror of that same
// matching rule, existing only so the rule itself gets fast, deterministic
// Vitest coverage — this repo has no test-database infrastructure (every
// existing *.test.ts file tests a pure function, never live SQL), matching
// the exact precedent already established for server/shadowPromotion.ts.
// isEligibleSubscriptionMatch()/resolveSubscriptionIdForEvent() are never
// called by the real backfill path — if the SQL in migrate.ts ever
// changes, this mirror must be updated to match, or the two will drift.

import type { SubscriptionEvent, ShadowSubscription } from "@shared/schema";

export type BackfillCandidateEvent = Pick<
  SubscriptionEvent,
  "id" | "userId" | "canonicalMerchantDomain" | "canonicalMerchantName" | "isCanonical"
> & { subscriptionId?: string | null };

export type BackfillCandidateSubscription = Pick<
  ShadowSubscription,
  "id" | "userId" | "canonicalMerchantDomain" | "canonicalMerchantName"
>;

/**
 * Mirrors the exact match criteria from the task:
 *   event.userId = subscription.userId AND
 *     (event.canonicalMerchantDomain = subscription.canonicalMerchantDomain
 *        WHEN event.canonicalMerchantDomain is not null,
 *      ELSE event.canonicalMerchantName = subscription.canonicalMerchantName)
 * Deliberately keyed off the EVENT's domain-null-ness, not the
 * subscription's — an event with a known domain only matches subscriptions
 * sharing that exact domain; an event with no domain falls back to a name
 * match regardless of what the candidate subscription's own domain is.
 */
function isMatch(event: BackfillCandidateEvent, subscription: BackfillCandidateSubscription): boolean {
  if (event.userId !== subscription.userId) return false;
  if (event.canonicalMerchantDomain !== null) {
    return subscription.canonicalMerchantDomain === event.canonicalMerchantDomain;
  }
  return subscription.canonicalMerchantName === event.canonicalMerchantName;
}

/**
 * resolveSubscriptionIdForEvent(): returns the matched subscription id only
 * when EXACTLY ONE subscription matches — 0 or 2+ matches both resolve to
 * null (leave subscriptionId untouched), per the task's explicit "only link
 * if exactly ONE subscription matches" rule. Never considers non-canonical
 * events or events that already have a subscriptionId — the caller is
 * expected to have already filtered to eligible rows (isCanonical=true AND
 * subscriptionId IS NULL), matching the real SQL's WHERE clause; this
 * function re-checks isCanonical/subscriptionId defensively anyway so it's
 * correct even if a caller forgets to pre-filter.
 */
export function resolveSubscriptionIdForEvent(
  event: BackfillCandidateEvent,
  candidateSubscriptions: BackfillCandidateSubscription[]
): string | null {
  if (!event.isCanonical) return null;
  if (event.subscriptionId) return null; // already has one — not eligible for backfill

  const matches = candidateSubscriptions.filter((s) => isMatch(event, s));
  if (matches.length !== 1) return null;
  return matches[0].id;
}
