import { useState } from "react";
import {MARKETING_CONSENT_TEXT} from "@shared/marketing-consent";
import { useLocation } from "wouter";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  login,
  normalizeDateOfBirth,
  register,
  requestPasswordReset,
} from "@/lib/auth";
import { trackEvent } from "@/lib/posthog";
import { useAuth } from "@/context/auth-context";

// Default agent assigned to every newly-registered user. Routed to
// Christian Tateo's FUB account by the server (see
// createFollowUpBossContact in server/routes.ts, which maps "Team"
// → Christian → FUB_AGENT_IDS[1]). The full agent-picker UI is
// hidden for now per product decision; this single default keeps
// all new leads flowing into the same FUB destination.
const DEFAULT_AGENT_NAME = "Team";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: "signin" | "register";
  /** Called after auth succeeds and the in-memory session is ready. Useful
   *  for replaying a protected action without racing the dialog close. */
  onAuthenticated?: () => void;
  /** Most registrations go to the dashboard. Protected inline actions stay
   *  on the current page so their queued action can finish. */
  redirectAfterRegister?: boolean;
}

export default function AuthDialog({
  open,
  onOpenChange,
  defaultTab = "signin",
  onAuthenticated,
  redirectAfterRegister = true,
}: AuthDialogProps) {
  const { refresh } = useAuth();
  const [, setLocation] = useLocation();

  // "tabs" = normal Sign In / Create Account; "forgot" = reset-request view.
  const [mode, setMode] = useState<"tabs" | "forgot">("tabs");

  // Sign-in state
  const [siEmail, setSiEmail] = useState("");
  const [siPassword, setSiPassword] = useState("");
  const [siError, setSiError] = useState("");
  const [siLoading, setSiLoading] = useState(false);

  // Register state
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [marketingConsent,setMarketingConsent]=useState(false);
  const [regDateOfBirth, setRegDateOfBirth] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");
  const [regError, setRegError] = useState("");
  const [regLoading, setRegLoading] = useState(false);

  // Forgot-password state
  const [fpEmail, setFpEmail] = useState("");
  const [fpError, setFpError] = useState("");
  const [fpLoading, setFpLoading] = useState(false);
  const [fpSent, setFpSent] = useState(false);

  function formatPhone(raw: string) {
    const d = raw.replace(/\D/g, "").slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  // Reset transient view state whenever the dialog closes so it always
  // re-opens on the tabs view with a clean forgot-password form.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setMarketingConsent(false);
      setMode("tabs");
      setFpEmail(""); setFpError(""); setFpSent(false);
    }
    onOpenChange(next);
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSiError("");
    if (!EMAIL_RE.test(siEmail.trim())) {
      setSiError("Please enter a valid email address.");
      return;
    }
    setSiLoading(true);
    const result = await login(siEmail, siPassword);
    setSiLoading(false);
    if (!result.ok) { setSiError(result.error || "Login failed."); return; }
    trackEvent("account_signed_in");
    refresh();
    onAuthenticated?.();
    handleOpenChange(false);
    // reset
    setSiEmail(""); setSiPassword("");
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setRegError("");
    if (!regName.trim()) { setRegError("Please enter your name."); return; }
    if (!EMAIL_RE.test(regEmail.trim())) {
      setRegError("Please enter a valid email address.");
      return;
    }
    const phoneDigits = regPhone.replace(/\D/g, "");
    if (phoneDigits.length < 10) { setRegError("Please enter a valid 10-digit cell number."); return; }
    if (!normalizeDateOfBirth(regDateOfBirth)) {
      setRegError("Please enter a valid date of birth.");
      return;
    }
    if (regPassword.length < 8) { setRegError("Password must be at least 8 characters."); return; }
    if (regPassword !== regConfirm) { setRegError("Passwords do not match."); return; }
    // Agent picker hidden for now — all new accounts default to the
    // FUB-routed "Team" assignment. See DEFAULT_AGENT_NAME above.
    setRegLoading(true);
    const result = await register(regName, regEmail, regPassword, {
      phone: phoneDigits,
      dateOfBirth: regDateOfBirth,
      agent: DEFAULT_AGENT_NAME,
      marketingConsent,
    });
    setRegLoading(false);
    if (!result.ok) { setRegError(result.error || "Registration failed."); return; }
    trackEvent("account_created");
    refresh();
    onAuthenticated?.();
    handleOpenChange(false);
    // reset
    setRegName(""); setRegEmail(""); setRegPhone(""); setRegDateOfBirth(""); setRegPassword(""); setRegConfirm("");
    // Free access — no payment step. Drop the new user straight into their
    // dashboard so they can start running quotes right away.
    if (redirectAfterRegister) setLocation("/dashboard");
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setFpError("");
    if (!EMAIL_RE.test(fpEmail.trim())) {
      setFpError("Please enter a valid email address.");
      return;
    }
    setFpLoading(true);
    const result = await requestPasswordReset(fpEmail);
    setFpLoading(false);
    if (!result.ok) { setFpError(result.error || "Something went wrong. Please try again."); return; }
    // Generic success — never reveal whether the email exists.
    setFpSent(true);
  }

  function backToSignIn() {
    setMode("tabs");
    setFpError(""); setFpSent(false);
  }

  const title = mode === "forgot"
    ? "Reset your password"
    : defaultTab === "register"
      ? "Create a free account to save this estimate"
      : "Welcome back to Havo";

  const description = mode === "forgot"
    ? "Enter your email and we'll send you a password reset link."
    : defaultTab === "register"
      ? "Run your numbers for free. Create an account only when you want to save, download, or send your estimate."
      : "Sign in to save, download, and revisit your property scenarios.";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {mode === "forgot" ? (
          /* ── Forgot password ── */
          <div className="mt-4">
            {fpSent ? (
              <div className="space-y-4">
                <Alert className="py-3">
                  <AlertDescription>
                    If an account exists for this email, a password reset link has been sent.
                  </AlertDescription>
                </Alert>
                <Button type="button" variant="outline" className="w-full" onClick={backToSignIn}>
                  Back to Sign In
                </Button>
              </div>
            ) : (
              <form onSubmit={handleForgot} className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="fp-email">Email</Label>
                  <Input
                    id="fp-email"
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    value={fpEmail}
                    onChange={e => setFpEmail(e.target.value)}
                    required
                    autoComplete="username"
                  />
                </div>
                {fpError && (
                  <Alert variant="destructive" className="py-2">
                    <AlertDescription>{fpError}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" className="w-full" disabled={fpLoading}>
                  {fpLoading ? "Sending…" : "Send Reset Link"}
                </Button>
                <button
                  type="button"
                  onClick={backToSignIn}
                  className="block w-full text-center text-xs text-muted-foreground hover:text-foreground"
                >
                  Back to Sign In
                </button>
              </form>
            )}
          </div>
        ) : (
          <Tabs defaultValue={defaultTab} className="mt-2">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="signin">Sign In</TabsTrigger>
              <TabsTrigger value="register">Create Account</TabsTrigger>
            </TabsList>

            {/* ── Sign In ── */}
            <TabsContent value="signin" className="mt-4">
              <form onSubmit={handleSignIn} className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="si-email">Email</Label>
                  <Input
                    id="si-email"
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    value={siEmail}
                    onChange={e => setSiEmail(e.target.value)}
                    required
                    autoComplete="username"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="si-password">Password</Label>
                  <Input
                    id="si-password"
                    name="password"
                    type="password"
                    placeholder="••••••••"
                    value={siPassword}
                    onChange={e => setSiPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { setMode("forgot"); setFpEmail(siEmail); }}
                  className="block text-left text-xs text-primary hover:underline"
                >
                  Forgot Password?
                </button>
                {siError && (
                  <Alert variant="destructive" className="py-2">
                    <AlertDescription>{siError}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" className="w-full" disabled={siLoading}>
                  {siLoading ? "Signing in…" : "Sign In"}
                </Button>
              </form>
            </TabsContent>

            {/* ── Create Account ── */}
            <TabsContent value="register" className="mt-4">
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="reg-name">Full Name</Label>
                  <Input
                    id="reg-name"
                    name="name"
                    type="text"
                    placeholder="Jane Smith"
                    value={regName}
                    onChange={e => setRegName(e.target.value)}
                    required
                    autoComplete="name"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reg-email">Email</Label>
                  <Input
                    id="reg-email"
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    value={regEmail}
                    onChange={e => setRegEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reg-phone">Cell Phone</Label>
                  <Input
                    id="reg-phone"
                    name="tel"
                    type="tel"
                    placeholder="(555) 000-0000"
                    value={regPhone}
                    onChange={e => setRegPhone(formatPhone(e.target.value))}
                    required
                    autoComplete="tel"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reg-date-of-birth">Date of Birth</Label>
                  <Input
                    id="reg-date-of-birth"
                    name="bday"
                    type="date"
                    min="1900-01-01"
                    max={new Date().toISOString().slice(0, 10)}
                    value={regDateOfBirth}
                    onChange={e => setRegDateOfBirth(e.target.value)}
                    required
                    autoComplete="bday"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Required by insurance carriers when you request live quotes.
                  </p>
                </div>
                <div className="space-y-1">
                  <label className="flex gap-2 text-xs mb-3"><input type="checkbox" checked={marketingConsent} onChange={e=>setMarketingConsent(e.target.checked)}/><span>{MARKETING_CONSENT_TEXT}</span></label>
                  <Label htmlFor="reg-password">Password</Label>
                  <Input
                    id="reg-password"
                    name="new-password"
                    type="password"
                    placeholder="At least 8 characters"
                    value={regPassword}
                    onChange={e => setRegPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reg-confirm">Confirm Password</Label>
                  <Input
                    id="reg-confirm"
                    name="new-password"
                    type="password"
                    placeholder="••••••••"
                    value={regConfirm}
                    onChange={e => setRegConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Your browser or phone may ask if you want to save this login.
                </p>
                {/* Agent picker intentionally hidden for now — every
                    new account is auto-assigned to the FUB-routed
                    "Team" default. The picker UI and AGENTS list are
                    kept in source for future re-enablement; users can
                    also change their assigned agent later from
                    /settings, which is left untouched. */}
                {regError && (
                  <Alert variant="destructive" className="py-2">
                    <AlertDescription>{regError}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" className="w-full" disabled={regLoading}>
                  {regLoading ? "Creating account…" : "Create Account"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
