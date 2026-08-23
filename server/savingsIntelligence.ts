// ─── Savings intelligence — pure, deterministic (Phase 3C.1) ───────────────────
//
// Same separation-of-concerns pattern as the rest of this feature line: no DB
// access, no new tables, no mutation of subscriptions/lifecycle/reminders.
// Turns evidence already collected by subscriptionCostEngine.ts (cost),
// billingIntelligence.ts (interval provenance), and priceChangeDetector.ts
// (price-change history) into an honest, evidence-scored list of savings
// opportunities. Never invents a number, never guarantees a saving, never
// tells the user they "don't use" or "don't need" something — only that the
// evidence for continued value is limited.

import type { ShadowSubscription, SubscriptionEvent } from "@shared/schema";
import { calculateSubscriptionCosts } from "./subscriptionCostEngine";
import type { PriceChangeResult } from "./priceChangeDetector";

export type SavingsClassification = "essential" | "review" | "potential_savings" | "insufficient_data";
export type SavingsConfidence = "high" | "medium" | "low";

export type SavingsOpportunity = {
  subscriptionId: string;
  merchant: string;
  score: number;
  classification: SavingsClassification;
  monthlyCost: number | null;
  annualCost: number | null;
  currency: string | null;
  potentialMonthlySavings: number | null;
  potentialAnnualSavings: number | null;
  confidence: SavingsConfidence;
  reasons: string[];
  evidenceCount: number;
  // Phase 3C.2: pass-through of the subscription's own tracking state, for
  // the savings dashboard's "Track Subscription" button vs "✓ Tracked"
  // badge — never derived/recomputed here.
  userConfirmed: boolean;
  userDismissed: boolean;
};

export type SavingsSummary = {
  totalOpportunities: number;
  potentialMonthlySavings: number | null;
  potentialAnnualSavings: number | null;
  byCurrency: Record<string, { monthly: number; annual: number }>;
  incompleteCostCount: number;
  confidence: SavingsConfidence;
};

export type SavingsAnalysis = {
  opportunities: SavingsOpportunity[];
  summary: SavingsSummary;
};

// Only these two statuses are considered savings opportunities at all — a
// trial hasn't committed real recurring money yet (that's the trial-intel
// pipeline's job), and canceled/expired subscriptions have nothing left to
// "save" by cancelling. Matches subscriptionCostEngine.ts's own status
// framing but deliberately excludes "trial" (ACTIVE_LIKE_STATUSES there
// includes trial for cost-summary purposes; savings opportunities do not).
const OPPORTUNITY_STATUSES = new Set(["active", "past_due"]);

const RENEWAL_PROXIMITY_DAYS = 30;
const LOW_EVENT_COUNT_MAX = 2;

function daysUntil(dateStr: string, now: Date): number {
  const targetMs = Date.parse(dateStr + "T00:00:00.000Z");
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((targetMs - todayMs) / (24 * 60 * 60 * 1000));
}

function annualCostScore(annualCost: number | null): number {
  if (annualCost === null) return 0;
  if (annualCost > 200) return 30;
  if (annualCost > 100) return 20;
  if (annualCost > 50) return 10;
  return 0;
}

type ScoreInputs = {
  annualCost: number | null;
  hasPaymentFailure: boolean;
  hasPriceIncrease: boolean;
  isPastDue: boolean;
  renewsWithin30Days: boolean;
  eventCount: number;
};

/** scoreOpportunity(): the 6 additive factors sum to exactly 100 at their max — no double counting, no factor scored twice. */
function scoreOpportunity(input: ScoreInputs): number {
  let score = 0;
  score += annualCostScore(input.annualCost);
  if (input.hasPaymentFailure) score += 20;
  if (input.hasPriceIncrease) score += 15;
  if (input.isPastDue) score += 15;
  if (input.renewsWithin30Days) score += 10;
  if (input.eventCount >= 1 && input.eventCount <= LOW_EVENT_COUNT_MAX) score += 10;
  return Math.max(0, Math.min(100, score));
}

function classifyOpportunity(score: number, costKnown: boolean): SavingsClassification {
  if (!costKnown) return "insufficient_data";
  if (score >= 50) return "potential_savings";
  if (score >= 25) return "review";
  return "essential";
}

