// ─── Subscription cost engine — pure, deterministic (Phase 3B.9.1) ─────────────
//
// Same separation-of-concerns pattern as canonicalEvents.ts/entityResolver.ts/
// subscriptionLifecycle.ts: no DB access here, no new tables, no redesign of
// the `subscriptions` table — this reads the EXISTING row shape as-is and
// derives normalized monthly/annual cost fields from it. Operates strictly
// on `subscriptions` (one row per real-world subscription, already
// deduplicated by entity resolution) — never on raw subscription_events, so
// there is no event-level double counting by construction.
//
// DECIMAL SAFETY: `subscriptions.amount` is a Postgres decimal(10,2) column,
// which Drizzle returns as a STRING specifically to avoid float precision
// loss at the DB layer. This module preserves that discipline internally:
// amounts are parsed into integer CENTS via string manipulation (never
// parseFloat/Number() on the raw decimal string), every multiplication stays
// exact integer arithmetic, and every division that doesn't land on a whole
// cent is rounded ONCE (round-half-up) at the point of computation — never
// through a chain of successive roundings that could compound error. Dollar
// amounts are only produced at the very end, per the "round only at the
// presentation layer" instruction.

import type { ShadowSubscription } from "@shared/schema";

export type CostConfidence = "High" | "Medium" | "Low";

// Phase 3B.9.3 Step 5: billingIntervalSource/billingIntervalConfidence
// (server/billingIntelligence.ts's provenance fields) already flow through
// here automatically via the `ShadowSubscription &` spread below — cost
// normalization itself is intentionally indifferent to provenance (it reads
// billingInterval's VALUE only, regardless of whether that value came from
// confirmed_email/merchant_knowledge/inferred), so no computation change
// was needed, only this note that the fields are present in the output.
export type SubscriptionWithCost = ShadowSubscription & {
  monthlyCost: number | null;
  annualCost: number | null;
  costConfidence: CostConfidence;
};

export type SubscriptionCostSummary = {
  totalSubscriptions: number;
  activeSubscriptions: number;
  monthlyRecurringCost: number | null;
  annualRecurringCost: number | null;
  byCurrency: Record<string, { monthly: number; annual: number }>;
  incompleteBillingCount: number;
  unknownCostCount: number;
};

export type SubscriptionCostResult = {
  subscriptions: SubscriptionWithCost[];
  summary: SubscriptionCostSummary;
};

// ─── Decimal-safe cents arithmetic ──────────────────────────────────────────
//
// Exported (Phase 3B.9.4) so server/renewalCalendar.ts can reuse the exact
// same parsing/rounding discipline for its own currency totals instead of
// re-deriving a second, potentially-diverging implementation.

/**
 * Parses a Postgres decimal(10,2) string into integer cents. Returns null
 * for anything that isn't a clean non-negative decimal — malformed strings
 * AND negative amounts both collapse to null here (a negative "cost" isn't
 * a real recurring charge; treated identically to missing data downstream,
 * never as $0 and never as a negative total).
 */
export function parseAmountToCents(amount: string | null): number | null {
  if (amount === null) return null;
  const trimmed = amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null; // no leading '-' allowed -> rejects negatives too
  const [wholeRaw, fracRaw = ""] = trimmed.split(".");
  const whole = parseInt(wholeRaw, 10);
  const frac = parseInt((fracRaw + "00").slice(0, 2), 10);
  return whole * 100 + frac;
}

/** Round-half-up integer division — the only place non-exact division happens. */
function divRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

// ─── Billing interval normalization ─────────────────────────────────────────
//
// Each case is ONE combined multiply-then-round-once operation (never
// multiply, round, then divide again) so rounding error can never compound
// across steps. Multiplication-only results (annual for weekly/biweekly/
// monthly, monthly for the monthly case itself) need no rounding at all —
// they're exact integer cents.

