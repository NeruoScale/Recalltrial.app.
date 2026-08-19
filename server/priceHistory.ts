// ─── Price history — pure, deterministic (Phase 3B.9.6B) ───────────────────────
//
// Same separation-of-concerns pattern as the rest of this feature line: no
// DB access, operates strictly on the canonical event timeline already
// passed in by the caller. Deliberately NOT a normalization/analysis layer —
// this is a faithful, chronological record of what was actually observed,
// nothing invented and nothing computed beyond "did this change from the
// last thing we saw." Percentage increases, "you're paying X% more," and
// savings math are explicitly out of scope here (Phase 3B.9.7) — this module
// only ever answers "what did we see, and when."

import type { SubscriptionEvent } from "@shared/schema";

export type PriceObservation = {
  observedAt: string; // ISO date (YYYY-MM-DD)
  amount: string;
  currency: string;
  billingInterval: string | null;
  isFirstKnownPrice: boolean;
  isCurrencyChange: boolean;
  isIntervalChange: boolean;
};

export type PriceHistoryResult = {
  observations: PriceObservation[];
  currentPrice: { amount: string; currency: string; billingInterval: string | null } | null;
  hasMultiplePrices: boolean;
  observationCount: number;
};

/**
 * eventDate(): same resolution order as subscriptionVault.ts's eventDate()
 * — extractedDate (what the evidence actually refers to) preferred,
 * createdAt (when we recorded it) as the fallback. Kept as its own copy
 * rather than importing subscriptionVault.ts, since that module's version
 * takes a Date-typed createdAt and this one only needs the date string —
 * duplicating three lines is cheaper than adding a cross-module dependency
 * for it.
 */
function eventDate(event: SubscriptionEvent): string {
  return event.extractedDate ?? event.createdAt.toISOString().slice(0, 10);
}

/**
 * buildPriceHistory(): filters to canonical events with a KNOWN amount AND
 * currency only — an event missing either is skipped entirely, never
 * treated as "$0" or as an "Unknown" entry in the timeline (a price
 * observation with an unknown currency isn't safely displayable or
 * comparable, so it's excluded the same as a fully-null one). Sorting by
 * date happens before any collapsing, so out-of-order input and duplicate
 * events both produce the same result as already-sorted, deduplicated
 * input — this function is deterministic and idempotent by construction,
 * not by convention.
 */
export function buildPriceHistory(canonicalEvents: SubscriptionEvent[]): PriceHistoryResult {
  const eligible = canonicalEvents
    .filter((e) => e.isCanonical && e.extractedPrice !== null && e.extractedCurrency !== null)
    .map((e) => ({
      date: eventDate(e),
      amount: e.extractedPrice as string,
      currency: e.extractedCurrency as string,
      billingInterval: e.billingInterval,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const observations: PriceObservation[] = [];

  for (const ev of eligible) {
    const last = observations[observations.length - 1];
    // Collapse: an entry identical to the immediately preceding one on
    // EVERY dimension (amount, currency, AND billingInterval) adds no new
    // information — the timeline should show 1 entry, not N identical
    // ones. A change in ANY single dimension (even if amount stayed the
    // same, e.g. a pure interval change) starts a new observation.
    const identicalToLast =
      last && last.amount === ev.amount && last.currency === ev.currency && last.billingInterval === ev.billingInterval;
    if (identicalToLast) continue;

    observations.push({
      observedAt: ev.date,
      amount: ev.amount,
      currency: ev.currency,
      billingInterval: ev.billingInterval,
      isFirstKnownPrice: observations.length === 0,
      isCurrencyChange: !!last && last.currency !== ev.currency,
      isIntervalChange: !!last && last.billingInterval !== ev.billingInterval,
    });
  }

  const latest = observations[observations.length - 1];

  return {
    observations,
    currentPrice: latest ? { amount: latest.amount, currency: latest.currency, billingInterval: latest.billingInterval } : null,
    hasMultiplePrices: observations.length > 1,
    observationCount: observations.length,
  };
}
