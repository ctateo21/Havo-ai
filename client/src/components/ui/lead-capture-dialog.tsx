import { useState, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mail, Phone, KeyRound, CheckCircle2, Loader2, User, Users } from "lucide-react";
import { getStoredReferralSource } from "@/components/referral-source-dialog";
import {MARKETING_CONSENT_TEXT} from "@shared/marketing-consent";

// ─── Agent config ──────────────────────────────────────────────────────────

const AGENTS = [
  { id: "christian", name: "Christian Tateo", initials: "CT" },
  { id: "omar",      name: "Omar Andjuar",    initials: "OA" },
  { id: "kyle",      name: "Kyle Schweinitz", initials: "KS" },
  { id: "team",      name: "Team",            initials: "TM", isTeam: true },
] as const;

type AgentId = typeof AGENTS[number]["id"];

// ─── Props ─────────────────────────────────────────────────────────────────

interface LeadCaptureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: "share" | "save" | "new-scenario";
  address?: string;
  scenarioDetails?: string;
  onSuccess: () => void;
}

type Step = "agent" | "info" | "verify" | "done";

// Agent picker step is hidden for now — every lead defaults to the
// FUB-routed "Team" assignment (server maps "Team" → Christian
// Tateo → FUB_AGENT_IDS[1]). The AGENTS list and "agent" step are
// kept in the component so we can re-enable the picker later
// without rewriting the flow.
const DEFAULT_AGENT_NAME = "Team";

// ─── Component ─────────────────────────────────────────────────────────────

