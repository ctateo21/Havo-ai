import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/lib/supabase";
import { completePasswordReset } from "@/lib/auth";

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // null = still checking; false = no recovery session; true = ready
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  // Supabase's detectSessionInUrl exchanges the recovery token in the URL
  // for an active session. We give it a chance to land, then check.
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) {
        setHasSession(true);
      } else {
        setHasSession(false);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) {
        setHasSession(true);
      }
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (pw.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (pw !== confirm) { setError("Passwords do not match."); return; }
    setLoading(true);
    const result = await completePasswordReset(pw);
    setLoading(false);
    if (!result.ok) {
      setError(result.error || "Could not update your password.");
      return;
    }
    setDone(true);
  }

  return (
    <div className="container mx-auto px-4 py-16 flex justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Create a new password</CardTitle>
          <CardDescription>
            {done
              ? "All set."
              : "Choose a new password for your Havo account."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4">
              <Alert className="py-3">
                <AlertDescription>
                  Your password has been updated. You can now log in.
                </AlertDescription>
              </Alert>
              <Button className="w-full" onClick={() => setLocation("/dashboard")}>
                Go to Dashboard
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {hasSession === false && (
                <Alert variant="destructive" className="py-2">
                  <AlertDescription>
                    This reset link may be invalid or expired. Please request a
                    new password reset email and try again.
                  </AlertDescription>
                </Alert>
              )}
              <div className="space-y-1">
                <Label htmlFor="rp-password">New Password</Label>
                <Input
                  id="rp-password"
                  name="new-password"
                  type="password"
                  placeholder="At least 8 characters"
                  value={pw}
                  onChange={e => setPw(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rp-confirm">Confirm New Password</Label>
                <Input
                  id="rp-confirm"
                  name="new-password"
                  type="password"
                  placeholder="••••••••"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
              {error && (
                <Alert variant="destructive" className="py-2">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Updating…" : "Update Password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
