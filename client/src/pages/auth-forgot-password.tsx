import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import { Bell, Loader2, CheckCircle2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function AuthForgotPassword() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await apiRequest("POST", "/api/auth/forgot-password", { email });
      setSent(true);
    } catch (err: any) {
      toast({ title: "Error", description: err.message || "Something went wrong", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <Bell className="h-6 w-6 text-primary" />
          <span className="font-bold text-lg">RecallTrial</span>
        </div>
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>
              {sent
                ? "Check your email for a reset link"
                : "Enter your email and we'll send you a reset link"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="text-center space-y-4">
                <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
                <p className="text-sm text-muted-foreground" data-testid="text-reset-sent">
                  If an account exists with that email, you'll receive a password reset link shortly. Check your spam folder if you don't see it.
                </p>
                <Link href="/auth/login">
                  <Button variant="outline" className="w-full mt-2" data-testid="link-back-to-login">
                    Back to login
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      data-testid="input-email"
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading} data-testid="button-send-reset">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send reset link"}
                  </Button>
                </form>
                <p className="text-sm text-center text-muted-foreground mt-4">
                  Remember your password?{" "}
                  <Link href="/auth/login" className="text-primary font-medium hover:underline" data-testid="link-login">
                    Log in
                  </Link>
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
