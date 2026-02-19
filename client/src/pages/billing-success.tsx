import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bell, CheckCircle } from "lucide-react";
import { useEffect } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";

export default function BillingSuccess() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    const syncPlan = async () => {
      try {
        await apiRequest("POST", "/api/billing/sync");
      } catch {}
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    };
    syncPlan();
  }, []);

  const planName = user?.plan === "PREMIUM" ? "Premium" : "Pro";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-2">
          <Bell className="h-5 w-5 text-primary" />
          <span className="font-bold">RecallTrial</span>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-20">
        <Card>
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-2xl font-bold" data-testid="text-success-title">Payment successful!</h1>
            <p className="text-muted-foreground" data-testid="text-success-description">
              You're now on the {planName} plan. Enjoy unlimited trials
              {user?.plan === "PREMIUM" ? ", priority reminders, and priority support" : " and full reminder history"}.
            </p>
            <Button onClick={() => setLocation("/dashboard")} data-testid="button-go-dashboard">
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