function computeCostCents(amountCents: number, interval: string): { monthlyCents: number; annualCents: number } | null {
  switch (interval) {
    case "weekly":
      return { monthlyCents: divRoundHalfUp(amountCents * 52, 12), annualCents: amountCents * 52 };
    case "biweekly":
      return { monthlyCents: divRoundHalfUp(amountCents * 26, 12), annualCents: amountCents * 26 };
    case "monthly":
      return { monthlyCents: amountCents, annualCents: amountCents * 12 };
    case "quarterly":
      return { monthlyCents: divRoundHalfUp(amountCents, 3), annualCents: amountCents * 4 };
    case "semi_annual":
      return { monthlyCents: divRoundHalfUp(amountCents, 6), annualCents: amountCents * 2 };
    case "annual":
      return { monthlyCents: divRoundHalfUp(amountCents, 12), annualCents: amountCents };
    default:
      // one_time, unknown, null, or anything unrecognized — never guess a
      // recurrence, per the "do not guess missing prices" boundary.
      return null;
  }
}

function costConfidenceFor(merchantConfidence: number | null): CostConfidence {
  const c = merchantConfidence ?? 0;
  if (c >= 70) return "High";
  if (c >= 40) return "Medium";
  return "Low";
}

const ACTIVE_LIKE_STATUSES = new Set(["active", "trial", "past_due"]);

/**
 * calculateSubscriptionCosts(): the whole engine in one call. userId is a
 * defensive filter (matches the established pattern elsewhere in this
 * codebase of never trusting the caller to have already scoped correctly —
 * see entityResolver.ts's byUser grouping) — subscriptions belonging to a
 * different user are silently dropped rather than trusted blindly.
 *
 * Per-subscription monthlyCost/annualCost/costConfidence are computed for
 * EVERY subscription regardless of status (cancelled/expired subscriptions
 * still get their historical cost figures for their own card) — only the
 * SUMMARY aggregation is status-gated to active/trial/past_due, per the
 * eligibility rules.
 */
export function calculateSubscriptionCosts(userId: string, subscriptions: ShadowSubscription[]): SubscriptionCostResult {
  const ownSubscriptions = subscriptions.filter((s) => s.userId === userId);

  const byCurrencyCents: Record<string, { monthlyCents: number; annualCents: number }> = {};
  let activeSubscriptions = 0;
  let incompleteBillingCount = 0;
  let unknownCostCount = 0;

  const withCosts: SubscriptionWithCost[] = ownSubscriptions.map((sub) => {
    const amountCents = parseAmountToCents(sub.amount);
    const interval = (sub.billingInterval || "").toLowerCase();
    const cost = amountCents !== null && sub.currency ? computeCostCents(amountCents, interval) : null;

    const isEligibleStatus = ACTIVE_LIKE_STATUSES.has(sub.subscriptionStatus);
    if (isEligibleStatus) activeSubscriptions++;

    // Eligibility for the AGGREGATE totals: status + amount + currency +
    // a normalizable interval. Missing-amount-or-currency and
    // missing/unknown/one_time-interval are tracked as two DISTINCT reasons
    // (checked in this priority order so a row missing both only counts
    // once), scoped to active-like subscriptions only — a cancelled
    // subscription's missing price isn't something the user needs
    // prompted about the way an active one's would be.
    if (isEligibleStatus) {
      if (amountCents === null || !sub.currency) {
        incompleteBillingCount++;
      } else if (cost === null) {
        unknownCostCount++;
      } else {
        const bucket = byCurrencyCents[sub.currency] || { monthlyCents: 0, annualCents: 0 };
        bucket.monthlyCents += cost.monthlyCents;
        bucket.annualCents += cost.annualCents;
        byCurrencyCents[sub.currency] = bucket;
      }
    }

    return {
      ...sub,
      monthlyCost: cost ? centsToDollars(cost.monthlyCents) : null,
      annualCost: cost ? centsToDollars(cost.annualCents) : null,
      costConfidence: costConfidenceFor(sub.merchantConfidence),
    };
  });

  const byCurrency: Record<string, { monthly: number; annual: number }> = {};
  for (const [currency, cents] of Object.entries(byCurrencyCents)) {
    byCurrency[currency] = { monthly: centsToDollars(cents.monthlyCents), annual: centsToDollars(cents.annualCents) };
  }

  // The top-level monthlyRecurringCost/annualRecurringCost are only ever
  // populated when there's exactly ONE currency among the eligible
  // subscriptions — summing across currencies here would be exactly the
  // "combine different currencies into one total" this engine must never
  // do. With 2+ distinct currencies (or 0), these stay null and byCurrency
  // is the only authoritative source — the UI is expected to render one
  // line per currency in that case, never a single blended figure.
  const currencyKeys = Object.keys(byCurrency);
  const singleCurrency = currencyKeys.length === 1 ? currencyKeys[0] : null;

  return {
    subscriptions: withCosts,
    summary: {
      totalSubscriptions: ownSubscriptions.length,
      activeSubscriptions,
      monthlyRecurringCost: singleCurrency ? byCurrency[singleCurrency].monthly : null,
      annualRecurringCost: singleCurrency ? byCurrency[singleCurrency].annual : null,
      byCurrency,
      incompleteBillingCount,
      unknownCostCount,
    },
  };
}

