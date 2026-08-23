import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getQueryFn, apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Bell, LogOut, Settings, Layers, Mail, Sparkles, ChevronRight } from "lucide-react";
import type { ShadowSubscription } from "@shared/schema";

// Phase 3B.7.3 / 3B.8 Step 4 / 3B.9.1: reads exclusively from
// GET /api/subscriptions, which reads from `subscriptions` filtered to
// resolutionStatus="resolved" only (unresolved/ambiguous entities never
// appear here — enforced upstream by entityResolver.ts, not by anything on
// this page). Some of these rows are now genuinely active (isShadow=false,
// Phase 3B.7.4's controlled promotion) rather than shadow-only previews, so
// the heading reads "Your subscriptions" — but "Detected from your email"
// stays on every card as a permanent provenance marker: this is
// email-derived data, not something the user entered or confirmed
// themselves, regardless of promotion state.
//
// Phase 3B.9.1: monthlyCost/annualCost/costConfidence and the cost summary
// are computed server-side by server/subscriptionCostEngine.ts — this page
// only formats/displays them, it never recomputes billing normalization
// itself (that logic previously lived here and has been removed in favor of
// the shared, tested engine).

type SubscriptionWithCost = ShadowSubscription & {
  monthlyCost: number | null;
  annualCost: number | null;
  costConfidence: "High" | "Medium" | "Low";
};

type CostSummary = {
  totalSubscriptions: number;
  activeSubscriptions: number;
  monthlyRecurringCost: number | null;
  annualRecurringCost: number | null;
  byCurrency: Record<string, { monthly: number; annual: number }>;
  incompleteBillingCount: number;
  unknownCostCount: number;
};

type UpcomingCharge = {
  subscriptionId: string;
  merchant: string;
  amount: string | null;
  currency: string | null;
  dueDate: string;
  status: ShadowSubscription["subscriptionStatus"];
};

type UpcomingSummary = {
  days: number;
  byCurrency: Record<string, number>;
};

type RenewalCalendarEntry = {
  subscriptionId: string;
  merchant: string;
  dueDate: string;
  amount: string | null;
  currency: string | null;
  status: ShadowSubscription["subscriptionStatus"];
  billingInterval: string | null;
  billingIntervalSource: string | null;
  amountKnown: boolean;
  intervalKnown: boolean;
  isPastDue: boolean;
};

type UnknownDateSubscription = {
  subscriptionId: string;
  merchant: string;
  amount: string | null;
  currency: string | null;
  status: ShadowSubscription["subscriptionStatus"];
  billingInterval: string | null;
};

type RenewalCalendarWindow = {
  upcomingRenewals: RenewalCalendarEntry[];
  unknownDateSubscriptions: UnknownDateSubscription[];
  upcomingSummary: {
    windowDays: number;
    byCurrency: Record<string, number>;
    knownChargeCount: number;
    unknownAmountCount: number;
  };
};

type RenewalCalendar = {
  next30days: RenewalCalendarWindow;
  next90days: RenewalCalendarWindow;
};

type SubscriptionsResponse = {
  subscriptions: SubscriptionWithCost[];
  summary: CostSummary;
  upcomingCharges: UpcomingCharge[];
  upcomingSummary: UpcomingSummary;
  renewalCalendar: RenewalCalendar;
  messagesScanned: number | null;
};

// ─── Phase 3C.1/3C.2: Savings intelligence ──────────────────────────────────
// Mirrors server/savingsIntelligence.ts's SavingsAnalysis exactly — this page
// only formats/displays the already-computed, evidence-scored opportunities,
// it never recomputes scoring or classification itself.

type SavingsClassification = "essential" | "review" | "potential_savings" | "insufficient_data";
type SavingsConfidence = "high" | "medium" | "low";

type SavingsOpportunity = {
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
  userConfirmed: boolean;
  userDismissed: boolean;
};

type SavingsSummary = {
  totalOpportunities: number;
  potentialMonthlySavings: number | null;
  potentialAnnualSavings: number | null;
  byCurrency: Record<string, { monthly: number; annual: number }>;
  incompleteCostCount: number;
  confidence: SavingsConfidence;
};

type SavingsAnalysis = {
  opportunities: SavingsOpportunity[];
  summary: SavingsSummary;
};

// ─── Phase 3C.4: Savings recommendations ────────────────────────────────────
// Mirrors server/savingsRecommendations.ts's RecommendationResult exactly —
// this page only sorts (by priority) and displays what the deterministic
// engine already produced, it never rewrites a title/description/evidence.

type RecommendationType =
  | "REVIEW_COST"
  | "CONFIRM_AMOUNT"
  | "REVIEW_RENEWAL"
  | "REVIEW_PAYMENT_FAILURE"
  | "REVIEW_PAST_DUE"
  | "REVIEW_PRICE_INCREASE"
  | "REVIEW_CURRENCY_CHANGE";

type RecommendationPriority = "high" | "medium" | "low";

