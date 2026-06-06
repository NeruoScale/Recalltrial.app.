import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Sparkles, Loader2 } from "lucide-react";

type PriceInfo = { priceId: string; amount: number };
type PricesData = {
  pro: { monthly: PriceInfo; yearly: PriceInfo };
  premium: { monthly: PriceInfo; yearly: PriceInfo };
};

interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UpgradeModal({ open, onOpenChange }: UpgradeModalProps) {
  const [, setLocation] = useLocation();

  const { data: prices } = useQuery<PricesData>({
    queryKey: ["/api/billing/prices"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: open,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Upgrade your plan
          </DialogTitle>
          <DialogDescription>
            You've reached the free limit (5 active trials). Upgrade to Pro or Premium for unlimited trials.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          <Button
            className="w-full"
            disabled={checkoutMutation.isPending || !prices?.pro?.monthly?.priceId}
            onClick={() => prices?.pro?.monthly?.priceId && checkoutMutation.mutate(prices.pro.monthly.priceId)}
            data-testid="button-modal-upgrade-pro"
          >
            {checkoutMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            Pro — $4.99/mo (Unlimited trials)
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={checkoutMutation.isPending || !prices?.premium?.monthly?.priceId}
            onClick={() => prices?.premium?.monthly?.priceId && checkoutMutation.mutate(prices.premium.monthly.priceId)}
            data-testid="button-modal-upgrade-premium"
          >
            Premium — $9.99/mo (Priority support)
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              onOpenChange(false);
              setLocation("/pricing");
            }}
            data-testid="button-modal-view-pricing"
          >
            View all plans
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