type ConfidenceInputs = {
  costKnown: boolean;
  billingIntervalSource: string | null;
  eventCount: number;
};

function deriveConfidence(input: ConfidenceInputs): SavingsConfidence {
  if (!input.costKnown || input.eventCount <= 1 || !input.billingIntervalSource || input.billingIntervalSource === "unknown") {
    return "low";
  }
  if (input.billingIntervalSource === "confirmed_email" && input.eventCount >= 3) {
    return "high";
  }
  return "medium";
}

type ReasonInputs = ScoreInputs & {
  costKnown: boolean;
  amountUnknown: boolean;
  intervalUnknown: boolean;
  priceChange: PriceChangeResult | undefined;
  classification: SavingsClassification;
};

function buildReasons(input: ReasonInputs): string[] {
  const reasons: string[] = [];

  if (input.amountUnknown) {
    reasons.push("Amount has not been confirmed — cost cannot be calculated");
  }
  if (input.intervalUnknown) {
    reasons.push("Billing interval has not been confirmed — cost cannot be calculated");
  }
  if (input.costKnown && input.annualCost !== null && input.annualCost > 200) {
    reasons.push("High annualized cost");
  } else if (input.costKnown && input.annualCost !== null && input.annualCost > 100) {
    reasons.push("Moderate annualized cost");
  }
  if (input.hasPaymentFailure) {
    reasons.push("Payment failure detected on this subscription");
  }
  if (input.hasPriceIncrease) {
    const change = input.priceChange?.latestChange;
    reasons.push(
      change && change.changeType === "increase"
        ? `Price increase detected (+${change.percentageChange}%, +$${change.monthlyImpact.toFixed(2)}/month)`
        : "Price increase detected"
    );
  }
  if (input.isPastDue) {
    reasons.push("Subscription is currently past due");
  }
  if (input.renewsWithin30Days) {
    reasons.push("Renews within the next 30 days");
  }
  if (input.eventCount === 0) {
    reasons.push("No recent subscription-related activity found");
  } else if (input.eventCount >= 1 && input.eventCount <= LOW_EVENT_COUNT_MAX) {
    reasons.push("Limited recent usage evidence detected");
  }
  if (input.classification === "essential" && reasons.length === 0) {
    reasons.push("Strong recurring evidence with no payment or pricing issues detected");
  }

  return reasons;
}

/**
 * analyzeSavingsOpportunities(): the whole engine in one call. `eventsBySubscriptionId`
 * must already be grouped per subscription by the caller (see
 * server/storage.ts's getCanonicalEventsForUserSubscriptions, which applies
 * the same FK-then-merchant-fallback matching getCanonicalEventsForSubscription()
 * already uses) — this module has no matching/lookup logic of its own, only
 * scoring. `priceChanges` is similarly caller-supplied (server/priceChangeDetector.ts's
 * detectPriceChanges() output per subscription) and is used ONLY for richer
 * reason text — the scoring boolean itself comes from the already-persisted
 * `lastPriceChangeType` field, never recomputed here. `dismissedSubscriptionIds`
 * (Phase 3C.2) is the user's savings-opportunity dismiss list (server/storage.ts's
 * getDismissedSavingsOpportunityIds()) — a dismissed subscription is
 * excluded from `opportunities` entirely, same as a canceled/expired status.
 */
