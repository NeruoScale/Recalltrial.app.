import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Layers } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ShadowSubscription } from "@shared/schema";

type ShadowSubscriptionRow = ShadowSubscription & { userEmail: string };

// Shadow-only preview: this page reads exclusively from `subscriptions`
// (isShadow=true, always resolved — see server/entityResolver.ts's
// isEligibleForShadowSubscription()). It is a read-only window into what
// the resolver currently believes, not a production feature — nothing here
// drives reminders or is shown to end users.
function formatMoney(amount: string | null, currency: string | null): string {
  if (!amount) return "—";
  return currency ? `${amount} ${currency}` : amount;
}

function formatDate(date: string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString();
}

function StatusBadge({ status }: { status: ShadowSubscription["subscriptionStatus"] }) {
  const variant =
    status === "active" ? "default" :
    status === "trial" ? "secondary" :
    status === "past_due" ? "destructive" :
    "outline";
  return <Badge variant={variant} className="text-xs capitalize">{status.replace("_", " ")}</Badge>;
}

export default function AdminSubscriptionsPage() {
  const [adminKey, setAdminKey] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const { toast } = useToast();

  const { data: rows = [], isLoading, refetch } = useQuery<ShadowSubscriptionRow[]>({
    queryKey: ["/api/admin/subscriptions", adminKey],
    queryFn: async () => {
      const res = await fetch(`/api/admin/subscriptions?key=${encodeURIComponent(adminKey)}`);
      if (!res.ok) throw new Error("Unauthorized");
      return res.json();
    },
    enabled: authenticated,
  });

  const handleLogin = async () => {
    try {
      const res = await fetch(`/api/admin/subscriptions?key=${encodeURIComponent(adminKey)}`);
      if (res.ok) {
        setAuthenticated(true);
      } else {
        toast({ title: "Invalid admin key", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error authenticating", variant: "destructive" });
    }
  };

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="h-5 w-5 text-primary" />
              Shadow Subscriptions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              type="password"
              placeholder="Enter Admin Key"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              data-testid="input-admin-key"
            />
            <Button className="w-full" onClick={handleLogin} data-testid="button-admin-login">
              Access
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-2">
          <Layers className="h-6 w-6 text-primary" />
          <span className="font-bold text-lg">Admin - Shadow Subscriptions</span>
          <Badge variant="secondary" className="ml-2">{rows.length} total</Badge>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => refetch()}>
            Refresh
          </Button>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-4 text-xs text-muted-foreground">
          Shadow only — resolved candidates from the entity resolver, never shown to end users, never drives reminders.
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {isLoading ? (
          <div className="text-center text-muted-foreground py-12">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-muted-foreground py-12">No shadow subscriptions yet.</div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead>Next renewal</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Detected via</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} data-testid={`shadow-subscription-${row.id}`}>
                    <TableCell className="text-sm text-muted-foreground">{row.userEmail}</TableCell>
                    <TableCell className="font-medium">
                      {row.canonicalMerchantName}
                      {row.canonicalMerchantDomain && (
                        <div className="text-xs text-muted-foreground">{row.canonicalMerchantDomain}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{row.planName || "—"}</TableCell>
                    <TableCell className="text-sm">{formatMoney(row.amount, row.currency)}</TableCell>
                    <TableCell className="text-sm">{row.billingInterval || "—"}</TableCell>
                    <TableCell className="text-sm">{formatDate(row.nextBillingDate)}</TableCell>
                    <TableCell><StatusBadge status={row.subscriptionStatus} /></TableCell>
                    <TableCell className="text-sm">{row.merchantConfidence ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{row.resolutionMethod}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {row.potentialFalseMerge && (
                          <Badge variant="destructive" className="text-xs">false merge?</Badge>
                        )}
                        {row.potentialFalseSplit && (
                          <Badge variant="destructive" className="text-xs">false split?</Badge>
                        )}
                        {!row.potentialFalseMerge && !row.potentialFalseSplit && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </main>
    </div>
  );
}
