import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import Landing from "@/pages/landing";
import AuthLogin from "@/pages/auth-login";
import AuthSignup from "@/pages/auth-signup";
import Dashboard from "@/pages/dashboard";
import TrialNew from "@/pages/trial-new";
import TrialDetail from "@/pages/trial-detail";
import SettingsPage from "@/pages/settings";
import ReviewsPage from "@/pages/reviews";
import AdminReviewsPage from "@/pages/admin-reviews";
import ReviewNewPage from "@/pages/review-new";
import PricingPage from "@/pages/pricing";
import BillingSuccess from "@/pages/billing-success";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/auth/login" component={AuthLogin} />
      <Route path="/auth/signup" component={AuthSignup} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/trials/new" component={TrialNew} />
      <Route path="/trials/:id" component={TrialDetail} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/pricing" component={PricingPage} />
      <Route path="/billing/success" component={BillingSuccess} />
      <Route path="/reviews" component={ReviewsPage} />
      <Route path="/admin/reviews" component={AdminReviewsPage} />
      <Route path="/review/new" component={ReviewNewPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <Toaster />
          <Router />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