// ─── Upcoming charges (Phase 3B.9.2B Step 5) ────────────────────────────────
//
// Deliberately separate from calculateSubscriptionCosts() above — this
// answers "what's due soon," not "what does this cost normalized to a
// month/year." Still the same discipline: no DB calls, decimal-safe (reuses
// the same parseAmountToCents/centsToDollars this file already has), never
// combines currencies, never invents an amount.

export type UpcomingCharge = {
  subscriptionId: string;
  merchant: string;
  amount: string | null;
  currency: string | null;
  dueDate: string;
  status: ShadowSubscription["subscriptionStatus"];
};

export type UpcomingChargesResult = {
  charges: UpcomingCharge[];
  summary: {
    days: number;
    byCurrency: Record<string, number>;
  };
};

// active/trial: any future nextBillingDate counts, by definition of the
// status. past_due: only "if nextBillingDate is known and trustworthy" —
// implemented as the SAME universal "must actually be in the future" check
// applied to every status below, rather than a past_due-specific branch: a
// past_due row's stored date is often the date IT FAILED (now in the past),
// which is exactly what "trustworthy" is warning against showing as
// upcoming — a plain future-date check naturally excludes that case without
// needing separate logic per status.
const UPCOMING_ELIGIBLE_STATUSES = new Set(["active", "trial", "past_due"]);

/**
 * calculateUpcomingCharges(): subscriptions[] must already be scoped to one
 * user by the caller (this function has no userId parameter — see
 * server/routes.ts's GET /api/subscriptions, which passes only that user's
 * rows). `now` defaults to the real current time; exposed as an optional
 * param purely so tests can pin it, matching the same pattern already used
 * by computeSubscriptionReminderPlan() in subscriptionLifecycle.ts.
 */
export function calculateUpcomingCharges(
  subscriptions: ShadowSubscription[],
  windowDays: 7 | 30 | 90,
  now: Date = new Date()
): UpcomingChargesResult {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowEndMs = todayMs + windowDays * 24 * 60 * 60 * 1000;

  const charges: UpcomingCharge[] = [];
  const byCurrencyCents: Record<string, number> = {};

  for (const sub of subscriptions) {
    if (!UPCOMING_ELIGIBLE_STATUSES.has(sub.subscriptionStatus)) continue;
    if (!sub.nextBillingDate) continue;

    const dueMs = Date.parse(sub.nextBillingDate + "T00:00:00.000Z");
    if (Number.isNaN(dueMs)) continue;
    if (dueMs < todayMs || dueMs > windowEndMs) continue;

    charges.push({
      subscriptionId: sub.id,
      merchant: sub.canonicalMerchantName,
      amount: sub.amount,
      currency: sub.currency,
      dueDate: sub.nextBillingDate,
      status: sub.subscriptionStatus,
    });

    const amountCents = parseAmountToCents(sub.amount);
    if (amountCents !== null && sub.currency) {
      byCurrencyCents[sub.currency] = (byCurrencyCents[sub.currency] || 0) + amountCents;
    }
  }

  charges.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));

  const byCurrency: Record<string, number> = {};
  for (const [currency, cents] of Object.entries(byCurrencyCents)) {
    byCurrency[currency] = centsToDollars(cents);
  }

  return {
    charges,
    summary: { days: windowDays, byCurrency },
  };
}
