// ─── Price change detection — pure, deterministic (Phase 3B.9.8) ───────────────
//
// Same separation-of-concerns pattern as priceHistory.ts: no DB access, no
// classification, no lifecycle-state involvement — operates strictly on
// buildPriceHistory()'s already-collapsed observation timeline. Per the
// approved architectural decision for this phase, price observations
// (including ones from one_time_purchase events) are INDEPENDENT of
// subscriptions.amount and Phase 3B.8's lifecycle state machine; this
// module never touches either, it only describes what changed between two
// adjacent OBSERVED prices.
//
// "Never invent" applies here exactly as it does throughout this feature
// line: null->known is a first-known-price, not an increase; a null gap is
// ignored, never rendered as a fabricated "$0" step; cross-currency pairs
// are reported as a distinct changeType rather than a misleading percentage
// computed by pretending two different currencies are the same number.

import type { PriceHistoryResult } from "./priceHistory";
import { parseAmountToCents } from "./subscriptionCostEngine";

export type PriceChangeType = "increase" | "decrease" | "currency_change" | "interval_change";

export type PriceChange = {
  detectedAt: string;
  previousAmount: string;
  previousCurrency: string;
  previousInterval: string | null;
  newAmount: string;
  newCurrency: string;
  newInterval: string | null;
  absoluteChange: number;
  percentageChange: number;
  monthlyImpact: number;
  annualImpact: number;
  changeType: PriceChangeType;
};

export type PriceChangeResult = {
  changes: PriceChange[];
  hasIncrease: boolean;
  hasDecrease: boolean;
  hasCurrencyChange: boolean;
  hasIntervalChange: boolean;
  latestChange: PriceChange | null;
  totalAnnualImpact: number | null;
};

// ─── Monthly-equivalent normalization ───────────────────────────────────────
//
// Deliberately a LOCAL copy of the interval ratios, not a reuse of
// subscriptionCostEngine.ts's computeCostCents() — that function returns
// null for an unrecognized/missing interval (correct for ITS job: refusing
// to guess a subscription's total cost when the cadence is genuinely
// unknown). Here, a null interval means "we don't know this observation's
// billing cadence, but we still observed a concrete amount" — the real
// Anthropic production case (one_time_purchase-derived observations with no
// billingInterval at all) requires comparing those numbers directly rather
// than refusing to compare, so a null/unrecognized interval is treated as
// an IDENTITY conversion (the raw amount already represents its own
// per-observation figure) instead of "cannot normalize."
const INTERVAL_MONTHLY_RATIO: Record<string, { numerator: number; denominator: number }> = {
  weekly: { numerator: 52, denominator: 12 },
  biweekly: { numerator: 26, denominator: 12 },
  monthly: { numerator: 1, denominator: 1 },
  quarterly: { numerator: 1, denominator: 3 },
  semi_annual: { numerator: 1, denominator: 6 },
  annual: { numerator: 1, denominator: 12 },
};

function divRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

function monthlyEquivalentCents(amountCents: number, interval: string | null): number {
  if (!interval) return amountCents;
  const ratio = INTERVAL_MONTHLY_RATIO[interval];
  if (!ratio) return amountCents;
  if (ratio.denominator === 1) return amountCents * ratio.numerator;
  return divRoundHalfUp(amountCents * ratio.numerator, ratio.denominator);
}

/** Round-half-away-from-zero to 1 decimal — JS's own Math.round rounds -0.5 toward 0, not away from it, which would misround a negative percentage's .x5 boundary. */
function roundToOneDecimal(n: number): number {
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 10)) / 10;
}

/**
 * detectPriceChanges(): walks buildPriceHistory()'s already-collapsed
 * observation list pairwise (adjacent observations only — a "multiple
 * changes" timeline is just several independent adjacent-pair comparisons,
 * never cumulative from the very first observation). Because
 * buildPriceHistory() already collapses any observation identical to its
 * immediate predecessor across amount+currency+billingInterval, every
 * adjacent pair reaching this function is guaranteed to differ in at least
 * one of those three dimensions — there is no "silently identical, skip"
 * case left to handle here.
 */
export function detectPriceChanges(priceHistory: PriceHistoryResult): PriceChangeResult {
  const { observations } = priceHistory;
  const changes: PriceChange[] = [];

  for (let i = 1; i < observations.length; i++) {
    const prev = observations[i - 1];
    const curr = observations[i];

    const prevCents = parseAmountToCents(prev.amount);
    const currCents = parseAmountToCents(curr.amount);
    if (prevCents === null || currCents === null) continue;

    let changeType: PriceChangeType;
    let absoluteChangeCents = currCents - prevCents;
    let percentageChange = 0;
    let monthlyImpactCents = 0;
    let annualImpactCents = 0;

    if (prev.currency !== curr.currency) {
      changeType = "currency_change";
      // Never compare magnitudes across currencies without an FX rate this
      // system doesn't have — 0 is an explicit "not applicable" sentinel,
      // never a real financial claim.
      absoluteChangeCents = 0;
    } else {
      const prevMonthly = monthlyEquivalentCents(prevCents, prev.billingInterval);
      const currMonthly = monthlyEquivalentCents(currCents, curr.billingInterval);
      monthlyImpactCents = currMonthly - prevMonthly;
      annualImpactCents = monthlyImpactCents * 12;
      percentageChange = prevMonthly !== 0 ? roundToOneDecimal((monthlyImpactCents / prevMonthly) * 100) : 0;

      changeType = prev.billingInterval !== curr.billingInterval
        ? "interval_change"
        : currMonthly > prevMonthly ? "increase" : "decrease";
    }

    changes.push({
      detectedAt: curr.observedAt,
      previousAmount: prev.amount,
      previousCurrency: prev.currency,
      previousInterval: prev.billingInterval,
      newAmount: curr.amount,
      newCurrency: curr.currency,
      newInterval: curr.billingInterval,
      absoluteChange: absoluteChangeCents / 100,
      percentageChange,
      monthlyImpact: monthlyImpactCents / 100,
      annualImpact: annualImpactCents / 100,
      changeType,
    });
  }

  return {
    changes,
    hasIncrease: changes.some((c) => c.changeType === "increase"),
    hasDecrease: changes.some((c) => c.changeType === "decrease"),
    hasCurrencyChange: changes.some((c) => c.changeType === "currency_change"),
    hasIntervalChange: changes.some((c) => c.changeType === "interval_change"),
    latestChange: changes.length > 0 ? changes[changes.length - 1] : null,
    totalAnnualImpact: changes.length > 0 ? changes.reduce((sum, c) => sum + c.annualImpact, 0) : null,
  };
}
