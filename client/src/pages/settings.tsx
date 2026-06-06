import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bell, ArrowLeft, Loader2, Save, Star, CreditCard, Sparkles, Mail, Link, Unlink, ScanLine, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const TIMEZONES = [
  "Asia/Qatar",
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Kuwait",
  "Asia/Bahrain",
  "Asia/Muscat",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Africa/Cairo",
  "America/Sao_Paulo",
];

export default function SettingsPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [timezone, setTimezone] = useState(user?.timezone || "Asia/Qatar");

  useEffect(() => {
    if (user) setTimezone(user.timezone);
  }, [user]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmailConnected") === "1") {
      toast({ title: "Gmail connected", description: "Your Gmail is now connected. Run a scan to find trials." });
      window.history.replaceState({}, "", "/settings");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    }
    if (params.get("gmailError")) {
      toast({ title: "Gmail connection failed", description: "Something went wrong. Please try again.", variant: "destructive" });
      window.history.replaceState({}, "", "/settings");
    }
  }, []);

  const updateMutation = useMutation({
    mutationFn: async (tz: string) => {
      await apiRequest("PATCH", "/api/auth/settings", { timezone: tz });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Settings saved" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const portalMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/billing/create-portal-session");
      return res.json();
    },
    onSuccess: (data: { url: string }) => {
      if (data.url) window.location.href = data.url;
    },
    onError: (err: any) => {
      toast({ title: "Unable to open billing portal", description: err.message, variant: "destructive" });
    },
  });

  const toggleScanningMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await apiRequest("PATCH", "/api/auth/settings", { emailScanningEnabled: enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to toggle scanning", description: err.message, variant: "destructive" });
    },
  });

  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/gmail/scan");
      return res.json();
    },
    onSuccess: (data: { found: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suggested-trials"] });
      toast({ title: "Scan complete", description: `Found ${data.found} subscription-related emails.` });
    },
    onError: (err: any) => {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/gmail/disconnect");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Gmail disconnected" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to disconnect", description: err.message, variant: "destructive" });
    },
  });

  if (!user) {
    setLocation("/auth/login");
    return null;
  }

  const planLabels: Record<string, string> = { FREE: "Free", PLUS: "Plus", PRO: "Pro", PREMIUM: "Premium" };
  const planLabel = planLabels[user.plan] || user.plan;
  const isPaid = user.plan !== "FREE";
  const isPro = user.plan === "PRO" || user.plan === "PREMIUM";

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
          <CardHeader>
            <CardTitle>Settings</CardTitle>
            <CardDescription>Manage your account preferences</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Email</Label>
              <p className="text-sm text-muted-foreground" data-testid="text-email">{user.email}</p>
            </div>

            <div className="space-y-2">
              <Label>Timezone</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger data-testid="select-timezone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Reminders are scheduled at 10:00 AM in your timezone.
              </p>
            </div>

            <Button
              onClick={() => updateMutation.mutate(timezone)}
              disabled={updateMutation.isPending}
              data-testid="button-save-settings"
            >
              {updateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save settings
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Your Plan</CardTitle>
              <Badge variant={isPaid ? "default" : "secondary"} data-testid="badge-plan">
                {planLabel}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {isPaid ? (
              <>
                <p className="text-sm text-muted-foreground">
                  You're on the <span className="font-medium text-foreground">{planLabel}</span> plan.
                  {user.currentPeriodEnd && (
                    <> Renews on {new Date(user.currentPeriodEnd).toLocaleDateString()}.</>
                  )}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => portalMutation.mutate()}
                  disabled={portalMutation.isPending}
                  data-testid="button-manage-billing"
                >
                  {portalMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : (
                    <CreditCard className="h-4 w-4 mr-1" />
                  )}
                  Manage Billing
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  You're on the Free plan (3 active trials). Upgrade for unlimited trials.
                </p>
                <Button
                  size="sm"
                  onClick={() => setLocation("/pricing")}
                  data-testid="button-upgrade"
                >
                  <Sparkles className="h-4 w-4 mr-1" />
                  View Plans
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-email-scanning">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Email Scanning</CardTitle>
                <Badge variant="outline" className="text-xs">Pro</Badge>
              </div>
              {isPro && (
                <Switch
                  checked={user.emailScanningEnabled}
                  onCheckedChange={(v) => toggleScanningMutation.mutate(v)}
                  disabled={toggleScanningMutation.isPending}
                  data-testid="switch-email-scanning"
                />
              )}
            </div>
            <CardDescription>
              Automatically find free trials from your inbox.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!isPro ? (
              <div className="flex items-center justify-between gap-3 p-3 rounded-md bg-muted/50">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Lock className="h-4 w-4 shrink-0" />
                  <span>Upgrade to Pro to enable Gmail scanning.</span>
                </div>
                <Button size="sm" onClick={() => setLocation("/pricing")} data-testid="button-upgrade-for-scanning">
                  <Sparkles className="h-4 w-4 mr-1" />
                  Upgrade
                </Button>
              </div>
            ) : !user.emailScanningEnabled ? (
              <p className="text-sm text-muted-foreground">
                Enable the toggle above to connect your Gmail and start scanning for subscription emails.
              </p>
            ) : !user.gmailConnected ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Connect your Gmail to start scanning for subscription emails.
                </p>
                <Button
                  size="sm"
                  onClick={() => { window.location.href = "/api/gmail/connect"; }}
                  data-testid="button-connect-gmail"
                >
                  <Link className="h-4 w-4 mr-1" />
                  Connect Gmail
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="default" className="text-xs bg-green-600 hover:bg-green-600" data-testid="badge-gmail-connected">
                    Connected
                  </Badge>
                  {user.lastEmailScanAt && (
                    <span className="text-xs text-muted-foreground">
                      Last scan: {new Date(user.lastEmailScanAt).toLocaleString()}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    onClick={() => scanMutation.mutate()}
                    disabled={scanMutation.isPending}
                    data-testid="button-scan-now"
                  >
                    {scanMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <ScanLine className="h-4 w-4 mr-1" />
                    )}
                    Scan Now
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => disconnectMutation.mutate()}
                    disabled={disconnectMutation.isPending}
                    data-testid="button-disconnect-gmail"
                  >
                    {disconnectMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <Unlink className="h-4 w-4 mr-1" />
                    )}
                    Disconnect
                  </Button>
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground border-t pt-3">
              Optional and opt-in. We only scan subscription-related emails using keywords. We store minimal metadata — no email content. You can disconnect anytime.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reminder policy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              For each trial, we automatically schedule three reminders:
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                3 days before the trial ends
              </li>
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                2 days before the trial ends
              </li>
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                1 day before the trial ends
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-5 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-sm">Enjoying RecallTrial?</h3>
              <p className="text-xs text-muted-foreground">Share your experience and help others discover us.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setLocation("/review/new")} data-testid="link-leave-review">
              <Star className="h-4 w-4 mr-1" />
              Leave a Review
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
