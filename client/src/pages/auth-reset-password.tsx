import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link, useLocation } from "wouter";
import { Bell, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function AuthResetPassword() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");

  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setLocation("/auth/login?reset=success"), 3000);
      return () => clearTimeout(timer);
    }
  }, [success, setLocation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast({ title: "Passwords don't match", description: "Please make sure both passwords are the same.", variant: "destructive" });
      return;
    }
    if (password.length < 8) {
      toast({ title: "Password too short", description: "Password must be at least 8 characters.", variant: "destructive" });
      return;
    }
    setLoading(true);
    setTokenError(null);
    try {
      await apiRequest("POST", "/api/auth/reset-password", { token, password });
      setSuccess(true);
    } catch (err: any) {
      setTokenError(err.message || "Invalid or expired reset link. Please request a new one.");
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
            <CardTitle>{success ? "Password reset!" : "Choose a new password"}</CardTitle>
            <CardDescription>
              {success
                ? "Your password has been updated successfully"
                : "Enter your new password below"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!token ? (
              <div className="text-center space-y-4">
                <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
                <p className="text-sm text-destructive" data-testid="text-missing-token">
                  Invalid reset link. Please request a new password reset.
                </p>
                <Link href="/auth/forgot-password">
                  <Button variant="outline" className="w-full" data-testid="link-request-reset">
                    Request new reset link
                  </Button>
                </Link>
              </div>
            ) : success ? (
              <div className="text-center space-y-4">
                <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
                <p className="text-sm text-muted-foreground" data-testid="text-reset-success">
                  You can now log in with your new password. Redirecting to login...
                </p>
                <Button className="w-full" onClick={() => setLocation("/auth/login?reset=success")} data-testid="button-go-to-login">
                  Go to login
                </Button>
              </div>
            ) : (
              <>
                {tokenError && (
                  <div className="mb-4 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-center space-y-2" data-testid="text-token-error">
                    <div className="flex items-center justify-center gap-2">
                      <AlertCircle className="h-4 w-4 text-destructive" />
                      <p className="text-sm text-destructive">{tokenError}</p>
                    </div>
                    <Link href="/auth/forgot-password" className="text-sm text-primary font-medium hover:underline" data-testid="link-request-new-reset">
                      Request a new reset link
                    </Link>
                  </div>
                )}
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="password">New password</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      data-testid="input-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirm password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      placeholder="Repeat your password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      minLength={8}
                      data-testid="input-confirm-password"
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading} data-testid="button-reset-password">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reset password"}
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
