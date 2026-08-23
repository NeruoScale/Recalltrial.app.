// ─── Subscription Vault — detail view response builder (Phase 3B.9.5) ──────────
//
// Same separation-of-concerns pattern as subscriptionCostEngine.ts/
// renewalCalendar.ts/subscriptionLifecycle.ts: no DB access here, pure and
// deterministic, unit-testable without a live database (this codebase has
// zero DB-touching tests anywhere — every existing *.test.ts file tests a
// pure module directly, and this follows that same discipline rather than
// introducing the first DB-integration test).
//
// The actual DB queries (fetch-by-id-and-userId, fetch-canonical-events)
// live in storage.ts, matching where every other query in this codebase
// lives; this module only shapes already-fetched data into the API response.

import type { ShadowSubscription, SubscriptionEvent } from "@shared/schema";
import { calculateSubscriptionCosts, type SubscriptionWithCost } from "./subscriptionCostEngine";
import type { BillingIntervalSource } from "./billingIntelligence";
import { buildPriceHistory, type PriceHistoryResult } from "./priceHistory";
import { detectPriceChanges, type PriceChangeResult } from "./priceChangeDetector";

// ─── Event type labels ──────────────────────────────────────────────────────
//
// Covers every value of shared/schema.ts's subscriptionEventTypeEnum (16
// total) — not just the ones a specific request happened to mention. An
// unrecognized future enum value still falls back to a readable label
// (Title Case of the raw value) rather than leaking the raw snake_case
// enum name to the user.
const EVENT_TYPE_LABELS: Record<string, string> = {
  trial_started: "Trial started",
  trial_ending: "Trial ending",
  subscription_started: "Subscription started",
  subscription_renewed: "Renewed",
  payment_received: "Payment received",
  invoice_received: "Invoice received",
  price_changed: "Price changed",
  cancellation_requested: "Cancellation requested",
  cancellation_confirmed: "Cancellation confirmed",
  subscription_expired: "Expired",
  subscription_paused: "Paused",
  unknown_subscription_event: "Subscription activity",
  subscription_invoice: "Invoice",
  one_time_purchase: "One-time purchase",
  subscription_cancelled: "Cancelled",
  payment_failed: "Payment failed",
};

export function eventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? eventType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Billing provenance display label ───────────────────────────────────────
//
// Mirrors client/src/pages/subscriptions.tsx's formatBillingProvenance()
// wording exactly (that function already established these phrases for the
// list view) so the detail view never says something different for the same
// underlying billingIntervalSource value.
export function billingDisplayLabel(source: string | null): string {
  switch (source as BillingIntervalSource | null) {
    case "confirmed_email": return "Confirmed from email";
    case "merchant_knowledge": return "Based on plan details";
    case "inferred": return "Based on recurring billing pattern";
    default: return "Unknown";
  }
}

// ─── History entry shape ────────────────────────────────────────────────────

export type SubscriptionHistoryEntry = {
  id: string;
  date: string;
  eventType: string;
  eventTypeLabel: string;
  amount: string | null;
  currency: string | null;
  confidence: number;
  sourceMessageId: string;
};

/**
 * eventDate(): extractedDate (the date the email/evidence actually refers
 * to) is preferred when present; createdAt (when we recorded the event) is
 * the fallback for events whose extraction couldn't determine a date — never
 * omitted entirely, since every history row needs something to sort/display
 * by, but never fabricated beyond "when we saw it."
 */
function eventDate(event: SubscriptionEvent): string {
  return event.extractedDate ?? event.createdAt.toISOString().slice(0, 10);
}

/**
 * buildHistory(): filters to isCanonical=true only (STRICT BOUNDARY — a
 * superseded classification must never reach the user, regardless of what
 * the caller passes in) and sorts most-recent-first by the same resolved
 * date used for display. Ties (same date) break by createdAt descending so
 * ordering is still deterministic when extractedDate collapses multiple
 * events onto one day.
 */
