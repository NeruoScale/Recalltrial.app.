import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, LogOut, Settings, Layers, Mail, Sparkles } from "lucide-react";
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

type SubscriptionsResponse = {
  subscriptions: SubscriptionWithCost[];
  summary: CostSummary;
  upcomingCharges: UpcomingCharge[];
  upcomingSummary: UpcomingSummary;
  messagesScanned: number | null;
};

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

function SubscriptionRow({ sub }: { sub: SubscriptionWithCost }) {
  const initial = sub.canonicalMerchantName.charAt(0).toUpperCase();

  return (
    <Card data-testid={`card-subscription-${sub.id}`}>
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

export default function SubscriptionsPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();

  const { data, isLoading } = useQuery<SubscriptionsResponse>({
    queryKey: ["/api/subscriptions"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const subs = data?.subscriptions ?? [];
  const summary = data?.summary;
  const incompleteTotal = (summary?.incompleteBillingCount ?? 0) + (summary?.unknownCostCount ?? 0);

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

            {incompleteTotal > 0 && (
              <p className="text-xs text-muted-foreground mb-4" data-testid="text-incomplete-billing">
                {incompleteTotal} subscription{incompleteTotal === 1 ? "" : "s"} {incompleteTotal === 1 ? "has" : "have"} incomplete billing information.
              </p>
            )}

            {data?.upcomingSummary && (
              <UpcomingChargesSection charges={data.upcomingCharges ?? []} summary={data.upcomingSummary} />
            )}

            <div className="space-y-3">
              {subs.map((sub) => (
                <SubscriptionRow key={sub.id} sub={sub} />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
