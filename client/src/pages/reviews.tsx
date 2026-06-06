import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bell, ArrowLeft, Star } from "lucide-react";
import { useLocation } from "wouter";
import type { Review } from "@shared/schema";

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5" data-testid="stars-rating">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${i <= rating ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30"}`}
        />
      ))}
    </div>
  );
}

export default function ReviewsPage() {
  const [, setLocation] = useLocation();
  const { data: reviews = [], isLoading } = useQuery<Review[]>({
    queryKey: ["/api/reviews"],
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Bell className="h-6 w-6 text-primary" />
            <span className="font-bold text-lg">RecallTrial</span>
          </div>
          <Button variant="ghost" onClick={() => setLocation("/")} data-testid="link-back">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-12">
        <h1 className="text-3xl font-bold text-center mb-2" data-testid="text-reviews-title">What People Say</h1>
        <p className="text-center text-muted-foreground mb-10">
          Trusted by people who hate surprise renewals.
        </p>

        {isLoading ? (
          <div className="text-center text-muted-foreground py-12">Loading reviews...</div>
        ) : reviews.length === 0 ? (
          <div className="text-center text-muted-foreground py-12">No reviews yet. Be the first!</div>
        ) : (
          <div className="space-y-4">
            {reviews.map((review) => (
              <Card key={review.id} data-testid={`card-review-${review.id}`}>
                <CardContent className="py-5">
                  <div className="flex items-center justify-between mb-3">
                    <StarRating rating={review.rating} />
                  </div>
                  <p className="text-foreground leading-relaxed mb-3">"{review.text}"</p>
                  <div className="text-sm text-muted-foreground">
                    {review.name && <span className="font-medium text-foreground">{review.name}</span>}
                    {review.name && review.location && <span> · </span>}
                    {review.location && <span>{review.location}</span>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      <footer className="border-t py-8 px-4">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            <span className="font-medium text-foreground">RecallTrial</span>
          </div>
          <p>&copy; 2026 RecallTrial - All Rights Reserved</p>
        </div>
      </footer>
    </div>
  );
}
