import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bell, CheckCircle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { queryClient, apiRequest } from "@/lib/queryClient";

export default function BillingSuccess() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    const syncPlan = async () => {
      try {
        await apiRequest("POST", "/api/billing/sync");
      } catch {}
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setSynced(true);
    };
    const timer = setTimeout(syncPlan, 2000);
    return () => clearTimeout(timer);
  }, []);

  const planName = user?.plan === "PRO" ? "Pro" : user?.plan === "PLUS" ? "Plus" : "your new";

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-8 pb-8 text-center space-y-4">
          {synced ? (
            <>
              <div className="mx-auto w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
                <CheckCircle className="h-8 w-8 text-green-500" />
              </div>
              <h1 className="text-2xl font-bold" data-testid="text-success-title">You're upgraded!</h1>
              <p className="text-muted-foreground" data-testid="text-success-description">
                Welcome to the {planName} plan.{" "}
                {user?.plan === "PRO"
                  ? "You now have unlimited trials and priority support."
                  : user?.plan === "PLUS"
                    ? "You now have unlimited trials and calendar export."
                    : "Your plan has been updated."}
              </p>
              <Button onClick={() => setLocation("/dashboard")} data-testid="button-go-dashboard">
                Go to Dashboard
              </Button>
            </>
          ) : (
            <>
              <Loader2 className="h-14 w-14 text-primary mx-auto animate-spin" />
              <h2 className="text-xl font-bold">Activating your plan...</h2>
              <p className="text-muted-foreground">This only takes a moment.</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