export function analyzeSavingsOpportunities(
  subscriptions: ShadowSubscription[],
  eventsBySubscriptionId: Record<string, SubscriptionEvent[]>,
  priceChanges: Record<string, PriceChangeResult> = {},
  now: Date = new Date(),
  dismissedSubscriptionIds: string[] = []
): SavingsAnalysis {
  const opportunities: SavingsOpportunity[] = [];
  const dismissedSet = new Set(dismissedSubscriptionIds);

  for (const sub of subscriptions) {
    if (!OPPORTUNITY_STATUSES.has(sub.subscriptionStatus)) continue;
    if (dismissedSet.has(sub.id)) continue;

    const events = eventsBySubscriptionId[sub.id] ?? [];
    const eventCount = events.length;
    const hasPaymentFailure = events.some((e) => e.eventType === "payment_failed");

    const { subscriptions: [withCost] } = calculateSubscriptionCosts(sub.userId, [sub]);
    const amountUnknown = sub.amount === null;
    const intervalUnknown = !sub.billingInterval;
    const costKnown = !amountUnknown && !intervalUnknown && withCost.monthlyCost !== null;

    const hasPriceIncrease = sub.lastPriceChangeType === "increase";
    const isPastDue = sub.subscriptionStatus === "past_due";
    const renewsWithin30Days = !!sub.nextBillingDate && (() => {
      const diff = daysUntil(sub.nextBillingDate!, now);
      return diff >= 0 && diff <= RENEWAL_PROXIMITY_DAYS;
    })();

    const scoreInputs: ScoreInputs = {
      annualCost: withCost.annualCost,
      hasPaymentFailure,
      hasPriceIncrease,
      isPastDue,
      renewsWithin30Days,
      eventCount,
    };

    const score = scoreOpportunity(scoreInputs);
    const classification = classifyOpportunity(score, costKnown);
    const confidence = deriveConfidence({
      costKnown,
      billingIntervalSource: sub.billingIntervalSource,
      eventCount,
    });

    const reasons = buildReasons({
      ...scoreInputs,
      costKnown,
      amountUnknown,
      intervalUnknown,
      priceChange: priceChanges[sub.id],
      classification,
    });

    opportunities.push({
      subscriptionId: sub.id,
      merchant: sub.canonicalMerchantName,
      score,
      classification,
      monthlyCost: costKnown ? withCost.monthlyCost : null,
      annualCost: costKnown ? withCost.annualCost : null,
      currency: costKnown ? sub.currency : null,
      potentialMonthlySavings: costKnown ? withCost.monthlyCost : null,
      potentialAnnualSavings: costKnown ? withCost.annualCost : null,
      confidence,
      reasons,
      evidenceCount: eventCount,
      userConfirmed: sub.userConfirmed,
      userDismissed: sub.userDismissed,
    });
  }

  const incompleteCostCount = opportunities.filter((o) => o.classification === "insufficient_data").length;

  const byCurrencyCents: Record<string, { monthlyCents: number; annualCents: number }> = {};
  for (const o of opportunities) {
    if (o.classification !== "potential_savings") continue;
    if (o.currency === null || o.monthlyCost === null || o.annualCost === null) continue;
    const bucket = byCurrencyCents[o.currency] || { monthlyCents: 0, annualCents: 0 };
    bucket.monthlyCents += Math.round(o.monthlyCost * 100);
    bucket.annualCents += Math.round(o.annualCost * 100);
    byCurrencyCents[o.currency] = bucket;
  }

  const byCurrency: Record<string, { monthly: number; annual: number }> = {};
  for (const [currency, cents] of Object.entries(byCurrencyCents)) {
    byCurrency[currency] = { monthly: cents.monthlyCents / 100, annual: cents.annualCents / 100 };
  }

  const currencyKeys = Object.keys(byCurrency);
  const singleCurrency = currencyKeys.length === 1 ? currencyKeys[0] : null;

  const confidenceCounts: Record<SavingsConfidence, number> = { high: 0, medium: 0, low: 0 };
  for (const o of opportunities) confidenceCounts[o.confidence]++;
  const summaryConfidence: SavingsConfidence =
    incompleteCostCount > 0
      ? "low"
      : opportunities.length === 0
      ? "medium"
      : confidenceCounts.low >= confidenceCounts.medium && confidenceCounts.low >= confidenceCounts.high
      ? "low"
      : confidenceCounts.high >= confidenceCounts.medium
      ? "high"
      : "medium";

  return {
    opportunities,
    summary: {
      totalOpportunities: opportunities.length,
      potentialMonthlySavings: singleCurrency ? byCurrency[singleCurrency].monthly : null,
      potentialAnnualSavings: singleCurrency ? byCurrency[singleCurrency].annual : null,
      byCurrency,
      incompleteCostCount,
      confidence: summaryConfidence,
    },
  };
}
