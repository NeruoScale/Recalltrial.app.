import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Shield, Mail, Database, Bell, Clock, ExternalLink, ArrowRight, Zap } from "lucide-react";

export default function Landing() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user) setLocation("/dashboard");
  }, [user, setLocation]);

  if (user) return null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Bell className="h-6 w-6 text-primary" />
            <span className="font-bold text-lg" data-testid="text-brand">RecallTrial</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setLocation("/auth/login")} data-testid="link-login">
              Log in
            </Button>
            <Button onClick={() => setLocation("/auth/signup")} data-testid="link-signup">
              Get Started
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="py-20 md:py-32 px-4">
          <div className="max-w-3xl mx-auto text-center">
            <Badge variant="secondary" className="mb-6">
              <Zap className="h-3 w-3 mr-1" />
              100% Free during Early Access
            </Badge>
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6" data-testid="text-headline">
              Never get charged for a free trial again.
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground mb-10 max-w-2xl mx-auto" data-testid="text-subtext">
              Add a trial in seconds. Get reminders with the cancel link before renewal.
            </p>
            <Button
              size="lg"
              className="text-base px-8"
              onClick={() => setLocation("/auth/signup")}
              data-testid="button-cta"
            >
              Get Started Free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </section>

        <section className="py-16 px-4 bg-muted/30">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-2xl font-bold text-center mb-12">How it works</h2>
            <div className="grid md:grid-cols-3 gap-6">
              <Card className="text-center">
                <CardContent className="pt-6 pb-6">
                  <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <Clock className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-semibold mb-2">Add a trial</h3>
                  <p className="text-sm text-muted-foreground">
                    Search for the service, pick dates, and we'll auto-fill the cancel link. Takes 20 seconds.
                  </p>
                </CardContent>
              </Card>
              <Card className="text-center">
                <CardContent className="pt-6 pb-6">
                  <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <Mail className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-semibold mb-2">Get reminders</h3>
                  <p className="text-sm text-muted-foreground">
                    Receive email reminders 3 days and 1 day before renewal.<br />
                    Add it to your calendar instantly so you never miss it.
                  </p>
                </CardContent>
              </Card>
              <Card className="text-center">
                <CardContent className="pt-6 pb-6">
                  <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <ExternalLink className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-semibold mb-2">Cancel easily</h3>
                  <p className="text-sm text-muted-foreground">
                    One-click open the cancel page. Mark it canceled and you're done.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        <section className="py-16 px-4">
          <div className="max-w-2xl mx-auto text-center mb-10">
            <Badge variant="secondary" className="mb-4">
              <Zap className="h-3 w-3 mr-1" />
              Early Access
            </Badge>
            <h2 className="text-2xl font-bold mb-3">100% Free during Early Access</h2>
            <p className="text-muted-foreground">
              Track up to 3 active trials completely free. No credit card required.
            </p>
          </div>
        </section>

        <section className="py-16 px-4" data-testid="section-founder-story">
          <div className="max-w-[680px] mx-auto">
            <h2 className="text-2xl font-bold text-center mb-8">Why I Built RecallTrial</h2>
            <div className="bg-muted/40 rounded-md p-8 md:p-10">
              <div className="border-l-2 border-primary/30 pl-6 space-y-4">
                <p className="text-base md:text-lg text-foreground/90 leading-relaxed">
                  I kept forgetting to cancel free trials and got charged more than once.
                </p>
                <p className="text-base md:text-lg text-foreground/90 leading-relaxed">
                  It wasn't about the money — it was about losing control over something avoidable.
                </p>
                <p className="text-base md:text-lg text-foreground/90 leading-relaxed">
                  So I built RecallTrial to make sure that never happens again — for me or anyone else.
                </p>
                <p className="text-base md:text-lg font-medium text-foreground mt-6">— Founder</p>
              </div>
            </div>
          </div>
        </section>

        <section className="py-16 px-4 bg-muted/30">
          <div className="max-w-2xl mx-auto">
            <h2 className="text-2xl font-bold text-center mb-8">Built on trust</h2>
            <div className="space-y-4">
              {[
                { icon: Shield, title: "No bank access required", desc: "We never ask for your payment details or bank credentials." },
                { icon: Mail, title: "Email scanning is optional", desc: "Coming later as an opt-in feature. Your inbox stays private." },
                { icon: Database, title: "You control your data", desc: "Delete your account and all data anytime. No questions asked." },
              ].map((item) => (
                <Card key={item.title}>
                  <CardContent className="flex items-start gap-4 py-4">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <item.icon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{item.title}</h3>
                      <p className="text-sm text-muted-foreground">{item.desc}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t py-8 px-4">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            <span className="font-medium text-foreground">RecallTrial</span>
          </div>
          <p data-testid="text-footer">&copy; 2026 RecallTrial - All Rights Reserved</p>
        </div>
      </footer>
    </div>
  );
}
