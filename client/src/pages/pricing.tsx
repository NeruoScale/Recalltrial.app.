import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, ArrowLeft, Check, Loader2, Sparkles, Shield, Mail } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type PriceInfo = { priceId: string; amount: number; currency: string; interval: string };
type PricesData = {
  plus: { monthly: PriceInfo };
  pro: { monthly: PriceInfo };
};

export default function PricingPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

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
    onError: (err: any) => {
      toast({ title: "Checkout error", description: err.message, variant: "destructive" });
    },
  });

  const handleUpgrade = (planId: string) => {
    if (!user) {
      setLocation("/auth/signup");
      return;
    }
    const priceId = prices?.[planId as keyof PricesData]?.monthly?.priceId;
    if (priceId) {
      checkoutMutation.mutate(priceId);
    } else {
      toast({ title: "Unable to start checkout", variant: "destructive" });
    }
  };

  const userPlan = (user?.plan || "FREE").toUpperCase();

  const plans = [
    {
      id: "free",
      dbPlan: "FREE",
      name: "Free",
      price: "$0",
      period: "forever",
      description: "Get started with the basics",
      features: [
        "Up to 3 active trials",
        "Email reminders (3d + 1d before renewal)",
        "Cancel link storage",
        "Service icon auto-detection",
      ],
      icon: Shield,
      highlight: false,
    },
    {
      id: "plus",
      dbPlan: "PLUS",
      name: "Plus",
      price: "$3.99",
      period: "/month",
      description: "Unlimited trials + calendar",
      features: [
        "Unlimited active trials",
        "Calendar export (.ics download)",
        "Reminder customization",
        "Everything in Free",
      ],
      icon: Sparkles,
      highlight: true,
    },
    {
      id: "pro",
      dbPlan: "PRO",
      name: "Pro",
      price: "$7.99",
      period: "/month",
      description: "Everything + email scanning",
      features: [
        "Everything in Plus",
        "Email scanning (coming soon, opt-in)",
        "Priority support",
        "Your inbox stays private",
      ],
      icon: Mail,
      highlight: false,
    },
  ];

  const planOrder: Record<string, number> = { FREE: 0, PLUS: 1, PRO: 2, PREMIUM: 3 };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Bell className="h-6 w-6 text-primary" />
            <span className="font-bold text-lg">RecallTrial</span>
          </div>
          <Button variant="ghost" onClick={() => setLocation(user ? "/dashboard" : "/")} data-testid="link-back">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold mb-2" data-testid="text-pricing-title">Simple, honest pricing</h1>
          <p className="text-muted-foreground">Start free. Upgrade when you need more.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((plan) => {
            const isCurrent = userPlan === plan.dbPlan;
            const isUpgrade = (planOrder[plan.dbPlan] || 0) > (planOrder[userPlan] || 0);
            const Icon = plan.icon;

            return (
              <Card
                key={plan.id}
                className={`relative flex flex-col ${plan.highlight ? "border-primary shadow-md" : ""}`}
                data-testid={`card-plan-${plan.id}`}
              >
                {plan.highlight && (
                  <Badge className="absolute -top-3 left-1/2 -translate-x-1/2" data-testid="badge-popular">
                    Most Popular
                  </Badge>
                )}
                <CardHeader className="text-center pb-2">
                  <div className="mx-auto w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <CardTitle className="text-xl">{plan.name}</CardTitle>
                  <CardDescription>{plan.description}</CardDescription>
                  <div className="mt-3">
                    <span className="text-3xl font-bold">{plan.price}</span>
                    <span className="text-muted-foreground text-sm">{plan.period}</span>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col">
                  <ul className="space-y-2.5 flex-1 mb-6">
                    {plan.features.map((feature, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  {isCurrent ? (
                    <Button variant="outline" disabled className="w-full" data-testid={`button-plan-${plan.id}`}>
                      Current Plan
                    </Button>
                  ) : isUpgrade && plan.id !== "free" ? (
                    <Button
                      className="w-full"
                      variant={plan.highlight ? "default" : "outline"}
                      onClick={() => handleUpgrade(plan.id)}
                      disabled={checkoutMutation.isPending}
                      data-testid={`button-plan-${plan.id}`}
                    >
                      {checkoutMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>Upgrade to {plan.name}</>
                      )}
                    </Button>
                  ) : (
                    <Button variant="outline" disabled className="w-full" data-testid={`button-plan-${plan.id}`}>
                      {isCurrent ? "Current Plan" : plan.id === "free" ? "Free" : `Upgrade to ${plan.name}`}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="text-center mt-8 text-sm text-muted-foreground space-y-1">
          <p>All plans include email reminders, cancel link storage, and fuzzy service search.</p>
          <p>Email scanning is optional and coming later as an opt-in feature. Your inbox stays private.</p>
          <p>Powered by Stripe. Cancel anytime.</p>
        </div>
      </main>

      <footer className="border-t py-8 px-4">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            <span className="font-medium text-foreground">RecallTrial</span>
          </div>
          <p>&copy; 2026 RecallTrial - All Rights Reserved</p>
        </div>
      </footer>
    </div>
  );
}
