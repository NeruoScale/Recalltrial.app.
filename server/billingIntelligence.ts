// ─── Billing intelligence — provenance-tracked interval inference (Phase 3B.9.3) ─
//
// Same pattern as canonicalEvents.ts/entityResolver.ts/subscriptionLifecycle.ts:
// no DB access, pure and deterministic, directly unit-testable. Covers Tiers
// 1, 3, and 4 of the evidence hierarchy — confirmed_email (reading what
// gmail.ts's extractBillingInterval() already found), inferred (recurrence
// pattern across 2+ dated/priced events), and unknown. Tier 2
// (merchant_knowledge, server/merchantKnowledge.ts) is a separate, narrow
// lookup applied by the caller (server/storage.ts) only as a fallback when
// this function returns "unknown" — see that file's own header for why.
//
// SAFETY RULES this module enforces structurally, not just by convention:
//   - never infers a monthly (or any) interval from price alone — amount
//     is only ever used as a data-quality FILTER (an event needs a known
//     price to count as real evidence), never as a basis for the interval
//     ITSELF, which is derived purely from date gaps
//   - never infers from merchant name — this function never reads
//     canonicalMerchantName/canonicalMerchantDomain at all
//   - a single event is never enough evidence — recurrence inference has a
//     hard floor of 2 events with both a known price and a known date
//   - deterministic: sorting is by extractedDate (a stable, content-derived
//     key), so the same event set always produces the same result

import type { SubscriptionEvent } from "@shared/schema";

export type BillingIntervalSource = "confirmed_email" | "merchant_knowledge" | "inferred" | "unknown";
export type BillingIntervalConfidence = "high" | "medium" | "low";

export type BillingIntelligenceResult = {
  billingInterval: string | null;
  billingIntervalSource: BillingIntervalSource;
  billingIntervalConfidence: BillingIntervalConfidence;
  evidenceCount: number;
  inferenceMethod: string;
};

// Tier ranking used for override protection (STEP 4's "never downgrade"
// rule) — exported so storage.ts's orchestration and this module's own
// tests can share one source of truth for "which tier wins."
const TIER_RANK: Record<BillingIntervalSource, number> = {
  confirmed_email: 3,
  merchant_knowledge: 2,
  inferred: 1,
  unknown: 0,
};

/**
 * shouldUpdateBillingIntelligence(): the strict hierarchy check — a
 * candidate result may only replace the subscription's current
 * source/confidence if it's the same tier (a refresh — e.g. a newer
 * confirmed_email event superseding an older one) or a STRICTLY higher
 * tier. A lower tier can never overwrite a higher one, ever — this is the
 * literal "never override confirmed_email with any lower tier" /
 * "never override merchant_knowledge with inferred" rule.
 */
export function shouldUpdateBillingIntelligence(
  current: { source: BillingIntervalSource },
  candidate: { source: BillingIntervalSource }
): boolean {
  return TIER_RANK[candidate.source] >= TIER_RANK[current.source];
}

const UNKNOWN_RESULT: BillingIntelligenceResult = {
  billingInterval: null,
  billingIntervalSource: "unknown",
  billingIntervalConfidence: "low",
  evidenceCount: 0,
  inferenceMethod: "no evidence available",
};

// days-between-consecutive-events -> interval band. A gap outside every
// band is NOT silently rounded to the nearest one — it's treated as
// incompatible evidence (see inferFromRecurrencePattern below), because
// guessing "close enough" is exactly the kind of invention this system
// exists to avoid.
const INTERVAL_BANDS: { min: number; max: number; interval: string }[] = [
  { min: 27, max: 35, interval: "monthly" },
  { min: 80, max: 100, interval: "quarterly" },
  { min: 165, max: 190, interval: "semi_annual" },
  { min: 350, max: 380, interval: "annual" },
];

function bandForGapDays(days: number): string | null {
  const band = INTERVAL_BANDS.find((b) => days >= b.min && days <= b.max);
  return band ? band.interval : null;
}

/**
 * Tier 3: infers a recurrence interval purely from the CADENCE of dated,
 * priced canonical events — never their price values (a price change is
 * explicitly allowed; only the day-gap between events matters). Requires
 * every consecutive gap to fall in the SAME band; a single inconsistent
 * gap aborts the inference entirely rather than picking a majority/nearest
 * guess. Returns null (not a result) when there isn't enough — or
 * consistent enough — evidence to infer anything.
 */
function inferFromRecurrencePattern(canonicalEvents: SubscriptionEvent[]): BillingIntelligenceResult | null {
  const eligible = canonicalEvents
    .filter((e) => e.extractedPrice !== null && e.extractedDate !== null)
    .sort((a, b) => (a.extractedDate! < b.extractedDate! ? -1 : a.extractedDate! > b.extractedDate! ? 1 : 0));

  if (eligible.length < 2) return null;

  const gapsDays: number[] = [];
  for (let i = 1; i < eligible.length; i++) {
    const prevMs = new Date(eligible[i - 1].extractedDate! + "T00:00:00.000Z").getTime();
    const currMs = new Date(eligible[i].extractedDate! + "T00:00:00.000Z").getTime();
    gapsDays.push(Math.round((currMs - prevMs) / (24 * 60 * 60 * 1000)));
  }

  const bands = gapsDays.map(bandForGapDays);
  if (bands.some((b) => b === null)) return null; // at least one gap matched no band at all
  const distinctBands = new Set(bands);
  if (distinctBands.size !== 1) return null; // gaps matched DIFFERENT bands — inconsistent, don't guess

  const interval = bands[0]!;
  const evidenceCount = eligible.length;
  const avgGap = Math.round(gapsDays.reduce((a, b) => a + b, 0) / gapsDays.length);

  return {
    billingInterval: interval,
    billingIntervalSource: "inferred",
    billingIntervalConfidence: evidenceCount >= 3 ? "high" : "medium",
    evidenceCount,
    inferenceMethod: `recurrence pattern: ${evidenceCount} events with ~${avgGap}-day gaps`,
  };
}

/**
 * inferBillingInterval(): the primary entry point, covering Tiers 1, 3, 4.
 * canonicalEvents should be every canonical (isCanonical=true) subscription
 * event for one subscription, one user — cross-user isolation is the
 * caller's responsibility (matches every other pure engine in this
 * codebase, e.g. entityResolver.ts's byUser grouping happening one level
 * up), not re-validated here since this function has no userId to check
 * against.
 */
export function inferBillingInterval(canonicalEvents: SubscriptionEvent[]): BillingIntelligenceResult {
  // Tier 1: confirmed_email — trust the MOST RECENT event that already has
  // an explicit billingInterval (gmail.ts's extractBillingInterval(),
  // Phase 3B.9.2A). evidenceCount is how many canonical events agree with
  // that chosen value, not just 1, so a single disagreeing older event
  // doesn't understate the evidence behind the current answer.
  const sortedByRecency = [...canonicalEvents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const confirmedEvent = sortedByRecency.find((e) => e.billingInterval);
  if (confirmedEvent) {
    const agreeingCount = canonicalEvents.filter((e) => e.billingInterval === confirmedEvent.billingInterval).length;
    return {
      billingInterval: confirmedEvent.billingInterval,
      billingIntervalSource: "confirmed_email",
      billingIntervalConfidence: "high",
      evidenceCount: agreeingCount,
      inferenceMethod: "explicit billing interval extracted from email text",
    };
  }

  // Tier 3: recurrence pattern.
  const inferred = inferFromRecurrencePattern(canonicalEvents);
  if (inferred) return inferred;

  // Tier 4: nothing to go on.
  return UNKNOWN_RESULT;
}