export default function LeadCaptureDialog({
  open,
  onOpenChange,
  action,
  address,
  scenarioDetails,
  onSuccess,
}: LeadCaptureDialogProps) {
  const [step, setStep] = useState<Step>("info");
  const [agentId, setAgentId] = useState<AgentId | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [marketingConsent,setMarketingConsent]=useState(false);

  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState("");

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      // Skip the agent picker — leads default to "Team" / FUB.
      setStep("info");
      setAgentId(null);
      setFirstName(""); setLastName(""); setEmail(""); setPhone("");
      setMarketingConsent(false);
      setCode(""); setError(""); setCountdown(0);
    }
  }, [open]);

  // Focus code input on verify step
  useEffect(() => {
    if (step === "verify") setTimeout(() => codeInputRef.current?.focus(), 100);
  }, [step]);

  function startCountdown() {
    setCountdown(60);
    countdownRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(countdownRef.current!); return 0; }
        return c - 1;
      });
    }, 1000);
  }

  function formatPhone(raw: string) {
    const d = raw.replace(/\D/g, "").slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  // ── Step handlers ────────────────────────────────────────────────────────

  function handleAgentSelect(id: AgentId) {
    setAgentId(id);
    setStep("info");
  }

  async function handleInfoNext() {
    setError("");
    if (!firstName.trim()) return setError("Please enter your first name.");
    if (!lastName.trim()) return setError("Please enter your last name.");
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return setError("Please enter a valid email address.");
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) return setError("Please enter a valid 10-digit cell number.");

    setSending(true);
    try {
      const res = await fetch("/api/leads/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send code");

      if (!data.smsEnabled) {
        // Save explicitly unverified, without a fabricated verification code.
        const agentName = AGENTS.find(a => a.id === agentId)?.name ?? DEFAULT_AGENT_NAME;
        const verifyRes = await fetch("/api/leads/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName, lastName, email,
            phone: digits,
            marketingConsent,
            address,
            agent: agentName,
            scenarioDetails,
            referral: getStoredReferralSource() ?? undefined,
          }),
        });
        const verifyData = await verifyRes.json();
        if (!verifyRes.ok) throw new Error(verifyData.error || "Submission failed");
        setStep("done");
        setTimeout(() => { onSuccess(); onOpenChange(false); }, 1800);
      } else {
        // Twilio configured — show the SMS verify step
        setStep("verify");
        startCountdown();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleResend() {
    if (countdown > 0) return;
    setError(""); setCode("");
    const digits = phone.replace(/\D/g, "");
    setSending(true);
    try {
      const res = await fetch("/api/leads/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to resend code");
      startCountdown();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleVerify() {
    setError("");
    if (code.length !== 6) return setError("Please enter the 6-digit code.");
    setVerifying(true);
    try {
      const agentName = AGENTS.find(a => a.id === agentId)?.name ?? DEFAULT_AGENT_NAME;
      const res = await fetch("/api/leads/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName, lastName, email,
          phone: phone.replace(/\D/g, ""),
          code, address, marketingConsent,
          agent: agentName,
          scenarioDetails,
          referral: getStoredReferralSource() ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      setStep("done");
      setTimeout(() => { onSuccess(); onOpenChange(false); }, 1800);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setVerifying(false);
    }
  }

  // ── Titles ───────────────────────────────────────────────────────────────

  const title =
    action === "share" ? "Share Your Estimate" :
    action === "new-scenario" ? "Add New Property" :
    "Save This Scenario";

  const subtitle =
    action === "share"
      ? "Just a few quick details and we'll copy a shareable link."
      : action === "new-scenario"
      ? "Verify your identity once to compare up to 5 properties."
      : "Create a free account to save and revisit this scenario.";

  // ── Step indicator labels ────────────────────────────────────────────────

  // Agent step removed from the indicator — users now start at "Your Info".
  const STEPS: Step[] = ["info", "verify"];
  const stepLabels: Record<Step, string> = {
    agent: "Agent", info: "Your Info", verify: "Verify", done: "Done",
  };
  const currentIdx = step === "done" ? 3 : STEPS.indexOf(step);

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription className="text-sm">{subtitle}</DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        {step !== "done" && (
          <div className="flex items-center gap-2 mb-1">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  i < currentIdx ? "bg-primary text-white" :
                  i === currentIdx ? "bg-primary text-white" :
                  "bg-muted text-muted-foreground"
                }`}>
                  {i < currentIdx ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`h-px w-8 ${i < currentIdx ? "bg-primary" : "bg-muted"}`} />
                )}
              </div>
            ))}
            <span className="text-xs text-muted-foreground ml-1">{stepLabels[step]}</span>
          </div>
        )}

        {/* ── Step 1: Agent selection ── */}
        {step === "agent" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Who are you working with?</p>
            <div className="grid grid-cols-2 gap-2.5">
              {AGENTS.map(agent => (
                <button
                  key={agent.id}
                  onClick={() => handleAgentSelect(agent.id)}
                  className="flex flex-col items-center gap-2.5 p-4 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 transition-all group"
                >
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold text-white shadow-sm ${
                    agent.id === "team" ? "bg-secondary" : "bg-primary"
                  }`}>
                    {agent.id === "team"
                      ? <Users className="h-5 w-5" />
                      : <span>{agent.initials}</span>
                    }
                  </div>
                  <span className="text-sm font-medium text-center leading-tight">{agent.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 2: Personal info + phone ──
            Agent step is hidden for now; the "Working with …" banner
            and Back-to-agent control are intentionally omitted. */}
        {step === "info" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lc-first" className="text-sm">First Name</Label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="lc-first" placeholder="Jane" className="pl-9"
                    value={firstName} onChange={e => setFirstName(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleInfoNext()}
                    autoFocus
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lc-last" className="text-sm">Last Name</Label>
                <Input
                  id="lc-last" placeholder="Smith"
                  value={lastName} onChange={e => setLastName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleInfoNext()}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="lc-email" className="text-sm">Email Address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="lc-email" type="email" placeholder="you@example.com" className="pl-9"
                  value={email} onChange={e => setEmail(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleInfoNext()}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="flex gap-2 text-xs mb-3"><input type="checkbox" checked={marketingConsent} onChange={e=>setMarketingConsent(e.target.checked)}/><span>{MARKETING_CONSENT_TEXT}</span></label>
              <Label htmlFor="lc-phone" className="text-sm">Cell Phone Number</Label>
              <p className="text-xs text-muted-foreground">We'll text you a 6-digit code to verify your number.</p>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="lc-phone" type="tel" placeholder="(555) 000-0000" className="pl-9"
                  value={phone} onChange={e => setPhone(formatPhone(e.target.value))}
                  onKeyDown={e => e.key === "Enter" && handleInfoNext()}
                />
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            {/* "Back to agent" button removed — the agent step is
                hidden, so there's nowhere to go back to. */}
            <Button className="w-full" onClick={handleInfoNext} disabled={sending}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              {sending ? "Sending…" : "Send Code"}
            </Button>
          </div>
        )}

        {/* ── Step 3: Verify SMS code ── */}
        {step === "verify" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="lc-code" className="text-sm">Verification Code</Label>
              <p className="text-xs text-muted-foreground">
                Enter the 6-digit code sent to{" "}
                <span className="font-medium text-foreground">{phone}</span>.
              </p>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="lc-code" ref={codeInputRef}
                  type="text" inputMode="numeric"
                  placeholder="000000" maxLength={6}
                  className="pl-9 text-xl tracking-[0.4em] font-mono"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={e => e.key === "Enter" && handleVerify()}
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-xs">
              <button
                className={`text-primary hover:underline ${countdown > 0 ? "opacity-40 cursor-not-allowed" : ""}`}
                onClick={handleResend} disabled={countdown > 0 || sending}
              >
                {sending ? "Resending…" : countdown > 0 ? `Resend in ${countdown}s` : "Resend code"}
              </button>
              <button
                className="text-muted-foreground hover:text-foreground"
                onClick={() => { setError(""); setStep("info"); }}
              >
                Change info
              </button>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button
              className="w-full" onClick={handleVerify}
              disabled={verifying || code.length !== 6}
            >
              {verifying ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              Verify &amp; {action === "share" ? "Get Link" : "Save"}
            </Button>
          </div>
        )}

        {/* ── Done ── */}
        {step === "done" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 className="h-12 w-12 text-green-500" />
            <p className="font-semibold text-base">
              {action === "share" ? "Link copied to clipboard!" : "Scenario saved!"}
            </p>
            <p className="text-sm text-muted-foreground text-center">
              {action === "share"
                ? "Your estimate link has been copied. Share it with anyone."
                : "Your scenario has been saved to your account."}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
