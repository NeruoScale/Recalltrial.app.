import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getQueryFn } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useLocation, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, ArrowLeft, ExternalLink, Calendar, DollarSign, Clock, X } from "lucide-react";
import type { Trial, Reminder } from "@shared/schema";
import { format, parseISO, differenceInDays } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function TrialDetail() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const params = useParams<{ id: string }>();
  const { toast } = useToast();

  const { data: trial, isLoading } = useQuery<Trial>({
    queryKey: ["/api/trials", params.id],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const { data: reminders } = useQuery<Reminder[]>({
    queryKey: ["/api/trials", params.id, "reminders"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/trials/${params.id}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trials", params.id] });
      toast({ title: "Trial marked as canceled" });
    },
  });

  if (!user) {
    setLocation("/auth/login");
    return null;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b sticky top-0 bg-background z-50">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-4">
            <Button size="icon" variant="ghost" onClick={() => setLocation("/dashboard")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Skeleton className="h-5 w-32" />
          </div>
        </header>
        <main className="max-w-lg mx-auto px-4 py-6 space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-20 w-full" />
        </main>
      </div>
    );
  }

  if (!trial) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Trial not found</p>
      </div>
    );
  }

  const daysLeft = differenceInDays(parseISO(trial.endDate), new Date());
  const cancelLink = trial.cancelUrl || trial.serviceUrl;
  const initial = trial.serviceName.charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 bg-background z-50">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-4">
          <Button size="icon" variant="ghost" onClick={() => setLocation("/dashboard")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <span className="font-bold">RecallTrial</span>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <Avatar className="h-14 w-14">
                {trial.iconUrl ? <AvatarImage src={trial.iconUrl} alt={trial.serviceName} /> : null}
                <AvatarFallback className="bg-primary/10 text-primary text-xl font-bold">{initial}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <h1 className="text-xl font-bold" data-testid="text-trial-name">{trial.serviceName}</h1>
                <p className="text-sm text-muted-foreground truncate">{trial.domain}</p>
                <div className="mt-2">
                  {trial.status === "CANCELED" ? (
                    <Badge variant="secondary">Canceled</Badge>
                  ) : daysLeft < 0 ? (
                    <Badge variant="destructive">Expired</Badge>
                  ) : daysLeft <= 3 ? (
                    <Badge variant="destructive">Ends in {daysLeft} day{daysLeft !== 1 ? "s" : ""}</Badge>
                  ) : (
                    <Badge variant="secondary">{daysLeft} days left</Badge>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
              <div>
                <span className="text-muted-foreground">Started: </span>
                <span className="font-medium">{format(parseISO(trial.startDate), "MMMM d, yyyy")}</span>
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
              <div>
                <span className="text-muted-foreground">Ends: </span>
                <span className="font-medium">{format(parseISO(trial.endDate), "MMMM d, yyyy")}</span>
              </div>
            </div>
            {trial.renewalPrice && (
              <div className="flex items-center gap-3 text-sm">
                <DollarSign className="h-4 w-4 text-muted-foreground shrink-0" />
                <div>
                  <span className="text-muted-foreground">Renewal price: </span>
                  <span className="font-medium">{trial.renewalPrice} {trial.currency}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {reminders && reminders.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reminders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {reminders.map((r) => (
                <div key={r.id} className="flex items-center gap-3 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1">
                    {r.type === "THREE_DAYS" ? "3 days before" : "1 day before"} —{" "}
                    {format(new Date(r.remindAt), "MMM d, yyyy 'at' h:mm a")}
                  </span>
                  <Badge variant={r.status === "SENT" ? "secondary" : r.status === "SKIPPED" ? "secondary" : "default"}>
                    {r.status}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="flex gap-3">
          <Button
            className="flex-1"
            onClick={() => window.open(cancelLink, "_blank")}
            data-testid="button-open-cancel"
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Open cancel page
          </Button>
          {trial.status === "ACTIVE" && (
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              data-testid="button-mark-canceled"
            >
              <X className="h-4 w-4 mr-2" />
              Mark as canceled
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}
