import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Bell, ArrowLeft, Star, Loader2, CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function ReviewNewPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [rating, setRating] = useState(5);
  const [hoverRating, setHoverRating] = useState(0);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [location, setUserLocation] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/reviews/submit", {
        rating,
        text: text.trim(),
        name: name.trim() || undefined,
        location: location.trim() || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
    },
    onError: (err: any) => {
      toast({ title: err.message || "Failed to submit review", variant: "destructive" });
    },
  });

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="py-8">
            <p className="text-muted-foreground mb-4">Please log in to leave a review.</p>
            <Button onClick={() => setLocation("/auth/login")} data-testid="button-login-redirect">Log in</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="py-10 space-y-4">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
            <h2 className="text-xl font-bold">Thank you!</h2>
            <p className="text-muted-foreground" data-testid="text-review-success">
              Your review will appear after approval.
            </p>
            <Button variant="outline" onClick={() => setLocation("/dashboard")} data-testid="button-back-dashboard">
              Back to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/dashboard")} data-testid="button-back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <span className="font-bold text-lg">RecallTrial</span>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Leave a Review</CardTitle>
            <CardDescription>Share your experience with RecallTrial</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => { e.preventDefault(); submitMutation.mutate(); }}
              className="space-y-5"
            >
              <div>
                <Label className="mb-2 block">Rating</Label>
                <div className="flex gap-1" data-testid="input-rating">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setRating(i)}
                      onMouseEnter={() => setHoverRating(i)}
                      onMouseLeave={() => setHoverRating(0)}
                      className="p-0.5"
                      data-testid={`star-${i}`}
                    >
                      <Star
                        className={`h-7 w-7 transition-colors ${
                          i <= (hoverRating || rating)
                            ? "fill-yellow-400 text-yellow-400"
                            : "text-muted-foreground/30"
                        }`}
                      />
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Label htmlFor="review-text">Your Review</Label>
                <Textarea
                  id="review-text"
                  placeholder="Tell us about your experience... (10-300 characters)"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={300}
                  rows={4}
                  data-testid="input-review-text"
                />
                <p className="text-xs text-muted-foreground mt-1">{text.length}/300</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="review-name">Name (optional)</Label>
                  <Input
                    id="review-name"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={60}
                    data-testid="input-review-name"
                  />
                </div>
                <div>
                  <Label htmlFor="review-location">Location (optional)</Label>
                  <Input
                    id="review-location"
                    placeholder="City, Country"
                    value={location}
                    onChange={(e) => setUserLocation(e.target.value)}
                    maxLength={60}
                    data-testid="input-review-location"
                  />
                </div>
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={submitMutation.isPending || text.trim().length < 10}
                data-testid="button-submit-review"
              >
                {submitMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Submit Review"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
