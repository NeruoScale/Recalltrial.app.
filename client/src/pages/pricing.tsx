import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, ArrowLeft, Check, Sparkles, Loader2, Crown } from "lucide-react";

type PriceInfo = { priceId: string; amount: number; currency: string; interval: string };
type PricesData = {
  pro: { monthly: PriceInfo; yearly: PriceInfo };
  premium: { monthly: PriceInfo; yearly: PriceInfo };
};

export default function Pricing() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  const { data: prices } = useQuery<PricesData>({
    queryKey: ["/api/billing/prices"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const checkoutMutation = useMutation({
    mutationFn: async (priceId: string) => {
      const res = await apiRequest("POST", "/api/billing/create-checkout-session", { priceId });
      return res.json();
    },
    onSuccess: (data: { url: string }) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
  });

  const currentPlan = user?.plan || "FREE";

  const freeFeatures = [
    "Up to 5 active trials",
    "Email reminders (3 days + 1 day before)",
    "Calendar export (ICS)",
    "Cancel link in every reminder",
  ];

  const proFeatures = [
    "Unlimited active trials",
    "Email reminders (3 days + 1 day before)",
    "Calendar export (ICS)",
    "Cancel link in every reminder",
    "Full reminder history",
  ];

  const premiumFeatures = [
    "Everything in Pro",
    "Priority reminders (6 hours before)",
    "Priority email support",
    "Early access to new features",
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-4">
          <Button size="icon" variant="ghost" onClick={() => setLocation(user ? "/dashboard" : "/")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <span className="font-bold">RecallTrial</span>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold mb-3" data-testid="text-pricing-title">Simple, transparent pricing</h1>
          <p className="text-muted-foreground">Start free. Upgrade when you need more.</p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Free</CardTitle>
              <CardDescription>For casual users</CardDescription>
              <div className="mt-2">
                <span className="text-3xl font-bold">$0</span>
                <span className="text-muted-foreground"> / forever</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {freeFeatures.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {currentPlan === "FREE" ? (
                <Button variant="outline" className="w-full" disabled data-testid="button-free-current">
                  Current plan
                </Button>
              ) : (
                <Button variant="outline" className="w-full" disabled>
                  {currentPlan === "PRO" ? "Current: Pro" : "Current: Premium"}
                </Button>
              )}
            </CardContent>
          </Card>

          <Card className="border-primary">
            <CardHeader>
              <div className="flex items-center gap-2 mb-1">
                <CardTitle>Pro</CardTitle>
                <Badge>Popular</Badge>
              </div>
              <CardDescription>For power users who track many trials</CardDescription>
              <div className="mt-2 space-y-1">
                <div>
                  <span className="text-3xl font-bold">$4.99</span>
                  <span className="text-muted-foreground"> / month</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  or <span className="font-semibold text-foreground">$49.90/year</span> (save 17%)
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {proFeatures.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {currentPlan === "PRO" ? (
                <Button className="w-full" disabled data-testid="button-pro-current">
                  <Sparkles className="h-4 w-4 mr-2" />
                  You're on Pro
                </Button>
              ) : currentPlan === "PREMIUM" ? (
                <Button variant="outline" className="w-full" disabled>
                  Current: Premium
                </Button>
              ) : (
                <div className="space-y-2">
                  <Button
                    className="w-full"
                    disabled={checkoutMutation.isPending || !prices?.pro?.monthly?.priceId}
                    onClick={() => prices?.pro?.monthly?.priceId && checkoutMutation.mutate(prices.pro.monthly.priceId)}
                    data-testid="button-upgrade-pro-monthly"
                  >
                    {checkoutMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-2" />
                    )}
                    Upgrade Monthly — $4.99/mo
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={checkoutMutation.isPending || !prices?.pro?.yearly?.priceId}
                    onClick={() => prices?.pro?.yearly?.priceId && checkoutMutation.mutate(prices.pro.yearly.priceId)}
                    data-testid="button-upgrade-pro-yearly"
                  >
                    Upgrade Yearly — $49.90/yr
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2 mb-1">
                <CardTitle>Premium</CardTitle>
                <Badge variant="secondary">
                  <Crown className="h-3 w-3 mr-1" />
                  Best value
                </Badge>
              </div>
              <CardDescription>For those who want the complete experience</CardDescription>
              <div className="mt-2 space-y-1">
                <div>
                  <span className="text-3xl font-bold">$9.99</span>
                  <span className="text-muted-foreground"> / month</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  or <span className="font-semibold text-foreground">$99.90/year</span> (save 17%)
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {premiumFeatures.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {currentPlan === "PREMIUM" ? (
                <Button className="w-full" disabled data-testid="button-premium-current">
                  <Crown className="h-4 w-4 mr-2" />
                  You're on Premium
                </Button>
              ) : (
                <div className="space-y-2">
                  <Button
                    className="w-full"
                    disabled={checkoutMutation.isPending || !prices?.premium?.monthly?.priceId}
                    onClick={() => prices?.premium?.monthly?.priceId && checkoutMutation.mutate(prices.premium.monthly.priceId)}
                    data-testid="button-upgrade-premium-monthly"
                  >
                    {checkoutMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Crown className="h-4 w-4 mr-2" />
                    )}
                    Upgrade Monthly — $9.99/mo
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={checkoutMutation.isPending || !prices?.premium?.yearly?.priceId}
                    onClick={() => prices?.premium?.yearly?.priceId && checkoutMutation.mutate(prices.premium.yearly.priceId)}
                    data-testid="button-upgrade-premium-yearly"
                  >
                    Upgrade Yearly — $99.90/yr
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      <footer className="border-t py-8 px-4 mt-10">
        <div className="max-w-5xl mx-auto text-center text-sm text-muted-foreground">
          <p>&copy; 2026 RecallTrial - All Rights Reserved</p>
        </div>
      </footer>
    </div>
  );
}
