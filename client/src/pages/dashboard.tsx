import { useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, getQueryFn } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrialCard } from "@/components/trial-card";
import { Bell, Plus, LogOut, Settings, AlertTriangle, Clock, Archive, Zap, ArrowRight, Sparkles, CheckCircle, X, Mail } from "lucide-react";
import type { Trial, SuggestedTrial } from "@shared/schema";
import { differenceInDays, parseISO } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: trials, isLoading } = useQuery<Trial[]>({
    queryKey: ["/api/trials"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const isPro = user?.plan === "PRO" || user?.plan === "PREMIUM";
  const showSuggestions = isPro && user?.emailScanningEnabled;

  const { data: suggestions } = useQuery<SuggestedTrial[]>({
    queryKey: ["/api/suggested-trials"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!showSuggestions,
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

  const addSuggestionMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/suggested-trials/${id}/add`);
      return res.json();
    },
    onSuccess: (data: { trial: Trial }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/trials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suggested-trials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: `${data.trial.serviceName} added`, description: "Trial added successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Failed to add trial", description: err.message, variant: "destructive" });
    },
  });

  const ignoreSuggestionMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/suggested-trials/${id}/ignore`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/suggested-trials"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to ignore", description: err.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (!user) setLocation("/auth/login");
  }, [user, setLocation]);

  if (!user) return null;

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

  const activeCount = user.activeTrialCount ?? 0;
  const limit = user.trialLimit;
  const atLimit = limit !== null && activeCount >= limit;
  const isFree = (user.plan || "FREE") === "FREE";

  const pendingSuggestions = (suggestions || []).filter((s) => s.status === "new");

  const handleAddTrial = () => {
    if (atLimit) {
      toast({
        title: "Trial limit reached",
        description: isFree
          ? "Free plan allows up to 3 active trials. Upgrade to Plus for unlimited."
          : "Cancel an existing trial to add a new one.",
        variant: "destructive",
      });
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
              {limit !== null
                ? `${activeCount} of ${limit} active trial${activeCount !== 1 ? "s" : ""} used`
                : `${activeCount} active trial${activeCount !== 1 ? "s" : ""}`}
            </p>
          </div>
          <Button onClick={handleAddTrial} disabled={atLimit} data-testid="button-add-trial">
            <Plus className="h-4 w-4 mr-2" />
            Add Trial
          </Button>
        </div>

        {atLimit && (
          <div className="mb-6 p-3 rounded-md border bg-muted/50 flex items-center justify-between gap-3 flex-wrap" data-testid="banner-limit-warning">
            <p className="text-sm">
              {isFree
                ? "You've reached the Free plan limit of 3 active trials."
                : "You've reached your trial limit. Cancel an existing trial to add a new one."}
            </p>
            {isFree && user.billingEnabled && (
              <Button size="sm" onClick={() => setLocation("/pricing")} data-testid="button-upgrade-cta">
                <Sparkles className="h-4 w-4 mr-1" />
                Upgrade to Plus
              </Button>
            )}
          </div>
        )}

        {showSuggestions && pendingSuggestions.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <Mail className="h-4 w-4 text-primary" />
              <h2 className="font-semibold" data-testid="text-section-suggestions">
                Suggested Trials
              </h2>
              <Badge variant="secondary" className="text-xs">{pendingSuggestions.length}</Badge>
            </div>
            <div className="space-y-2">
              {pendingSuggestions.map((s) => (
                <Card key={s.id} data-testid={`card-suggestion-${s.id}`} className="border-primary/20">
                  <CardContent className="py-3 px-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <p className="font-medium text-sm truncate" data-testid={`text-suggestion-service-${s.id}`}>
                            {s.serviceGuess || s.fromDomain || "Unknown service"}
                          </p>
                          <Badge
                            variant={s.confidence >= 70 ? "default" : "secondary"}
                            className="text-xs shrink-0"
                            data-testid={`badge-confidence-${s.id}`}
                          >
                            {s.confidence}% match
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground truncate" data-testid={`text-suggestion-subject-${s.id}`}>
                          {s.subject}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                          {s.endDateGuess && (
                            <span>Ends ~{new Date(s.endDateGuess).toLocaleDateString()}</span>
                          )}
                          {s.amountGuess && (
                            <span>{s.currencyGuess} {s.amountGuess}/mo</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="sm"
                          onClick={() => addSuggestionMutation.mutate(s.id)}
                          disabled={addSuggestionMutation.isPending}
                          data-testid={`button-add-suggestion-${s.id}`}
                        >
                          <CheckCircle className="h-3.5 w-3.5 mr-1" />
                          Add
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => ignoreSuggestionMutation.mutate(s.id)}
                          disabled={ignoreSuggestionMutation.isPending}
                          data-testid={`button-ignore-suggestion-${s.id}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-md" />
            ))}
          </div>
        ) : allTrials.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
              <Bell className="h-10 w-10 text-primary" />
            </div>
            <h2 className="text-xl font-semibold mb-2" data-testid="text-empty-title">Add your first trial</h2>
            <p className="text-muted-foreground mb-2 max-w-sm mx-auto">
              Add a trial in 20 seconds. We'll remind you before renewal.
            </p>
            <div className="flex flex-col items-center gap-3 my-6 text-sm text-muted-foreground">
              <Card className="w-full max-w-sm">
                <CardContent className="py-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-xs font-bold text-primary">1</div>
                    <span>Add a trial (service, dates, cancel link)</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-xs font-bold text-primary">2</div>
                    <span>We email you before renewal</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-xs font-bold text-primary">3</div>
                    <span>Tap cancel link instantly</span>
                  </div>
                </CardContent>
              </Card>
            </div>
            <Button onClick={() => setLocation("/trials/new")} data-testid="button-add-first-trial">
              <Plus className="h-4 w-4 mr-2" />
              Add your first trial
              <ArrowRight className="h-4 w-4 ml-2" />
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
    </div>
  );
}
