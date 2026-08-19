import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, LogOut, Settings, Layers, Mail, Sparkles } from "lucide-react";
import type { ShadowSubscription } from "@shared/schema";

// Phase 3B.7.3: reads exclusively from GET /api/subscriptions, which in turn
// reads only from the `subscriptions` shadow table (isShadow=true,
// resolutionStatus="resolved"). Nothing on this page can create/update a
// trial or reminder, and nothing here ever flips isShadow — nothing shown
// is "confirmed," it's "detected." Labeled that way everywhere on purpose.

type SubscriptionsResponse = {
  subscriptions: ShadowSubscription[];
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

function confidenceLabel(confidence: number | null): { label: "High" | "Medium" | "Low"; variant: "default" | "secondary" | "outline" } {
  const c = confidence ?? 0;
  if (c >= 70) return { label: "High", variant: "default" };
  if (c >= 40) return { label: "Medium", variant: "secondary" };
  return { label: "Low", variant: "outline" };
}

function statusLabel(status: ShadowSubscription["subscriptionStatus"]): string {
  switch (status) {
    case "active": return "Active";
    case "trial": return "Trial";
    case "past_due": return "Past due";
    case "canceled": return "Canceled";
    default: return "Unknown";
  }
}

// Monthly-equivalent conversion, applied only within a single currency —
// mixing currencies into one sum would require inventing an FX rate, which
// this app's own architecture explicitly forbids (PHASE1_AUDIT.md §12/
// VISION.md's "do not invent" principle). billingInterval is unpopulated by
// any upstream pipeline stage today, so "unknown interval" is treated as
// already-monthly (the common case) rather than excluded outright.
function monthlyEquivalent(amount: string, interval: string | null): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  switch ((interval || "").toLowerCase()) {
    case "year":
    case "yearly":
    case "annual":
      return n / 12;
    case "week":
    case "weekly":
      return n * 4.345;
    default:
      return n;
  }
}

function computeMonthlyRecurringCost(subs: ShadowSubscription[]): { amount: number; currency: string }[] {
  const byCurrency = new Map<string, number>();
  for (const s of subs) {
    if (!s.amount || !s.currency) continue;
    const current = byCurrency.get(s.currency) || 0;
    byCurrency.set(s.currency, current + monthlyEquivalent(s.amount, s.billingInterval));
  }
  return Array.from(byCurrency.entries()).map(([currency, amount]) => ({ currency, amount }));
}

function SubscriptionRow({ sub }: { sub: ShadowSubscription }) {
  const initial = sub.canonicalMerchantName.charAt(0).toUpperCase();
  const confidence = confidenceLabel(sub.merchantConfidence);

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
            <Badge variant="outline" className="text-xs">{statusLabel(sub.subscriptionStatus)}</Badge>
            <Badge variant={confidence.variant} className="text-xs">{confidence.label} confidence</Badge>
          </div>
          <div className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
            <span>{formatMoney(sub.amount, sub.currency)}</span>
            <span>·</span>
            <span>{formatInterval(sub.billingInterval)}</span>
            <span>·</span>
            <span>Next renewal: {formatDate(sub.nextBillingDate)}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
            <Mail className="h-3 w-3" />
            Detected from your email
          </div>
        </div>
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
  const monthlyCosts = computeMonthlyRecurringCost(subs);

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
            Detected Subscriptions
          </h1>
          <p className="text-sm text-muted-foreground">
            Subscriptions our email scan detected — not manually confirmed. Review before treating any of these as accurate.
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : subs.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground" data-testid="text-empty-state">
              No subscriptions detected yet. Connect Gmail and we'll scan your inbox.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
              <Card>
                <CardContent className="py-4">
                  <div className="text-2xl font-bold" data-testid="text-total-detected">{subs.length}</div>
                  <div className="text-xs text-muted-foreground">Detected subscriptions</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <div className="text-2xl font-bold" data-testid="text-monthly-cost">
                    {monthlyCosts.length === 0
                      ? "Unknown"
                      : monthlyCosts.map((c) => `${c.amount.toFixed(2)} ${c.currency}`).join(", ")}
                  </div>
                  <div className="text-xs text-muted-foreground">Est. monthly recurring cost</div>
                </CardContent>
              </Card>
              <Card className="col-span-2 sm:col-span-1">
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
