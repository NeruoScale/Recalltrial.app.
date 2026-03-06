import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Shield, Mail, Database, Bell, Clock, ExternalLink, ArrowRight, Zap, Star, Check } from "lucide-react";
import type { Review } from "@shared/schema";
import screenshotDashboard from "@assets/Screenshot_2026-03-06_033344_1772839862379.png";
import screenshotDetail from "@assets/Screenshot_2026-03-06_033404_1772839862377.png";
import screenshotSettings from "@assets/Screenshot_2026-03-06_033241_1772839862379.png";

const heroScreenshots = [
  { src: screenshotDashboard, alt: "RecallTrial dashboard showing tracked trials" },
  { src: screenshotDetail, alt: "Trial detail with reminders" },
  { src: screenshotSettings, alt: "Settings and Gmail email scanning" },
];

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${i <= rating ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30"}`}
        />
      ))}
    </div>
  );
}

export default function Landing() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [activeSlide, setActiveSlide] = useState(0);
  const { data: featuredReviews = [] } = useQuery<Review[]>({
    queryKey: ["/api/reviews/featured"],
    retry: 3,
  });

  useEffect(() => {
    if (user) setLocation("/dashboard");
  }, [user, setLocation]);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % heroScreenshots.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

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
        <section className="py-16 md:py-24 px-4">
          <div className="max-w-3xl mx-auto flex flex-col items-center text-center">
            <Badge variant="secondary" className="mb-5">
              <Zap className="h-3 w-3 mr-1" />
              Start Free — No credit card required
            </Badge>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-tight" data-testid="text-headline">
              Never get charged for a free trial again.
            </h1>
            <p className="text-lg text-muted-foreground mb-8 max-w-md" data-testid="text-subtext">
              Track trials in seconds and get reminders before they renew.
            </p>
            <Button
              size="lg"
              className="text-base px-8 mb-3"
              onClick={() => setLocation("/auth/signup")}
              data-testid="button-cta"
            >
              Start Tracking My Trials
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <p className="text-sm text-muted-foreground mb-6">Free plan · No credit card required</p>
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-6 mb-10">
              {[
                "Free plan available",
                "Takes less than 20 seconds",
                "No bank connection required",
              ].map((bullet) => (
                <div key={bullet} className="flex items-center gap-2 text-sm text-foreground/80">
                  <Check className="h-4 w-4 text-primary shrink-0" />
                  <span>{bullet}</span>
                </div>
              ))}
            </div>
            <div className="w-full max-w-2xl" data-testid="img-hero-screenshot">
              <div className="relative rounded-xl border shadow-xl overflow-hidden bg-white">
                {heroScreenshots.map((shot, i) => (
                  <img
                    key={i}
                    src={shot.src}
                    alt={shot.alt}
                    className="w-full h-auto block absolute top-0 left-0 transition-opacity duration-700"
                    style={{ opacity: i === activeSlide ? 1 : 0, position: i === 0 ? "relative" : "absolute" }}
                  />
                ))}
              </div>
              <div className="flex justify-center gap-2 mt-4">
                {heroScreenshots.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveSlide(i)}
                    data-testid={`button-slide-${i}`}
                    className={`h-1.5 rounded-full transition-all duration-300 ${i === activeSlide ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/30"}`}
                    aria-label={`Go to screenshot ${i + 1}`}
                  />
                ))}
              </div>
            </div>
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

        {featuredReviews.length > 0 ? (
          <section className="py-16 px-4 bg-muted/20" data-testid="section-reviews">
            <div className="max-w-4xl mx-auto">
              <h2 className="text-2xl font-bold text-center mb-2">What People Say</h2>
              <p className="text-center text-muted-foreground mb-10">
                Trusted by people who hate surprise renewals.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {featuredReviews.slice(0, 6).map((review) => (
                  <Card key={review.id} data-testid={`card-review-${review.id}`}>
                    <CardContent className="py-5">
                      <StarRating rating={review.rating} />
                      <p className="text-sm text-foreground leading-relaxed mt-3 mb-3">"{review.text}"</p>
                      <div className="text-xs text-muted-foreground">
                        {review.name && <span className="font-medium text-foreground">{review.name}</span>}
                        {review.name && review.location && <span> · </span>}
                        {review.location && <span>{review.location}</span>}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <div className="text-center mt-8">
                <Button variant="outline" onClick={() => setLocation("/reviews")} data-testid="link-all-reviews">
                  View all reviews
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          </section>
        ) : (
          <section className="py-16 px-4 bg-muted/20" data-testid="section-reviews-static">
            <div className="max-w-4xl mx-auto">
              <h2 className="text-2xl font-bold text-center mb-2">What People Say</h2>
              <p className="text-center text-muted-foreground mb-10">
                Trusted by people who hate surprise renewals.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  { id: 's1', rating: 5, text: "RecallTrial saved me $15 on a subscription I forgot about. The email reminder was perfect!", name: "Sarah J.", location: "Early beta user" },
                  { id: 's2', rating: 5, text: "Simple, clean, and does exactly what it says. No more surprise charges for me.", name: "Mike D.", location: "Product Hunt user" },
                  { id: 's3', rating: 4, text: "The best tool for managing free trials. Highly recommended for anyone who signs up for everything!", name: "Alex P.", location: "Startup founder" },
                  { id: 's4', rating: 5, text: "I didn't realize how much I was losing from forgotten trials until I started tracking them. This saved me more than I expected.", name: "Daniel K.", location: "Early beta user" },
                  { id: 's5', rating: 5, text: "I used to screenshot trial dates and still forget. Getting reminders 3, 2, and 1 day before renewal changed everything.", name: "Sarah M.", location: "Product Hunt user" },
                  { id: 's6', rating: 5, text: "The email scanning only looks for subscription-related keywords — nothing personal. Smart reminders without the privacy concern.", name: "Ahmed R.", location: "Startup founder" }
                ].map((review) => (
                  <Card key={review.id}>
                    <CardContent className="py-5">
                      <StarRating rating={review.rating} />
                      <p className="text-sm text-foreground leading-relaxed mt-3 mb-3">"{review.text}"</p>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{review.name}</span>
                        <span> · </span>
                        <span>{review.location}</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="py-16 px-4" data-testid="section-pricing-cta">
          <div className="max-w-2xl mx-auto text-center mb-10">
            <Badge variant="secondary" className="mb-4">
              <Zap className="h-3 w-3 mr-1" />
              Pricing
            </Badge>
            <h2 className="text-2xl font-bold mb-3">Start free. Upgrade when you need more.</h2>
            <p className="text-muted-foreground mb-6">
              Free plan includes 3 active trials. Plus ($3.99/mo) and Pro ($7.99/mo) offer unlimited trials and more.
            </p>
            <Button variant="outline" onClick={() => setLocation("/pricing")} data-testid="link-pricing">
              View Plans
              <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
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