type Recommendation = {
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

type RecommendationResult = {
  recommendations: Recommendation[];
  summary: { total: number; highPriority: number; mediumPriority: number; lowPriority: number };
};

// ─── Phase 3B.9.5: Subscription Vault detail view ───────────────────────────
// Mirrors GET /api/subscriptions/:id's real response shape exactly
// (server/subscriptionVault.ts's SubscriptionVaultResponse) — never a
// guessed shape.

type SubscriptionHistoryEntry = {
  id: string;
  date: string;
  eventType: string;
  eventTypeLabel: string;
  amount: string | null;
  currency: string | null;
  confidence: number;
  sourceMessageId: string;
};

// Phase 3B.9.6B: mirrors server/priceHistory.ts's PriceHistoryResult exactly.
type PriceObservation = {
  observedAt: string;
  amount: string;
  currency: string;
  billingInterval: string | null;
  isFirstKnownPrice: boolean;
  isCurrencyChange: boolean;
  isIntervalChange: boolean;
};

type PriceHistoryResult = {
  observations: PriceObservation[];
  currentPrice: { amount: string; currency: string; billingInterval: string | null } | null;
  hasMultiplePrices: boolean;
  observationCount: number;
};

// Phase 3B.9.8: mirrors server/priceChangeDetector.ts's PriceChangeResult exactly.
type PriceChangeType = "increase" | "decrease" | "currency_change" | "interval_change";

type PriceChange = {
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

type PriceChangeResult = {
  changes: PriceChange[];
  hasIncrease: boolean;
  hasDecrease: boolean;
  hasCurrencyChange: boolean;
  hasIntervalChange: boolean;
  latestChange: PriceChange | null;
  totalAnnualImpact: number | null;
};

type SubscriptionVaultResponse = {
  subscription: {
    id: string;
    canonicalMerchantName: string;
    canonicalMerchantDomain: string | null;
    paymentProcessor: string | null;
    subscriptionStatus: ShadowSubscription["subscriptionStatus"];
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
  priceHistory: PriceHistoryResult;
  priceChanges: PriceChangeResult;
};

/** UI copy is deliberately factual ("Price decreased"), never attributive ("Anthropic lowered your price") — the evidence only proves the observed amount changed, not why. */
function formatSignedMoney(amount: number, currency: string | null): string {
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${formatMoney(Math.abs(amount).toFixed(2), currency)}`;
}

function formatSignedPercent(pct: number): string {
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function findLastChangeOfType(changes: PriceChange[], type: PriceChangeType): PriceChange | null {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i].changeType === type) return changes[i];
  }
  return null;
}

function formatMonthYear(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function SubscriptionDetailSheet({ subscriptionId, onClose }: { subscriptionId: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery<SubscriptionVaultResponse>({
    queryKey: ["/api/subscriptions", subscriptionId],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!subscriptionId,
  });

  return (
    <Sheet open={!!subscriptionId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto" data-testid="sheet-subscription-detail">
        {isLoading || !data ? (
          <div className="space-y-3 mt-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="flex items-center gap-2 flex-wrap" data-testid="text-detail-merchant">
                {data.subscription.canonicalMerchantName}
                <span
                  className={`inline-flex items-center text-xs px-2 py-0.5 rounded-md border font-medium ${statusBadgeClasses(data.subscription.subscriptionStatus)}`}
                  data-testid="text-detail-status"
                >
                  {statusLabel(data.subscription.subscriptionStatus)}
                </span>
                {data.subscription.userConfirmed && (
                  <span
                    className="inline-flex items-center text-xs px-2 py-0.5 rounded-md border font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-700"
                    data-testid="badge-detail-confirmed"
                  >
                    ✓ Confirmed by you
                  </span>
                )}
              </SheetTitle>
            </SheetHeader>

            <div className="mt-4 space-y-6">
              <div>
                <div className="text-2xl font-bold" data-testid="text-detail-amount">
                  {formatMoney(data.subscription.amount, data.subscription.currency)}
                  {data.subscription.billingInterval ? ` / ${formatInterval(data.subscription.billingInterval).toLowerCase()}` : ""}
                </div>
                {data.cost.annualEquivalent !== null && (
                  <div className="text-sm text-muted-foreground" data-testid="text-detail-annual-equivalent">
                    ${data.cost.annualEquivalent.toFixed(2)} {data.cost.currency}/year
                  </div>
                )}
                {data.subscription.userConfirmed && data.subscription.userConfirmedAt && (
                  <div className="text-xs text-muted-foreground mt-1" data-testid="text-detail-confirmed-at">
                    Confirmed by you on {formatDate(data.subscription.userConfirmedAt)}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-2">Billing</h3>
                <dl className="text-sm space-y-1.5">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Amount</dt>
                    <dd data-testid="text-detail-billing-amount">{formatMoney(data.subscription.amount, data.subscription.currency)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Frequency</dt>
                    <dd data-testid="text-detail-billing-frequency">
                      {formatInterval(data.billing.interval)} · {data.billing.displayLabel}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Monthly equivalent</dt>
                    <dd data-testid="text-detail-monthly-equivalent">
                      {data.cost.monthlyEquivalent !== null ? `$${data.cost.monthlyEquivalent.toFixed(2)}` : "Unknown"}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Annual equivalent</dt>
                    <dd data-testid="text-detail-annual-equivalent-row">
                      {data.cost.annualEquivalent !== null ? `$${data.cost.annualEquivalent.toFixed(2)}` : "Unknown"}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Next renewal</dt>
                    <dd data-testid="text-detail-next-renewal">
                      {data.renewal.nextBillingDate ? formatDate(data.renewal.nextBillingDate) : "Not available"}
                    </dd>
                  </div>
                </dl>
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" /> Detection
                </h3>
                <dl className="text-sm space-y-1.5">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Source</dt>
                    <dd>Detected from your email</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Confidence</dt>
                    <dd data-testid="text-detail-confidence">
                      {data.detection.confidence >= 70 ? "High" : data.detection.confidence >= 40 ? "Medium" : "Low"}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Emails detected</dt>
                    <dd data-testid="text-detail-event-count">{data.detection.eventCount}</dd>
                  </div>
                </dl>
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-2">History</h3>
                {data.history.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-detail-history-empty">No billing history detected yet.</p>
                ) : (
                  <div className="space-y-2">
                    {data.history.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between gap-3 text-sm"
                        data-testid={`row-history-${entry.id}`}
                      >
                        <span className="text-muted-foreground w-20 shrink-0">{formatShortDate(entry.date)}</span>
                        <span className="shrink-0 font-medium">
                          {entry.amount ? formatMoney(entry.amount, entry.currency) : "—"}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-right text-muted-foreground" data-testid={`text-history-label-${entry.id}`}>
                          {entry.eventTypeLabel}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-2">Price history</h3>

                {/* STEP 5: factual, evidence-scoped copy only — "Price
                    decreased," never "Anthropic lowered your price." The
                    banner reflects the most recent increase/decrease found
                    anywhere in the timeline, prioritizing increase (⚠️) over
                    decrease (✓) when both exist. */}
                {(() => {
                  const inc = data.priceChanges.hasIncrease ? findLastChangeOfType(data.priceChanges.changes, "increase") : null;
                  const dec = !inc && data.priceChanges.hasDecrease ? findLastChangeOfType(data.priceChanges.changes, "decrease") : null;
                  if (inc) {
                    return (
                      <div className="mb-3 text-sm font-medium text-amber-600 dark:text-amber-500" data-testid="text-price-change-banner-increase">
                        ⚠️ Price increased
                        <div className="text-xs font-normal">
                          {formatSignedMoney(inc.monthlyImpact, inc.newCurrency)}/month · {formatSignedMoney(inc.annualImpact, inc.newCurrency)}/year
                        </div>
                      </div>
                    );
                  }
                  if (dec) {
                    return (
                      <div className="mb-3 text-sm font-medium text-emerald-600 dark:text-emerald-500" data-testid="text-price-change-banner-decrease">
                        ✓ Price decreased
                        <div className="text-xs font-normal">
                          {formatSignedMoney(dec.monthlyImpact, dec.newCurrency)}/month · {formatSignedMoney(dec.annualImpact, dec.newCurrency)}/year
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

                {data.priceHistory.observationCount === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="text-price-history-empty">
                    No pricing information available
                  </p>
                ) : data.priceHistory.observationCount === 1 ? (
                  <div data-testid="text-price-history-single">
                    <div className="text-sm font-medium">
                      {formatMoney(data.priceHistory.observations[0].amount, data.priceHistory.observations[0].currency)}
                      {data.priceHistory.observations[0].billingInterval
                        ? `/${formatInterval(data.priceHistory.observations[0].billingInterval).toLowerCase()}`
                        : ""}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      First known price: {formatMonthYear(data.priceHistory.observations[0].observedAt)}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5" data-testid="text-price-history-list">
                    {[...data.priceHistory.observations].reverse().map((obs, idx) => {
                      const total = data.priceHistory.observations.length;
                      const chronologicalIndex = total - 1 - idx;
                      // detectPriceChanges() walks observations pairwise with no
                      // skipped pairs, so observation[i] (i>=1) always maps 1:1
                      // to changes[i-1].
                      const change = chronologicalIndex >= 1 ? data.priceChanges.changes[chronologicalIndex - 1] : null;
                      return (
                        <div
                          key={`${obs.observedAt}-${obs.amount}-${obs.currency}`}
                          className="flex items-center justify-between gap-3 text-sm"
                          data-testid={`row-price-history-${idx}`}
                        >
                          <span className="text-muted-foreground w-20 shrink-0">{formatMonthYear(obs.observedAt)}</span>
                          <span className="flex-1 min-w-0 font-medium">
                            {formatMoney(obs.amount, obs.currency)}
                            {obs.billingInterval ? `/${formatInterval(obs.billingInterval).toLowerCase()}` : ""}
                          </span>
                          {idx === 0 && <span className="text-xs text-muted-foreground shrink-0">(current)</span>}
                          {obs.isFirstKnownPrice && (
                            <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-price-first-known-${idx}`}>
                              (first known price)
                            </span>
                          )}
                          {change && change.changeType === "increase" && (
                            <span className="text-xs text-amber-600 dark:text-amber-500 shrink-0" data-testid={`text-price-change-indicator-${idx}`}>
                              ↑ {formatSignedPercent(change.percentageChange)}
                            </span>
                          )}
                          {change && change.changeType === "decrease" && (
                            <span className="text-xs text-emerald-600 dark:text-emerald-500 shrink-0" data-testid={`text-price-change-indicator-${idx}`}>
                              ↓ {formatSignedPercent(change.percentageChange)}
                            </span>
                          )}
                          {change && change.changeType === "currency_change" && (
                            <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-price-change-indicator-${idx}`}>
                              currency changed
                            </span>
                          )}
                          {change && change.changeType === "interval_change" && (
                            <span className="text-xs text-muted-foreground shrink-0" data-testid={`text-price-change-indicator-${idx}`}>
                              billing frequency changed
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function formatMoney(amount: string | null, currency: string | null): string {
  if (!amount) return "Unknown";
  const n = Number(amount);
  const formatted = Number.isFinite(n) ? n.toFixed(2) : amount;
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatInterval(interval: string | null): string {
  if (!interval) return "Unknown";
  return interval.charAt(0).toUpperCase() + interval.slice(1);
}

function formatDate(date: string | null): string {
  if (!date) return "Unknown";
  return new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatShortDate(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusLabel(status: ShadowSubscription["subscriptionStatus"]): string {
  switch (status) {
    case "active": return "Active";
    case "trial": return "Trial";
    case "past_due": return "Past due";
    case "canceled": return "Cancelled";
    case "expired": return "Expired";
    default: return "Unknown";
  }
}

// Phase 3B.8 Step 4: lifecycle status colors — active=green, past_due=
// yellow/orange, trial=blue, cancelled/expired/unknown=grey. Matches the
// existing green/yellow badge convention already used for trial-suggestion
// confidence in dashboard.tsx, extended with blue for trial and a neutral
// grey for every terminal/unknown state.
function statusBadgeClasses(status: ShadowSubscription["subscriptionStatus"]): string {
  switch (status) {
    case "active":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-700";
    case "past_due":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-200 dark:border-yellow-700";
    case "trial":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-700";
    case "canceled":
    case "expired":
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

// Phase 3C.2: savings-classification badge colors — potential_savings=amber
// (the strongest signal to act on), review=blue (worth a look), essential=
// green (healthy), insufficient_data=neutral grey (we genuinely don't know).
function classificationBadgeClasses(c: SavingsClassification): string {
  switch (c) {
    case "potential_savings":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-700";
    case "review":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-700";
    case "essential":
      return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-700";
    case "insufficient_data":
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function classificationLabel(c: SavingsClassification): string {
  switch (c) {
    case "potential_savings": return "potential savings";
    case "review": return "review";
    case "essential": return "essential";
    case "insufficient_data": return "insufficient data";
  }
}

function confidenceLabel(c: SavingsConfidence): string {
  return c.charAt(0).toUpperCase() + c.slice(1);
}

// Phase 3C.2: the ONE place this page ever forms a savings cost line — a
// missing amount always reads as "Cost unknown," NEVER as "$0" (see
// STEP 2's explicit "NEVER show '$0' for unknown amounts" boundary).
function formatSavingsCostLine(o: SavingsOpportunity): string {
  if (o.monthlyCost === null || o.annualCost === null) return "Cost unknown";
  return `$${o.monthlyCost.toFixed(2)}/month · $${o.annualCost.toFixed(2)}/year`;
}

function SavingsOpportunityCard({
  opportunity,
  onOpenDetail,
  onTrack,
  onDismiss,
  isTracking,
  isDismissing,
}: {
  opportunity: SavingsOpportunity;
  onOpenDetail: (id: string) => void;
  onTrack: (id: string) => void;
  onDismiss: (id: string) => void;
  isTracking: boolean;
  isDismissing: boolean;
}) {
  const o = opportunity;
  return (
    <Card data-testid={`card-savings-${o.subscriptionId}`}>
      <CardContent className="py-4">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
          <span className="font-semibold" data-testid={`text-savings-merchant-${o.subscriptionId}`}>{o.merchant}</span>
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-md border font-medium ${classificationBadgeClasses(o.classification)}`}
            data-testid={`badge-classification-${o.subscriptionId}`}
          >
            {classificationLabel(o.classification)}
          </span>
        </div>

        <div className="text-sm text-muted-foreground mb-1" data-testid={`text-savings-cost-${o.subscriptionId}`}>
          {formatSavingsCostLine(o)}
        </div>

        <div className="text-xs text-muted-foreground mb-3" data-testid={`text-savings-score-${o.subscriptionId}`}>
          Score: {o.score}/100
        </div>

        {o.reasons.length > 0 && (
          <ul className="text-sm space-y-1 mb-3 list-disc list-inside text-muted-foreground" data-testid={`list-savings-reasons-${o.subscriptionId}`}>
            {o.reasons.map((reason, idx) => (
              <li key={idx} data-testid={`text-savings-reason-${o.subscriptionId}-${idx}`}>{reason}</li>
            ))}
          </ul>
        )}

        {o.classification === "potential_savings" && o.potentialAnnualSavings !== null && (
          <div className="text-sm mb-3">
            <div className="font-medium" data-testid={`text-potential-savings-${o.subscriptionId}`}>
              Potential savings: ${o.potentialAnnualSavings.toFixed(2)}/year
            </div>
            <div className="text-xs text-muted-foreground" data-testid={`text-savings-confidence-${o.subscriptionId}`}>
              Confidence: {confidenceLabel(o.confidence)}
            </div>
          </div>
        )}

        {/* Track (userConfirmed) and Dismiss (dismissedSavingsOpportunities)
            are independent actions on independent pieces of state — both are
            always rendered together, regardless of the other's value. Track
            only ever swaps its OWN slot between a button and a badge; it
            never affects whether Dismiss renders. */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenDetail(o.subscriptionId)}
            data-testid={`button-view-savings-${o.subscriptionId}`}
          >
            View subscription
          </Button>

          {o.userConfirmed ? (
            <span
              className="inline-flex items-center text-xs px-2 py-1 rounded-md border font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-700"
              data-testid={`badge-tracked-${o.subscriptionId}`}
            >
              ✓ Confirmed by you
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={isTracking}
              onClick={() => onTrack(o.subscriptionId)}
              data-testid={`button-track-${o.subscriptionId}`}
            >
              Track Subscription
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            disabled={isDismissing}
            onClick={() => onDismiss(o.subscriptionId)}
            data-testid={`button-dismiss-savings-${o.subscriptionId}`}
          >
            Dismiss
          </Button>
        </div>

        {!o.userConfirmed && (
          <p className="text-xs text-muted-foreground mt-1.5" data-testid={`text-track-hint-${o.subscriptionId}`}>
            Confirm this is your subscription to improve savings accuracy.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Phase 3C.2: renders the savings summary as one line per currency — never a
// single blended figure across currencies, matching CostSummaryLines'
// established convention elsewhere on this page.
function SavingsSummaryLine({ byCurrency }: { byCurrency: SavingsSummary["byCurrency"] }) {
  const entries = Object.entries(byCurrency);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([currency, v]) => (
        <div key={currency} data-testid={`text-savings-summary-${currency}`}>
          ${v.monthly.toFixed(2)}/month · ${v.annual.toFixed(2)}/year {currency}
          <span className="text-xs text-muted-foreground font-normal"> (known amounts only, never invented)</span>
        </div>
      ))}
    </>
  );
}

const PRIORITY_ORDER: RecommendationPriority[] = ["high", "medium", "low"];

function priorityIndicator(p: RecommendationPriority): string {
  switch (p) {
    case "high": return "🔴";
    case "medium": return "🟡";
    case "low": return "⚪";
  }
}

function RecommendationCard({ rec, onOpenDetail }: { rec: Recommendation; onOpenDetail: (id: string) => void }) {
  return (
    <Card data-testid={`card-recommendation-${rec.id}`}>
      <CardContent className="py-4">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-xs font-bold tracking-wide" data-testid={`badge-priority-${rec.id}`}>
            {priorityIndicator(rec.priority)} {rec.priority.toUpperCase()}
          </span>
          <span className="font-semibold" data-testid={`text-recommendation-merchant-${rec.id}`}>{rec.merchant}</span>
        </div>
        <div className="font-medium text-sm mb-1" data-testid={`text-recommendation-title-${rec.id}`}>{rec.title}</div>
        <p className="text-sm text-muted-foreground mb-3" data-testid={`text-recommendation-description-${rec.id}`}>{rec.description}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onOpenDetail(rec.subscriptionId)}
          data-testid={`button-recommendation-action-${rec.id}`}
        >
          {rec.actionLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

function RecommendationsSection({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const { data, isLoading } = useQuery<RecommendationResult>({
    queryKey: ["/api/subscriptions/recommendations"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  if (isLoading || !data) {
    return (
      <Card className="mb-6">
        <CardContent className="py-4">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const sorted = [...data.recommendations].sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
  );

  return (
    <Card className="mb-6">
      <CardContent className="py-4">
        <h2 className="font-semibold mb-3" data-testid="text-recommendations-heading">What needs attention</h2>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-recommendations-empty">
            No action needed — your subscriptions look good.
          </p>
        ) : (
          <div className="space-y-3">
            {sorted.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} onOpenDetail={onOpenDetail} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SavingsSection({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<SavingsAnalysis>({
    queryKey: ["/api/subscriptions/savings"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const trackMutation = useMutation({
    mutationFn: async (subscriptionId: string) => {
      await apiRequest("POST", `/api/subscriptions/${subscriptionId}/confirm`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/subscriptions/savings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/subscriptions"] });
      toast({ title: "Subscription tracked" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to track subscription", description: err.message, variant: "destructive" });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (subscriptionId: string) => {
      await apiRequest("POST", `/api/subscriptions/${subscriptionId}/dismiss-savings`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/subscriptions/savings"] });
      toast({ title: "Opportunity dismissed", description: "You can re-enable dismissed opportunities from settings." });
    },
    onError: (err: any) => {
      toast({ title: "Failed to dismiss", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) {
    return (
      <Card className="mb-6">
        <CardContent className="py-4">
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  const { opportunities, summary } = data;
  const worthReviewing = opportunities.filter((o) => o.classification !== "essential").length;
  const hasCurrencyTotals = Object.keys(summary.byCurrency).length > 0;

  return (
    <Card className="mb-6">
      <CardContent className="py-4">
        <h2 className="font-semibold mb-3 flex items-center gap-1.5" data-testid="text-savings-heading">
          💰 Potential savings
        </h2>

        {worthReviewing === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-savings-empty">
            No savings opportunities detected yet.
          </p>
        ) : (
          <>
            <div className="text-lg font-bold mb-1" data-testid="text-savings-summary-total">
              {hasCurrencyTotals ? (
                <SavingsSummaryLine byCurrency={summary.byCurrency} />
              ) : (
                <span className="text-sm font-medium text-muted-foreground">
                  Subscriptions worth reviewing — costs not yet available
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mb-4" data-testid="text-savings-worth-reviewing">
              {worthReviewing} subscription{worthReviewing === 1 ? "" : "s"} worth reviewing
            </p>

            <div className="space-y-3">
              {opportunities
                .filter((o) => o.classification !== "essential")
                .map((o) => (
                  <SavingsOpportunityCard
                    key={o.subscriptionId}
                    opportunity={o}
                    onOpenDetail={onOpenDetail}
                    onTrack={(id) => trackMutation.mutate(id)}
                    onDismiss={(id) => dismissMutation.mutate(id)}
                    // Track and Dismiss are independent actions on independent
                    // subscriptions — scoping "is this card's button busy" to
                    // BOTH the in-flight mutation AND which subscriptionId it
                    // was called with means clicking Track on one card can
                    // never disable (or otherwise affect) Dismiss on that same
                    // card, or either button on any OTHER card.
                    isTracking={trackMutation.isPending && trackMutation.variables === o.subscriptionId}
                    isDismissing={dismissMutation.isPending && dismissMutation.variables === o.subscriptionId}
                  />
                ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Phase 3B.9.1: the per-subscription cost line. Two genuinely distinct
// "can't show a number" cases, given different messaging:
//   - amount itself unknown -> "Amount unavailable · {interval}" (never $0)
//   - amount known but billing interval unusable (null/unknown/one_time) ->
//     show the known raw amount, but say plainly that the frequency isn't known
// When both are known, the ≈ prefix marks whichever figure the cost engine
// had to DERIVE by dividing (monthly, for any non-monthly billing interval)
// — never the annual figure, and never for a literally-monthly subscription
// (its monthlyCost is exact, not derived).
function formatCostLine(sub: SubscriptionWithCost): string {
  if (sub.monthlyCost !== null && sub.annualCost !== null) {
    const interval = (sub.billingInterval || "").toLowerCase();
    const monthly = `$${sub.monthlyCost.toFixed(2)}`;
    const annual = `$${sub.annualCost.toFixed(2)}`;
    if (interval === "monthly") {
      return `${monthly}/month · ${annual}/year`;
    }
    return `${annual}/year · ≈${monthly}/month`;
  }
  if (!sub.amount) {
    return `Amount unavailable · ${formatInterval(sub.billingInterval)}`;
  }
  return `${formatMoney(sub.amount, sub.currency)} · Unknown billing frequency`;
}

// Phase 3B.9.3 Step 7: provenance line — one fixed phrase per evidence tier,
// exactly as specified. Only rendered when billingInterval itself is known;
// "unknown" source (or a missing interval regardless of source) always
// falls to the plain "Billing frequency: Unknown" line.
function formatBillingProvenance(sub: SubscriptionWithCost): string {
  if (!sub.billingInterval) return "Billing frequency: Unknown";
  const label = formatInterval(sub.billingInterval);
  switch (sub.billingIntervalSource) {
    case "confirmed_email":
      return `${label} · Confirmed from email`;
    case "merchant_knowledge":
      return `${label} · Based on plan details`;
    case "inferred":
      return `${label} · Based on recurring billing pattern`;
    default:
      return "Billing frequency: Unknown";
  }
}

function SubscriptionRow({ sub, onOpenDetail }: { sub: SubscriptionWithCost; onOpenDetail: (id: string) => void }) {
  const initial = sub.canonicalMerchantName.charAt(0).toUpperCase();

  return (
    <Card
      data-testid={`card-subscription-${sub.id}`}
      className="cursor-pointer hover-elevate"
      onClick={() => onOpenDetail(sub.id)}
    >
      <CardContent className="flex items-center gap-4 py-4">
        <Avatar className="h-10 w-10 shrink-0">
          <AvatarFallback className="bg-primary/10 text-primary text-sm font-bold">
            {initial}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-semibold truncate" data-testid={`text-merchant-${sub.id}`}>
              {sub.canonicalMerchantName}
            </span>
            <span
              className={`inline-flex items-center text-xs px-2 py-0.5 rounded-md border font-medium ${statusBadgeClasses(sub.subscriptionStatus)}`}
              data-testid={`badge-status-${sub.id}`}
            >
              {statusLabel(sub.subscriptionStatus)}
            </span>
            {sub.userConfirmed && (
              <span
                className="inline-flex items-center text-xs px-2 py-0.5 rounded-md border font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-700"
                data-testid={`badge-tracked-${sub.id}`}
              >
                ✓ Confirmed by you
              </span>
            )}
          </div>
          <div className="text-sm text-muted-foreground" data-testid={`text-cost-${sub.id}`}>
            {formatCostLine(sub)}
          </div>
          <div className="text-xs text-muted-foreground" data-testid={`text-billing-provenance-${sub.id}`}>
            {formatBillingProvenance(sub)}
          </div>
          <div className="text-sm text-muted-foreground">
            Next renewal: {formatDate(sub.nextBillingDate)}
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
            <Mail className="h-3 w-3" />
            Detected from your email · {sub.costConfidence} confidence
          </div>
        </div>

        <button
          type="button"
          className="shrink-0 text-xs text-primary font-medium flex items-center gap-0.5 self-start"
          data-testid={`button-view-details-${sub.id}`}
          onClick={(e) => { e.stopPropagation(); onOpenDetail(sub.id); }}
        >
          View details <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </CardContent>
    </Card>
  );
}

// Renders "$X.XX CURRENCY" as one line per currency — never a single number
// that blends multiple currencies together. summary.monthlyRecurringCost/
// annualRecurringCost are only non-null when exactly one currency is in
// play; with 2+ currencies (or 0), byCurrency is the only source of truth.
function CostSummaryLines({ byCurrency, field }: { byCurrency: CostSummary["byCurrency"]; field: "monthly" | "annual" }) {
  const entries = Object.entries(byCurrency);
  if (entries.length === 0) {
    return <span>Unknown</span>;
  }
  return (
    <>
      {entries.map(([currency, v]) => (
        <div key={currency}>${v[field].toFixed(2)} {currency}</div>
      ))}
    </>
  );
}

// Phase 3B.9.4 Step 3: driven entirely by nextBillingDate, never projected
// from billingInterval — one row per subscription that actually has a known
// due date within the selected window. isPastDue (a lifecycle-status
// signal, not a date one — see server/renewalCalendar.ts) overrides the
// normal status badge with a plain "Past due" label, matching the real
// shape seen in production: a past_due subscription's nextBillingDate is
// often still in the future (the next retry date), so date and status can
// legitimately disagree. Subscriptions with NO known date get their own
// collapsed section instead of being silently omitted.
function RenewalCalendarSection({ calendar }: { calendar: RenewalCalendar }) {
  const [windowDays, setWindowDays] = useState<30 | 90>(30);
  const [showUnknownDates, setShowUnknownDates] = useState(false);

  const view = windowDays === 30 ? calendar.next30days : calendar.next90days;
  const { upcomingRenewals, unknownDateSubscriptions, upcomingSummary } = view;
  const knownTotalLine = Object.entries(upcomingSummary.byCurrency)
    .map(([currency, total]) => `$${total.toFixed(2)} ${currency}`)
    .join(", ");

  return (
    <Card className="mb-6">
      <CardContent className="py-4">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h2 className="font-semibold" data-testid="text-renewal-calendar-heading">Renewal calendar</h2>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={windowDays === 30 ? "default" : "outline"}
              onClick={() => setWindowDays(30)}
              data-testid="button-window-30"
            >
              Next 30 days
            </Button>
            <Button
              size="sm"
              variant={windowDays === 90 ? "default" : "outline"}
              onClick={() => setWindowDays(90)}
              data-testid="button-window-90"
            >
              Next 90 days
            </Button>
          </div>
        </div>

        {upcomingRenewals.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-renewal-calendar-empty">
            No upcoming renewals in the next {windowDays} days.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {upcomingRenewals.map((entry) => (
                <div
                  key={entry.subscriptionId}
                  className="flex items-center justify-between gap-3 text-sm"
                  data-testid={`row-renewal-${entry.subscriptionId}`}
                >
                  <span className="text-muted-foreground w-14 shrink-0">{formatShortDate(entry.dueDate)}</span>
                  <span className="flex-1 min-w-0 truncate">{entry.merchant}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {entry.amountKnown ? formatMoney(entry.amount, entry.currency) : "Amount unavailable"}
                  </span>
                  <span
                    className={`shrink-0 inline-flex items-center text-xs px-2 py-0.5 rounded-md border font-medium ${statusBadgeClasses(entry.isPastDue ? "past_due" : entry.status)}`}
                  >
                    {entry.isPastDue ? "Past due" : statusLabel(entry.status)}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3" data-testid="text-renewal-calendar-summary">
              {upcomingRenewals.length} upcoming renewal{upcomingRenewals.length === 1 ? "" : "s"}
              {knownTotalLine ? ` · ${knownTotalLine} known` : ""}
            </p>
            {upcomingSummary.unknownAmountCount > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="text-renewal-calendar-unknown-amount">
                + {upcomingSummary.unknownAmountCount} charge{upcomingSummary.unknownAmountCount === 1 ? "" : "s"} with unknown amount
              </p>
            )}
          </>
        )}

        {unknownDateSubscriptions.length > 0 && (
          <div className="mt-4 pt-3 border-t">
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setShowUnknownDates((v) => !v)}
              data-testid="button-toggle-unknown-dates"
            >
              {unknownDateSubscriptions.length} subscription{unknownDateSubscriptions.length === 1 ? "" : "s"} without a known renewal date
            </button>
            {showUnknownDates && (
              <div className="mt-2 space-y-1">
                {unknownDateSubscriptions.map((sub) => (
                  <div
                    key={sub.subscriptionId}
                    className="text-xs text-muted-foreground flex items-center justify-between gap-3"
                    data-testid={`row-unknown-date-${sub.subscriptionId}`}
                  >
                    <span className="truncate">{sub.merchant}</span>
                    <span className="shrink-0">{sub.amount ? formatMoney(sub.amount, sub.currency) : "Amount unavailable"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Phase 3B.9.2B Step 7: one row per upcoming charge, sorted by date
// (server already sorts them), a divider, then a per-currency total line —
// never a single blended number when multiple currencies are present.
function UpcomingChargesSection({ charges, summary }: { charges: UpcomingCharge[]; summary: UpcomingSummary }) {
  const currencyTotals = Object.entries(summary.byCurrency);

  return (
    <Card className="mb-6">
      <CardContent className="py-4">
        <h2 className="font-semibold mb-3" data-testid="text-upcoming-heading">
          Upcoming charges (next {summary.days} days)
        </h2>
        {charges.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-upcoming-empty">
            No upcoming charges in the next {summary.days} days.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {charges.map((charge) => (
                <div key={charge.subscriptionId} className="flex items-center justify-between gap-3 text-sm" data-testid={`row-upcoming-${charge.subscriptionId}`}>
                  <span className="text-muted-foreground w-14 shrink-0">{formatShortDate(charge.dueDate)}</span>
                  <span className="flex-1 min-w-0 truncate">{charge.merchant}</span>
                  <span className="font-medium shrink-0">
                    {charge.amount ? `${formatMoney(charge.amount, charge.currency)}` : "Amount unavailable"}
                  </span>
                </div>
              ))}
            </div>
            <div className="border-t mt-3 pt-3 flex items-center justify-between text-sm font-semibold">
              <span>Total</span>
              <span data-testid="text-upcoming-total">
                {currencyTotals.length === 0
                  ? "Unknown"
                  : currencyTotals.map(([currency, total]) => `$${total.toFixed(2)} ${currency}`).join(", ")}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Phase 3C.3: AI Savings Analyst ──────────────────────────────────────────
// Answers are ephemeral (never persisted) and rendered exactly as returned —
// this page never rewrites or augments what the analyst said, matching
// server/savingsAnalyst.ts's "pass the answer through unmodified" contract.

type AnalystApiResponse = { answer: string; disclaimer: string };

const SUGGESTED_QUESTIONS = [
  "How much am I spending monthly?",
  "Which subscriptions have price increases?",
  "What renews this month?",
  "Which subscriptions are worth reviewing?",
  "How much could I potentially save?",
];

function AnalystSection() {
  const [question, setQuestion] = useState("");

  const askMutation = useMutation({
    mutationFn: async (q: string) => {
      const res = await apiRequest("POST", "/api/subscriptions/analyst", { question: q });
      return (await res.json()) as AnalystApiResponse;
    },
  });

  const handleAsk = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || askMutation.isPending) return;
    setQuestion(trimmed);
    askMutation.mutate(trimmed);
  };

  return (
    <Card className="mb-6">
      <CardContent className="py-4">
        <h2 className="font-semibold mb-3" data-testid="text-analyst-heading">Ask about your subscriptions</h2>

        <div className="flex gap-2 mb-3">
          <Input
            placeholder="What subscriptions am I paying for?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAsk(question); }}
            maxLength={500}
            data-testid="input-analyst-question"
          />
          <Button
            onClick={() => handleAsk(question)}
            disabled={askMutation.isPending || !question.trim()}
            data-testid="button-analyst-ask"
          >
            Ask
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {SUGGESTED_QUESTIONS.map((q, idx) => (
            <button
              key={q}
              type="button"
              disabled={askMutation.isPending}
              className="text-xs px-2 py-1 rounded-md border text-muted-foreground hover-elevate disabled:opacity-50"
              onClick={() => handleAsk(q)}
              data-testid={`button-suggested-question-${idx}`}
            >
              {q}
            </button>
          ))}
        </div>

        {askMutation.isPending && (
          <div className="space-y-2" data-testid="text-analyst-loading">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}

        {!askMutation.isPending && askMutation.isError && (
          <p className="text-sm text-destructive" data-testid="text-analyst-error">
            AI analyst temporarily unavailable.
          </p>
        )}

        {!askMutation.isPending && askMutation.data && (
          <div data-testid="text-analyst-answer-wrapper">
            <p className="text-sm whitespace-pre-wrap" data-testid="text-analyst-answer">{askMutation.data.answer}</p>
            <p className="text-xs text-muted-foreground mt-2" data-testid="text-analyst-disclaimer">
              Based on email-detected data · May be incomplete
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SubscriptionsPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<SubscriptionsResponse>({
    queryKey: ["/api/subscriptions"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const subs = data?.subscriptions ?? [];
  const summary = data?.summary;
  const incompleteTotal = (summary?.incompleteBillingCount ?? 0) + (summary?.unknownCostCount ?? 0);

  // Phase 3B.9.8 STEP 6: subscriptions.lastPriceChange* is written by
  // server/storage.ts's runPriceChangeDetection() and flows through
  // GET /api/subscriptions unmodified (ShadowSubscription's own columns,
  // no extra endpoint needed). "Active" mirrors subscriptionCostEngine.ts's
  // ACTIVE_LIKE_STATUSES exactly so this badge only ever counts
  // subscriptions the cost summary itself already treats as active.
  const ACTIVE_STATUSES = new Set(["active", "trial", "past_due"]);
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const recentPriceChange = (sub: SubscriptionWithCost, type: "increase" | "decrease") =>
    ACTIVE_STATUSES.has(sub.subscriptionStatus) &&
    sub.lastPriceChangeType === type &&
    !!sub.lastPriceChangeAt &&
    new Date(sub.lastPriceChangeAt as unknown as string) >= ninetyDaysAgo;
  const priceIncreaseCount = subs.filter((s) => recentPriceChange(s, "increase")).length;
  const priceDecreaseCount = subs.filter((s) => recentPriceChange(s, "decrease")).length;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <span className="font-bold" data-testid="text-brand">RecallTrial</span>
          </div>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" onClick={() => setLocation("/dashboard")} data-testid="button-dashboard">
              <Layers className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setLocation("/settings")} data-testid="button-settings">
              <Settings className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => logout()} data-testid="button-logout">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Sparkles className="h-5 w-5 text-primary" />
            Your subscriptions
          </h1>
          <p className="text-sm text-muted-foreground">
            Detected from your email — review the details on each before relying on them.
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : subs.length === 0 || !summary ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground" data-testid="text-empty-state">
              No subscriptions detected yet. Connect Gmail and we'll scan your inbox.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
              <Card>
                <CardContent className="py-4">
                  <div className="text-2xl font-bold" data-testid="text-total-detected">{summary.totalSubscriptions}</div>
                  <div className="text-xs text-muted-foreground">Subscriptions</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <div className="text-lg font-bold" data-testid="text-monthly-cost">
                    <CostSummaryLines byCurrency={summary.byCurrency} field="monthly" />
                  </div>
                  <div className="text-xs text-muted-foreground">Monthly recurring cost</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <div className="text-lg font-bold" data-testid="text-annual-cost">
                    <CostSummaryLines byCurrency={summary.byCurrency} field="annual" />
                  </div>
                  <div className="text-xs text-muted-foreground">Annual recurring cost</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <div className="text-2xl font-bold" data-testid="text-messages-scanned">
                    {data?.messagesScanned ?? "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {data?.messagesScanned != null ? `Detected from ${data.messagesScanned} emails scanned` : "Emails scanned"}
                  </div>
                </CardContent>
              </Card>
            </div>

            {priceIncreaseCount > 0 ? (
              <p className="text-xs font-medium text-amber-600 dark:text-amber-500 mb-1" data-testid="text-price-increase-badge">
                ⚠️ {priceIncreaseCount} price increase{priceIncreaseCount === 1 ? "" : "s"} detected
              </p>
            ) : priceDecreaseCount > 0 ? (
              <p className="text-xs font-medium text-emerald-600 dark:text-emerald-500 mb-1" data-testid="text-price-decrease-badge">
                ✓ {priceDecreaseCount} price decrease{priceDecreaseCount === 1 ? "" : "s"}
              </p>
            ) : null}

            {incompleteTotal > 0 && (
              <p className="text-xs text-muted-foreground mb-4" data-testid="text-incomplete-billing">
                {incompleteTotal} subscription{incompleteTotal === 1 ? "" : "s"} {incompleteTotal === 1 ? "has" : "have"} incomplete billing information.
              </p>
            )}

            <RecommendationsSection onOpenDetail={setSelectedSubId} />

            <SavingsSection onOpenDetail={setSelectedSubId} />

            {data?.renewalCalendar && (
              <RenewalCalendarSection calendar={data.renewalCalendar} />
            )}

            {data?.upcomingSummary && (
              <UpcomingChargesSection charges={data.upcomingCharges ?? []} summary={data.upcomingSummary} />
            )}

            <div className="space-y-3">
              {subs.map((sub) => (
                <SubscriptionRow key={sub.id} sub={sub} onOpenDetail={setSelectedSubId} />
              ))}
            </div>

            <div className="mt-6">
              <AnalystSection />
            </div>
          </>
        )}
      </main>

      <SubscriptionDetailSheet subscriptionId={selectedSubId} onClose={() => setSelectedSubId(null)} />
    </div>
  );
}