export function buildHistory(events: SubscriptionEvent[]): SubscriptionHistoryEntry[] {
  return events
    .filter((e) => e.isCanonical)
    .slice()
    .sort((a, b) => {
      const dateCompare = eventDate(b).localeCompare(eventDate(a));
      if (dateCompare !== 0) return dateCompare;
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .map((e) => ({
      id: e.id,
      date: eventDate(e),
      eventType: e.eventType,
      eventTypeLabel: eventTypeLabel(e.eventType),
      amount: e.extractedPrice,
      currency: e.extractedCurrency,
      confidence: e.confidence,
      sourceMessageId: e.sourceMessageId,
    }));
}

// ─── Full response builder ──────────────────────────────────────────────────

export type SubscriptionVaultResponse = {
  subscription: {
    id: string;
    canonicalMerchantName: string;
    canonicalMerchantDomain: string | null;
    paymentProcessor: string | null;
    subscriptionStatus: string;
    amount: string | null;
    currency: string | null;
    billingInterval: string | null;
    billingIntervalSource: string | null;
    billingIntervalConfidence: string | null;
    nextBillingDate: string | null;
    lastBillingDate: string | null;
    promotedAt: string | null;
    createdAt: string;
    updatedAt: string;
    // Phase 3C.4 UX follow-up: explicit user acknowledgement (server/
    // storage.ts's confirmSubscription()) — read-only here, this module
    // never sets it. userConfirmedAt is only non-null when userConfirmed is
    // true.
    userConfirmed: boolean;
    userConfirmedAt: string | null;
  };
  cost: {
    monthlyCost: number | null;
    annualCost: number | null;
    monthlyEquivalent: number | null;
    annualEquivalent: number | null;
    currency: string | null;
  };
  billing: {
    interval: string | null;
    source: string | null;
    confidence: string | null;
    displayLabel: string;
  };
  renewal: {
    nextBillingDate: string | null;
    status: string;
  };
  history: SubscriptionHistoryEntry[];
  detection: {
    eventCount: number;
    confidence: number;
    resolutionMethod: string;
  };
  // Phase 3B.9.6B: server/priceHistory.ts's output, unmodified — no
  // percentage/savings math added here or anywhere in this module (that's
  // explicitly Phase 3B.9.7's job, not this one's).
  priceHistory: PriceHistoryResult;
  // Phase 3B.9.8: server/priceChangeDetector.ts's output, derived from the
  // SAME priceHistory computed just above — no separate event fetch, no
  // separate DB query.
  priceChanges: PriceChangeResult;
};

/**
 * buildSubscriptionVaultResponse(): the whole response in one call, given an
 * already-ownership-verified subscription and its already-fetched canonical
 * events. Reuses subscriptionCostEngine.ts's calculateSubscriptionCosts()
 * for cost math rather than recomputing it — the "reuse subscriptionCostEngine"
 * requirement, and the same discipline subscriptions.tsx already follows for
 * the list view (never a second, potentially-diverging cost implementation).
 */
export function buildSubscriptionVaultResponse(
  subscription: ShadowSubscription,
  events: SubscriptionEvent[],
  paymentProcessor: string | null
): SubscriptionVaultResponse {
  const { subscriptions: withCosts } = calculateSubscriptionCosts(subscription.userId, [subscription]);
  const costed: SubscriptionWithCost = withCosts[0];

  const history = buildHistory(events);
  const priceHistory = buildPriceHistory(events);
  const priceChanges = detectPriceChanges(priceHistory);

  // Detection confidence: merchantConfidence is the resolution engine's own
  // 0-100 score for this subscription's identity — the same value
  // subscriptionCostEngine.ts already uses to derive costConfidence, reused
  // here directly rather than re-deriving a second "how sure are we" number.
  const detectionConfidence = subscription.merchantConfidence ?? 0;

  return {
    subscription: {
      id: subscription.id,
      canonicalMerchantName: subscription.canonicalMerchantName,
      canonicalMerchantDomain: subscription.canonicalMerchantDomain,
      paymentProcessor,
      subscriptionStatus: subscription.subscriptionStatus,
      amount: subscription.amount,
      currency: subscription.currency,
      billingInterval: subscription.billingInterval,
      billingIntervalSource: subscription.billingIntervalSource,
      billingIntervalConfidence: subscription.billingIntervalConfidence,
      nextBillingDate: subscription.nextBillingDate,
      lastBillingDate: subscription.lastBillingDate,
      promotedAt: subscription.promotedAt ? subscription.promotedAt.toISOString() : null,
      createdAt: subscription.createdAt.toISOString(),
      updatedAt: subscription.updatedAt.toISOString(),
      userConfirmed: subscription.userConfirmed,
      userConfirmedAt: subscription.userConfirmedAt ? subscription.userConfirmedAt.toISOString() : null,
    },
    cost: {
      monthlyCost: costed.monthlyCost,
      annualCost: costed.annualCost,
      // Deliberately the SAME values as monthlyCost/annualCost, not a second
      // computation — see subscriptionCostEngine.ts's computeCostCents():
      // normalizing a non-monthly interval down to a month/year figure IS
      // the "equivalent," there is no distinct third number to compute.
      // Both names are exposed because the roadmap/detail-view UI asks for
      // "Monthly equivalent"/"Annual equivalent" as display labels.
      monthlyEquivalent: costed.monthlyCost,
      annualEquivalent: costed.annualCost,
      currency: subscription.currency,
    },
    billing: {
      interval: subscription.billingInterval,
      source: subscription.billingIntervalSource,
      confidence: subscription.billingIntervalConfidence,
      displayLabel: billingDisplayLabel(subscription.billingIntervalSource),
    },
    renewal: {
      nextBillingDate: subscription.nextBillingDate,
      status: subscription.subscriptionStatus,
    },
    history,
    detection: {
      eventCount: history.length,
      confidence: detectionConfidence,
      resolutionMethod: subscription.resolutionMethod,
    },
    priceHistory,
    priceChanges,
  };
}

// ─── Access decision (route-security logic, pure) ───────────────────────────
//
// Encodes the STRICT SECURITY rule as a pure, unit-testable decision: a
// missing session is 401; anything else that isn't "we found this exact
// subscription and it belongs to this exact user" is 404 — never 403, so a
// cross-user request is indistinguishable from a non-existent id (no
// existence leak). storage.getShadowSubscriptionById(id, userId) already
// scopes its WHERE clause by BOTH columns together, so a cross-user row
// comes back as undefined from the DB layer itself — this function's job is
// just translating "what did storage give us" into the right HTTP outcome,
// testable without a database by constructing that undefined/found case
// directly.
export type SubscriptionAccessResult =
  | { status: 401 }
  | { status: 404 }
  | { status: 200; subscription: ShadowSubscription };

export function determineSubscriptionAccessResult(
  sessionUserId: string | undefined,
  subscription: ShadowSubscription | undefined
): SubscriptionAccessResult {
  if (!sessionUserId) return { status: 401 };
  if (!subscription) return { status: 404 };
  // Defense in depth: even if a future caller ever passes an unscoped fetch
  // result, ownership is re-verified here too, not trusted blindly.
  if (subscription.userId !== sessionUserId) return { status: 404 };
  return { status: 200, subscription };
}
