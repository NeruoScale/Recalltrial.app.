import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Bell, Check, Trash2, Star as StarIcon, Award } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Review } from "@shared/schema";

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <StarIcon
          key={i}
          className={`h-3.5 w-3.5 ${i <= rating ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30"}`}
        />
      ))}
    </div>
  );
}

export default function AdminReviewsPage() {
  const [adminKey, setAdminKey] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const { toast } = useToast();

  const { data: reviews = [], isLoading, refetch } = useQuery<Review[]>({
    queryKey: ["/api/admin/reviews", adminKey],
    queryFn: async () => {
      const res = await fetch(`/api/admin/reviews?key=${encodeURIComponent(adminKey)}`);
      if (!res.ok) throw new Error("Unauthorized");
      return res.json();
    },
    enabled: authenticated,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/admin/reviews/${id}/approve?key=${encodeURIComponent(adminKey)}`),
    onSuccess: () => { refetch(); toast({ title: "Review approved" }); },
  });

  const featureMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/admin/reviews/${id}/feature?key=${encodeURIComponent(adminKey)}`),
    onSuccess: () => { refetch(); toast({ title: "Featured status toggled" }); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/admin/reviews/${id}?key=${encodeURIComponent(adminKey)}`),
    onSuccess: () => { refetch(); toast({ title: "Review deleted" }); },
  });

  const handleLogin = async () => {
    try {
      const res = await fetch(`/api/admin/reviews?key=${encodeURIComponent(adminKey)}`);
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
              <Bell className="h-5 w-5 text-primary" />
              Admin Reviews
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
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-2">
          <Bell className="h-6 w-6 text-primary" />
          <span className="font-bold text-lg">Admin - Reviews</span>
          <Badge variant="secondary" className="ml-2">{reviews.length} total</Badge>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        {isLoading ? (
          <div className="text-center text-muted-foreground py-12">Loading...</div>
        ) : reviews.length === 0 ? (
          <div className="text-center text-muted-foreground py-12">No reviews yet.</div>
        ) : (
          <div className="space-y-3">
            {reviews.map((review) => (
              <Card key={review.id} data-testid={`admin-review-${review.id}`}>
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <StarRating rating={review.rating} />
                        {review.isApproved ? (
                          <Badge variant="default" className="text-xs">Approved</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">Pending</Badge>
                        )}
                        {review.isFeatured && (
                          <Badge variant="outline" className="text-xs"><Award className="h-3 w-3 mr-1" />Featured</Badge>
                        )}
                        <Badge variant="outline" className="text-xs">{review.source}</Badge>
                      </div>
                      <p className="text-sm mb-2">"{review.text}"</p>
                      <div className="text-xs text-muted-foreground">
                        {review.name || "Anonymous"}{review.location ? ` · ${review.location}` : ""}
                        {" · "}
                        {new Date(review.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {!review.isApproved && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => approveMutation.mutate(review.id)}
                          disabled={approveMutation.isPending}
                          data-testid={`button-approve-${review.id}`}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => featureMutation.mutate(review.id)}
                        disabled={featureMutation.isPending}
                        data-testid={`button-feature-${review.id}`}
                      >
                        <Award className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => deleteMutation.mutate(review.id)}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-${review.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
