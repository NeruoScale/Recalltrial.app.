// ─── Savings recommendations — pure, deterministic (Phase 3C.4) ────────────────
//
// Same separation-of-concerns pattern as the rest of this feature line: no DB
// access, no AI call, no mutation of subscriptions/lifecycle/reminders.
// Turns already-computed evidence (server/savingsIntelligence.ts's
// classification/score, server/priceChangeDetector.ts's change history, and
// the subscription's own events) into ONE consolidated, evidence-backed
// recommendation per subscription — never a raw AI suggestion, never a
// cancellation instruction, never a guaranteed-savings claim.
//
// DESIGN NOTE: a subscription can technically match several of the 7
// recommendation types at once (e.g. past_due AND a payment failure AND an
// approaching renewal, exactly like the spec's own Anthropic example). This
// module emits exactly ONE recommendation per subscription — the single most
// relevant TYPE (by the precedence order in `TYPE_PRECEDENCE` below) — but
// its `evidence` array still lists every applicable fact, matching the
// spec's own example (`type: REVIEW_PAST_DUE` with three evidence lines,
// not just the one fact that produced the type). Priority is computed
// independently of which type won, from the full fact set.

import type { ShadowSubscription, SubscriptionEvent } from "@shared/schema";
import type { SavingsOpportunity } from "./savingsIntelligence";
import type { PriceChangeResult } from "./priceChangeDetector";

export type RecommendationType =
  | "REVIEW_COST"
  | "CONFIRM_AMOUNT"
  | "REVIEW_RENEWAL"
  | "REVIEW_PAYMENT_FAILURE"
  | "REVIEW_PAST_DUE"
  | "REVIEW_PRICE_INCREASE"
  | "REVIEW_CURRENCY_CHANGE";

export type RecommendationPriority = "high" | "medium" | "low";

export type Recommendation = {
  id: string;
  subscriptionId: string;
  merchant: string;
  type: RecommendationType;
  priority: RecommendationPriority;
  title: string;
  description: string;
  evidence: string[];
  potentialAnnualSavings: number | null;
  currency: string | null;
  actionLabel: string;
  actionType: "view" | "track" | "confirm";
};

export type RecommendationResult = {
  recommendations: Recommendation[];
  summary: {
    total: number;
    highPriority: number;
    mediumPriority: number;
    lowPriority: number;
  };
};

// Only active/past_due subscriptions are ever considered — matches
// server/savingsIntelligence.ts's OPPORTUNITY_STATUSES exactly; a
// canceled/expired subscription has nothing actionable left to recommend.
const RECOMMENDABLE_STATUSES = new Set(["active", "past_due"]);

const RENEWAL_IMMINENT_DAYS = 7;
const RENEWAL_UPCOMING_DAYS = 30;
const MEANINGFUL_ANNUAL_COST = 50;

function daysUntil(dateStr: string, now: Date): number {
  const targetMs = Date.parse(dateStr + "T00:00:00.000Z");
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((targetMs - todayMs) / (24 * 60 * 60 * 1000));
}

