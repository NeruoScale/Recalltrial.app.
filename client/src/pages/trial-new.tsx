import { useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Bell, ArrowLeft, CalendarIcon, Loader2, Info, Check } from "lucide-react";
import { format, addDays, differenceInDays } from "date-fns";
import { CURRENCIES, POPULAR_SERVICES } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { UpgradeModal } from "@/components/upgrade-modal";

export default function TrialNew() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [serviceName, setServiceName] = useState("");
  const [serviceUrl, setServiceUrl] = useState("");
  const [cancelUrl, setCancelUrl] = useState("");
  const [startDate, setStartDate] = useState<Date | undefined>(new Date());
  const [endDate, setEndDate] = useState<Date | undefined>(addDays(new Date(), 14));
  const [renewalPrice, setRenewalPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);

  if (!user) {
    setLocation("/auth/login");
    return null;
  }

  const filteredServices = useMemo(() => {
    if (!serviceName) return POPULAR_SERVICES;
    return POPULAR_SERVICES.filter(
      (s) => s.name.toLowerCase().includes(serviceName.toLowerCase())
    );
  }, [serviceName]);

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/trials", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trials"] });
      toast({ title: "Trial added successfully" });
      setLocation("/dashboard");
    },
    onError: (err: any) => {
      if (err.message?.includes("free limit") || err.message?.includes("PLAN_LIMIT")) {
        setUpgradeOpen(true);
      } else {
        toast({ title: "Failed to add trial", description: err.message, variant: "destructive" });
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!startDate || !endDate) {
      toast({ title: "Please select both dates", variant: "destructive" });
      return;
    }
    if (endDate < startDate) {
      toast({ title: "End date must be after start date", variant: "destructive" });
      return;
    }
    let url = serviceUrl.trim();
    if (url && !url.startsWith("http")) {
      url = "https://" + url;
    }
    if (!url) {
      toast({ title: "Please enter a service URL", variant: "destructive" });
      return;
    }

    createMutation.mutate({
      serviceName: serviceName.trim(),
      serviceUrl: url,
      cancelUrl: cancelUrl.trim() || "",
      startDate: format(startDate, "yyyy-MM-dd"),
      endDate: format(endDate, "yyyy-MM-dd"),
      renewalPrice: renewalPrice || "",
      currency,
    });
  };

  const selectService = (svc: typeof POPULAR_SERVICES[0]) => {
    setServiceName(svc.name);
    setServiceUrl(svc.url);
    setCancelUrl(svc.cancelUrl);
    setShowSuggestions(false);
  };

  const daysLeft = startDate && endDate ? differenceInDays(endDate, startDate) : null;

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

      <main className="max-w-lg mx-auto px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle>Add a free trial</CardTitle>
            <CardDescription>We'll remind you before it renews.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2 relative">
                <Label htmlFor="serviceName">Service name</Label>
                <Input
                  id="serviceName"
                  placeholder="e.g. Netflix, Spotify..."
                  value={serviceName}
                  onChange={(e) => {
                    setServiceName(e.target.value);
                    setShowSuggestions(true);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  required
                  data-testid="input-service-name"
                />
                {showSuggestions && filteredServices.length > 0 && (
                  <Card className="absolute z-10 w-full mt-1 max-h-48 overflow-y-auto">
                    <CardContent className="p-1">
                      {filteredServices.slice(0, 8).map((svc) => (
                        <button
                          key={svc.name}
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm rounded-md hover-elevate flex items-center gap-2"
                          onClick={() => selectService(svc)}
                          data-testid={`suggestion-${svc.name.toLowerCase().replace(/\s+/g, "-")}`}
                        >
                          <img
                            src={`https://www.google.com/s2/favicons?domain=${new URL(svc.url).hostname}&sz=32`}
                            alt=""
                            className="w-4 h-4 rounded-sm"
                          />
                          <span>{svc.name}</span>
                        </button>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="serviceUrl">Service URL</Label>
                <Input
                  id="serviceUrl"
                  placeholder="https://www.netflix.com"
                  value={serviceUrl}
                  onChange={(e) => setServiceUrl(e.target.value)}
                  required
                  data-testid="input-service-url"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="cancelUrl">
                  Cancel/Unsubscribe link <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="cancelUrl"
                  placeholder="Paste the cancel page link"
                  value={cancelUrl}
                  onChange={(e) => setCancelUrl(e.target.value)}
                  data-testid="input-cancel-url"
                />
                <p className="text-xs text-muted-foreground flex items-start gap-1">
                  <Info className="h-3 w-3 mt-0.5 shrink-0" />
                  If empty, we'll use the service website as the cancel link.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Start date</Label>
                  <Popover open={startOpen} onOpenChange={setStartOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn("w-full justify-start text-left font-normal", !startDate && "text-muted-foreground")}
                        data-testid="button-start-date"
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {startDate ? format(startDate, "MMM d, yyyy") : "Pick date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={startDate}
                        onSelect={(d) => {
                          setStartDate(d);
                          setStartOpen(false);
                        }}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="space-y-2">
                  <Label>End date</Label>
                  <Popover open={endOpen} onOpenChange={setEndOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn("w-full justify-start text-left font-normal", !endDate && "text-muted-foreground")}
                        data-testid="button-end-date"
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {endDate ? format(endDate, "MMM d, yyyy") : "Pick date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={endDate}
                        onSelect={(d) => {
                          setEndDate(d);
                          setEndOpen(false);
                        }}
                        disabled={(d) => startDate ? d < startDate : false}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="renewalPrice">Renewal price <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input
                    id="renewalPrice"
                    type="number"
                    step="0.01"
                    placeholder="9.99"
                    value={renewalPrice}
                    onChange={(e) => setRenewalPrice(e.target.value)}
                    data-testid="input-renewal-price"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger data-testid="select-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {startDate && endDate && endDate >= startDate && (
                <Card className="bg-muted/50">
                  <CardContent className="py-3 text-sm space-y-1">
                    <p data-testid="text-trial-preview">
                      <strong>Trial duration:</strong> {daysLeft} day{daysLeft !== 1 ? "s" : ""}
                    </p>
                    <p>
                      <strong>Trial ends:</strong> {format(endDate, "MMMM d, yyyy")}
                    </p>
                    <p className="text-muted-foreground" data-testid="text-reminder-preview">
                      <Check className="h-3 w-3 inline mr-1" />
                      We'll remind you on {format(addDays(endDate, -3), "MMM d")} and {format(addDays(endDate, -1), "MMM d")} at 10:00 AM
                    </p>
                  </CardContent>
                </Card>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={createMutation.isPending}
                data-testid="button-submit-trial"
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Add Trial"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
      <UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} />
    </div>
  );
}
