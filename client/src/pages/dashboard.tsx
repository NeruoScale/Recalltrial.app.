import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, getQueryFn } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrialCard } from "@/components/trial-card";
import { UpgradeModal } from "@/components/upgrade-modal";
import { Bell, Plus, LogOut, Settings, AlertTriangle, Clock, Archive, Sparkles } from "lucide-react";
import type { Trial } from "@shared/schema";
import { differenceInDays, parseISO } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const { data: trials, isLoading } = useQuery<Trial[]>({
    queryKey: ["/api/trials"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/trials/${id}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Trial marked as canceled" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to cancel", description: err.message, variant: "destructive" });
    },
  });

  if (!user) {
    setLocation("/auth/login");
    return null;
  }

  const allTrials = trials || [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const urgent = allTrials.filter(
    (t) => t.status === "ACTIVE" && differenceInDays(parseISO(t.endDate), now) <= 3 && differenceInDays(parseISO(t.endDate), now) >= 0
  );
  const upcoming = allTrials.filter(
    (t) => t.status === "ACTIVE" && differenceInDays(parseISO(t.endDate), now) > 3
  );
  const canceled = allTrials.filter((t) => t.status === "CANCELED");
  const expired = allTrials.filter(
    (t) => t.status === "ACTIVE" && differenceInDays(parseISO(t.endDate), now) < 0
  );

  const isPaid = user.plan !== "FREE";
  const activeCount = user.activeTrialCount ?? 0;
  const limit = user.trialLimit;
  const atLimit = !isPaid && limit !== null && activeCount >= limit;

  const handleAddTrial = () => {
    if (atLimit) {
      setUpgradeOpen(true);
    } else {
      setLocation("/trials/new");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <span className="font-bold" data-testid="text-brand">RecallTrial</span>
          </div>
          <div className="flex items-center gap-1">
            {!isPaid && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLocation("/pricing")}
                data-testid="button-upgrade"
              >
                <Sparkles className="h-4 w-4 mr-1" />
                Upgrade
              </Button>
            )}
            {user.plan === "PRO" && (
              <Badge data-testid="badge-pro">Pro</Badge>
            )}
            {user.plan === "PREMIUM" && (
              <Badge data-testid="badge-premium">Premium</Badge>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setLocation("/settings")}
              data-testid="button-settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => logout()}
              data-testid="button-logout"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Your Trials</h1>
            <p className="text-sm text-muted-foreground" data-testid="text-trial-count">
              {activeCount} active trial{activeCount !== 1 ? "s" : ""}
              {!isPaid && limit !== null && ` of ${limit}`}
            </p>
          </div>
          <Button onClick={handleAddTrial} data-testid="button-add-trial">
            <Plus className="h-4 w-4 mr-2" />
            Add Trial
          </Button>
        </div>

        {!isPaid && limit !== null && activeCount >= limit - 1 && activeCount > 0 && (
          <div className="mb-6 p-3 rounded-md border bg-muted/50 flex items-center justify-between gap-3 flex-wrap" data-testid="banner-limit-warning">
            <p className="text-sm">
              {atLimit
                ? "You've reached the free limit. Upgrade to Pro for unlimited trials."
                : `You have ${limit - activeCount} trial slot${limit - activeCount !== 1 ? "s" : ""} remaining on your free plan.`}
            </p>
            <Button variant="outline" size="sm" onClick={() => setLocation("/pricing")} data-testid="button-banner-upgrade">
              <Sparkles className="h-4 w-4 mr-1" />
              Upgrade
            </Button>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-md" />
            ))}
          </div>
        ) : allTrials.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
              <Bell className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold mb-2">No trials yet</h2>
            <p className="text-muted-foreground mb-6">
              Add your first free trial and we'll remind you before it renews.
            </p>
            <Button onClick={() => setLocation("/trials/new")} data-testid="button-add-first-trial">
              <Plus className="h-4 w-4 mr-2" />
              Add your first trial
            </Button>
          </div>
        ) : (
          <div className="space-y-8">
            {urgent.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <h2 className="font-semibold text-destructive" data-testid="text-section-urgent">
                    Urgent — ending soon
                  </h2>
                </div>
                <div className="space-y-2">
                  {urgent.map((t) => (
                    <TrialCard key={t.id} trial={t} onCancel={(id) => cancelMutation.mutate(id)} />
                  ))}
                </div>
              </section>
            )}

            {upcoming.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold" data-testid="text-section-upcoming">Upcoming</h2>
                </div>
                <div className="space-y-2">
                  {upcoming.map((t) => (
                    <TrialCard key={t.id} trial={t} onCancel={(id) => cancelMutation.mutate(id)} />
                  ))}
                </div>
              </section>
            )}

            {expired.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold text-muted-foreground">Expired</h2>
                </div>
                <div className="space-y-2">
                  {expired.map((t) => (
                    <TrialCard key={t.id} trial={t} onCancel={(id) => cancelMutation.mutate(id)} />
                  ))}
                </div>
              </section>
            )}

            {canceled.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <Archive className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold text-muted-foreground" data-testid="text-section-canceled">Canceled</h2>
                </div>
                <div className="space-y-2 opacity-60">
                  {canceled.map((t) => (
                    <TrialCard key={t.id} trial={t} onCancel={(id) => cancelMutation.mutate(id)} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      <UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} />
    </div>
  );
}