function formatDateLabel(dateStr: string): string {
  return new Date(dateStr + "T00:00:00.000Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

type Facts = {
  isPastDue: boolean;
  amountUnknown: boolean;
  hasPaymentFailure: boolean;
  paymentFailureCount: number;
  hasPriceIncrease: boolean;
  hasCurrencyChange: boolean;
  daysUntilRenewal: number | null;
  nextBillingDate: string | null;
  classification: SavingsOpportunity["classification"] | null;
  annualCost: number | null;
  currency: string | null;
  latestPriceChange: PriceChangeResult["latestChange"] | null;
};

function gatherFacts(
  sub: ShadowSubscription,
  opportunity: SavingsOpportunity | undefined,
  priceChange: PriceChangeResult | undefined,
  events: SubscriptionEvent[],
  now: Date
): Facts {
  const paymentFailureCount = events.filter((e) => e.eventType === "payment_failed").length;
  return {
    isPastDue: sub.subscriptionStatus === "past_due",
    amountUnknown: sub.amount === null,
    hasPaymentFailure: paymentFailureCount > 0,
    paymentFailureCount,
    hasPriceIncrease: sub.lastPriceChangeType === "increase",
    hasCurrencyChange: sub.lastPriceChangeType === "currency_change",
    daysUntilRenewal: sub.nextBillingDate ? daysUntil(sub.nextBillingDate, now) : null,
    nextBillingDate: sub.nextBillingDate,
    classification: opportunity?.classification ?? null,
    annualCost: opportunity?.annualCost ?? null,
    currency: opportunity?.currency ?? sub.currency,
    latestPriceChange: priceChange?.latestChange ?? null,
  };
}

// ─── Type selection (precedence order — see the module-level DESIGN NOTE) ──

const TYPE_PRECEDENCE: { type: RecommendationType; applies: (f: Facts) => boolean }[] = [
  { type: "CONFIRM_AMOUNT", applies: (f) => f.amountUnknown },
  { type: "REVIEW_PAST_DUE", applies: (f) => f.isPastDue },
  { type: "REVIEW_PAYMENT_FAILURE", applies: (f) => f.hasPaymentFailure },
  { type: "REVIEW_PRICE_INCREASE", applies: (f) => f.hasPriceIncrease },
  { type: "REVIEW_CURRENCY_CHANGE", applies: (f) => f.hasCurrencyChange },
  { type: "REVIEW_RENEWAL", applies: (f) => f.daysUntilRenewal !== null && f.daysUntilRenewal >= 0 && f.daysUntilRenewal < RENEWAL_UPCOMING_DAYS },
  { type: "REVIEW_COST", applies: (f) => f.classification === "potential_savings" && f.annualCost !== null },
];

function selectType(facts: Facts): RecommendationType | null {
  const match = TYPE_PRECEDENCE.find((rule) => rule.applies(facts));
  return match ? match.type : null;
}

// ─── Priority (independent of which type won — from the full fact set) ────

function computePriority(facts: Facts): RecommendationPriority {
  const renewalImminent = facts.daysUntilRenewal !== null && facts.daysUntilRenewal >= 0 && facts.daysUntilRenewal < RENEWAL_IMMINENT_DAYS;
  const renewalUpcoming = facts.daysUntilRenewal !== null && facts.daysUntilRenewal >= 0 && facts.daysUntilRenewal < RENEWAL_UPCOMING_DAYS;

  const isHigh =
    (facts.classification === "potential_savings" && facts.annualCost !== null) ||
    (renewalImminent && (facts.isPastDue || facts.hasPaymentFailure)) ||
    facts.paymentFailureCount >= 2 ||
    (facts.isPastDue && facts.hasPaymentFailure);
  if (isHigh) return "high";

  const isMedium =
    (facts.annualCost !== null && facts.annualCost >= MEANINGFUL_ANNUAL_COST) ||
    facts.hasPriceIncrease ||
    renewalUpcoming ||
    facts.hasCurrencyChange ||
    facts.hasPaymentFailure ||
    facts.isPastDue;
  if (isMedium) return "medium";

  return "low";
}

// ─── Title / description / evidence (evidence-based only — see LANGUAGE
// RULES: never "cancel", never "wasting", never "unused", never a
// guaranteed-savings claim, never "$0" for an unknown amount) ───────────────

const TITLES: Record<RecommendationType, string> = {
  CONFIRM_AMOUNT: "Confirm subscription details",
  REVIEW_PAST_DUE: "Review payment status",
  REVIEW_PAYMENT_FAILURE: "Review payment method",
  REVIEW_PRICE_INCREASE: "Review recent price increase",
  REVIEW_CURRENCY_CHANGE: "Review currency change",
  REVIEW_RENEWAL: "Review upcoming renewal",
  REVIEW_COST: "Review subscription cost",
};

function buildEvidence(facts: Facts): string[] {
  const evidence: string[] = [];
  if (facts.isPastDue) evidence.push("status: past_due");
  if (facts.hasPaymentFailure) evidence.push("payment failures detected");
  if (facts.amountUnknown) evidence.push("amount: not yet available");
  if (facts.hasPriceIncrease) {
    const c = facts.latestPriceChange;
    evidence.push(c ? `price increased from ${c.previousAmount} to ${c.newAmount} (${c.percentageChange}%)` : "price increase detected");
  }
  if (facts.hasCurrencyChange) {
    const c = facts.latestPriceChange;
    evidence.push(c ? `currency changed from ${c.previousCurrency} to ${c.newCurrency}` : "currency change detected");
  }
  if (facts.nextBillingDate !== null) {
    evidence.push(`renewal: ${facts.nextBillingDate}`);
  }
  if (facts.classification === "potential_savings" && facts.annualCost !== null) {
    evidence.push(`annual cost: ${facts.annualCost.toFixed(2)} ${facts.currency ?? ""}`.trim());
  }
  return evidence;
}

function buildDescription(type: RecommendationType, facts: Facts, nextBillingDate: string | null): string {
  const renewalClause = nextBillingDate ? ` Your next renewal is approaching on ${formatDateLabel(nextBillingDate)}.` : "";

  switch (type) {
    case "CONFIRM_AMOUNT":
      if (facts.hasPaymentFailure) {
        return "We detected payment failures for this subscription but haven't confirmed the billing amount yet.";
      }
      if (facts.isPastDue) {
        return "This subscription is past due and the billing amount hasn't been confirmed yet.";
      }
      return "The billing amount for this subscription hasn't been confirmed yet.";
    case "REVIEW_PAST_DUE": {
      let desc = "This subscription is past due";
      if (facts.hasPaymentFailure) desc += " and has experienced payment failures";
      desc += ".";
      return desc + renewalClause;
    }
    case "REVIEW_PAYMENT_FAILURE":
      return "Payment failures have been detected on this subscription — worth reviewing your payment method." + renewalClause;
    case "REVIEW_PRICE_INCREASE": {
      const c = facts.latestPriceChange;
      return c
        ? `A price increase was detected on this subscription — from ${c.previousAmount} to ${c.newAmount} (${c.percentageChange}%).`
        : "A price increase was detected on this subscription.";
    }
    case "REVIEW_CURRENCY_CHANGE": {
      const c = facts.latestPriceChange;
      return c
        ? `A currency change was detected in this subscription's billing history — from ${c.previousCurrency} to ${c.newCurrency}.`
        : "A currency change was detected in this subscription's billing history.";
    }
    case "REVIEW_RENEWAL":
      return nextBillingDate
        ? `This subscription renews on ${formatDateLabel(nextBillingDate)} — worth reviewing before then.`
        : "This subscription's renewal is approaching — worth reviewing.";
    case "REVIEW_COST":
      return facts.annualCost !== null
        ? `This subscription costs ${facts.annualCost.toFixed(2)} ${facts.currency ?? ""}`.trim() + "/year — a potential savings opportunity worth reviewing."
        : "This subscription's cost is worth reviewing.";
  }
}

/**
 * generateRecommendations(): one consolidated recommendation per eligible
 * subscription (active/past_due only), matched to its savings opportunity
 * (by subscriptionId, if present — a missing match just means no cost/
 * classification data is available for the REVIEW_COST check, every other
 * type is independent of it), its price-change result, and its own events.
 * `priceChangesBySubscriptionId`/`eventsBySubscriptionId` are caller-supplied
 * (server/routes.ts computes them the same way the savings/analyst routes
 * already do) — this module never recomputes either.
 */
export function generateRecommendations(
  subscriptions: ShadowSubscription[],
  savingsOpportunities: SavingsOpportunity[],
  priceChangesBySubscriptionId: Record<string, PriceChangeResult>,
  eventsBySubscriptionId: Record<string, SubscriptionEvent[]>,
  now: Date = new Date()
): RecommendationResult {
  const opportunityBySubId = new Map(savingsOpportunities.map((o) => [o.subscriptionId, o]));
  const recommendations: Recommendation[] = [];

  for (const sub of subscriptions) {
    if (!RECOMMENDABLE_STATUSES.has(sub.subscriptionStatus)) continue;

    const facts = gatherFacts(
      sub,
      opportunityBySubId.get(sub.id),
      priceChangesBySubscriptionId[sub.id],
      eventsBySubscriptionId[sub.id] ?? [],
      now
    );

    const type = selectType(facts);
    if (!type) continue;

    const opportunity = opportunityBySubId.get(sub.id);
    recommendations.push({
      id: `${sub.id}-${type}`,
      subscriptionId: sub.id,
      merchant: sub.canonicalMerchantName,
      type,
      priority: computePriority(facts),
      title: TITLES[type],
      description: buildDescription(type, facts, sub.nextBillingDate),
      evidence: buildEvidence(facts),
      potentialAnnualSavings: opportunity?.potentialAnnualSavings ?? null,
      currency: opportunity?.currency ?? null,
      actionLabel: "View subscription",
      actionType: "view",
    });
  }

  const highPriority = recommendations.filter((r) => r.priority === "high").length;
  const mediumPriority = recommendations.filter((r) => r.priority === "medium").length;
  const lowPriority = recommendations.filter((r) => r.priority === "low").length;

  return {
    recommendations,
    summary: { total: recommendations.length, highPriority, mediumPriority, lowPriority },
  };
}
