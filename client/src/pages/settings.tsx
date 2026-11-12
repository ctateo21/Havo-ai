import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Helmet } from "react-helmet";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import {
  updateProfile, updatePassword, inviteUser, removeInvitedUser, AGENTS,
} from "@/lib/auth";
import { User, Lock, UserPlus, Trash2, Loader2, Users } from "lucide-react";

function formatPhone(raw: string) {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function Settings() {
  const { user, refresh } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    if (!user) setLocation("/");
  }, [user, setLocation]);

  // ── Profile state ──────────────────────────────────────────────
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [phone, setPhone] = useState(formatPhone(user?.phone ?? ""));
  const [profileError, setProfileError] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  // ── Password state ─────────────────────────────────────────────
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  // ── Working-with (assigned agent) state ────────────────────────
  // The agent the user chose at registration is stored on the profile and
  // should be editable here — NOT re-asked inside the property estimate
  // flow. `agent` field on AuthUser holds the agent display name.
  const initialAgent = AGENTS.find(a => a.name === user?.agent)?.id ?? null;
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialAgent);
  const [agentSaving, setAgentSaving] = useState(false);
  useEffect(() => {
    setSelectedAgentId(AGENTS.find(a => a.name === user?.agent)?.id ?? null);
  }, [user?.agent]);

  async function handleSaveAgent(nextId: string) {
    if (!user) return;
    const agentName = AGENTS.find(a => a.id === nextId)?.name ?? "";
    if (!agentName || agentName === user.agent) {
      setSelectedAgentId(nextId);
      return;
    }
    setSelectedAgentId(nextId);
    setAgentSaving(true);
    const result = await updateProfile(user.email, { agent: agentName });
    setAgentSaving(false);
    if (!result.ok) {
      // Revert selection on failure.
      setSelectedAgentId(AGENTS.find(a => a.name === user.agent)?.id ?? null);
      toast({ title: "Couldn't update agent", description: result.error, variant: "destructive" });
      return;
    }
    refresh();
    toast({ title: "Agent updated", description: `You're now working with ${agentName}.` });
  }

  // ── Invite state ───────────────────────────────────────────────
  const [inviteeName, setInviteeName] = useState("");
  const [inviteeEmail, setInviteeEmail] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [inviteSaving, setInviteSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setEmail(user.email);
    setPhone(formatPhone(user.phone ?? ""));
  }, [user]);

  if (!user) return null;

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileError("");
    setProfileSaving(true);

    const previousEmail = user!.email;
    const result = await updateProfile(previousEmail, { name, email, phone });
    if (!result.ok) {
      setProfileSaving(false);
      setProfileError(result.error || "Failed to update profile.");
      return;
    }

    // Push the change to FollowUpBoss so the agent's contact stays in sync.
    try {
      const trimmed = name.trim();
      const [first, ...rest] = trimmed.split(/\s+/);
      const firstName = first || email.split("@")[0];
      const lastName = rest.join(" ") || "-";
      await fetch("/api/leads/update-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previousEmail,
          firstName,
          lastName,
          email: email.trim().toLowerCase(),
          phone: phone.replace(/\D/g, ""),
          agent: user!.agent || "Team",
        }),
      });
    } catch (err) {
      console.warn("Failed to sync profile with FollowUpBoss:", err);
    }

    setProfileSaving(false);
    refresh();
    toast({ title: "Profile updated", description: "Your account details are saved." });
  }

  async function handleSavePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError("");
    if (newPw !== confirmPw) { setPwError("New passwords do not match."); return; }
    setPwSaving(true);
    const result = await updatePassword(user!.email, currentPw, newPw);
    setPwSaving(false);
    if (!result.ok) { setPwError(result.error || "Failed to update password."); return; }
    setCurrentPw(""); setNewPw(""); setConfirmPw("");
    toast({ title: "Password updated", description: "Use your new password next time you sign in." });
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError("");
    setInviteSaving(true);

    // Push to FollowUpBoss first — only save locally if the server accepts it
    let fubOk = false;
    let fubError = "";
    try {
      const [first, ...rest] = (user!.name || "").trim().split(/\s+/);
      const inviterFirstName = first || user!.email.split("@")[0];
      const inviterLastName = rest.join(" ") || "-";
      const res = await fetch("/api/leads/invite-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviterFirstName,
          inviterLastName,
          inviterEmail: user!.email,
          inviterPhone: user!.phone || "",
          agent: user!.agent || "Team",
          inviteeName: inviteeName.trim(),
          inviteeEmail: inviteeEmail.trim().toLowerCase(),
        }),
      });
      if (res.ok) {
        fubOk = true;
      } else {
        const data = await res.json().catch(() => ({}));
        fubError = data?.error || `Server error (${res.status}).`;
      }
    } catch (err: any) {
      fubError = err?.message || "Network error sending invite.";
    }

    if (!fubOk) {
      setInviteSaving(false);
      setInviteError(fubError || "Failed to send invite. Please try again.");
      return;
    }

    const result = await inviteUser(user!.email, inviteeName, inviteeEmail);
    setInviteSaving(false);
    if (!result.ok) {
      setInviteError(result.error || "Failed to save invite locally.");
      return;
    }

    setInviteeName(""); setInviteeEmail("");
    refresh();
    toast({
      title: "Invite sent!",
      description: `${inviteeName.trim()} has been added to your account and your agent has been notified.`,
    });
  }

  async function handleRemoveInvitee() {
    const result = await removeInvitedUser(user!.email);
    if (!result.ok) {
      toast({ title: "Failed to remove", description: result.error, variant: "destructive" });
      return;
    }
    refresh();
    toast({ title: "Removed", description: "Shared user removed from your account." });
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <Helmet><title>Settings · Havo</title></Helmet>

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your account, password, and shared access.</p>
      </div>

      {/* ── Profile ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <User className="h-5 w-5" /> Profile
          </CardTitle>
          <CardDescription>Update your name, email, and phone number.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="set-name">Full Name</Label>
              <Input id="set-name" value={name} onChange={e => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-email">Email Address</Label>
              <Input id="set-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-phone">Cell Phone</Label>
              <Input
                id="set-phone" type="tel" placeholder="(555) 000-0000"
                value={phone} onChange={e => setPhone(formatPhone(e.target.value))}
              />
            </div>
            {profileError && (
              <Alert variant="destructive" className="py-2"><AlertDescription>{profileError}</AlertDescription></Alert>
            )}
            <Button type="submit" disabled={profileSaving}>
              {profileSaving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              {profileSaving ? "Saving…" : "Save Changes"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ── Working With (assigned agent) ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Users className="h-5 w-5" /> Working With
          </CardTitle>
          <CardDescription>
            Choose who handles your account. You can change this anytime — we
            won't ask you again inside the property estimate flow.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {AGENTS.map(agent => (
              <button
                key={agent.id}
                type="button"
                onClick={() => handleSaveAgent(agent.id)}
                disabled={agentSaving}
                className={`flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all ${
                  selectedAgentId === agent.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                } ${agentSaving ? "opacity-60 cursor-wait" : ""}`}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold text-white ${
                  agent.id === "team" ? "bg-secondary" : "bg-primary"
                }`}>
                  {agent.id === "team"
                    ? <Users className="h-5 w-5" />
                    : <span>{agent.initials}</span>}
                </div>
                <span className="text-xs font-medium text-center leading-tight">
                  {agent.name}
                </span>
              </button>
            ))}
          </div>
          {user.agent && (
            <p className="text-xs text-muted-foreground mt-3">
              Currently working with <strong>{user.agent}</strong>
              {agentSaving && <Loader2 className="inline h-3 w-3 animate-spin ml-1.5" />}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Password ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Lock className="h-5 w-5" /> Password
          </CardTitle>
          <CardDescription>Change the password used to sign in.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSavePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="set-current-pw">Current Password</Label>
              <Input id="set-current-pw" type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} required autoComplete="current-password" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-new-pw">New Password</Label>
              <Input id="set-new-pw" type="password" placeholder="At least 8 characters" value={newPw} onChange={e => setNewPw(e.target.value)} required autoComplete="new-password" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-confirm-pw">Confirm New Password</Label>
              <Input id="set-confirm-pw" type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required autoComplete="new-password" />
            </div>
            {pwError && (
              <Alert variant="destructive" className="py-2"><AlertDescription>{pwError}</AlertDescription></Alert>
            )}
            <Button type="submit" disabled={pwSaving}>
              {pwSaving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              {pwSaving ? "Updating…" : "Update Password"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* ── Shared Access ── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <UserPlus className="h-5 w-5" /> Shared Account Access
          </CardTitle>
          <CardDescription>Invite one person (like a spouse or co-buyer) to share this account.</CardDescription>
        </CardHeader>
        <CardContent>
          {user.invitedUser ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
                <div>
                  <p className="font-semibold">{user.invitedUser.name}</p>
                  <p className="text-sm text-muted-foreground">{user.invitedUser.email}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Invited {new Date(user.invitedUser.invitedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={handleRemoveInvitee} className="text-destructive hover:text-destructive">
                  <Trash2 className="h-4 w-4 mr-1.5" /> Remove
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Only one person can share your account. Remove this user to invite someone else.
              </p>
            </div>
          ) : (
            <form onSubmit={handleInvite} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="set-invitee-name">Full Name</Label>
                <Input
                  id="set-invitee-name" placeholder="Jane Smith"
                  value={inviteeName} onChange={e => setInviteeName(e.target.value)} required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="set-invitee-email">Email Address</Label>
                <Input
                  id="set-invitee-email" type="email" placeholder="jane@example.com"
                  value={inviteeEmail} onChange={e => setInviteeEmail(e.target.value)} required
                />
              </div>
              {inviteError && (
                <Alert variant="destructive" className="py-2"><AlertDescription>{inviteError}</AlertDescription></Alert>
              )}
              <Button type="submit" disabled={inviteSaving}>
                {inviteSaving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                {inviteSaving ? "Sending invite…" : "Send Invite"}
              </Button>
              <Separator className="my-2" />
              <p className="text-xs text-muted-foreground">
                Your assigned agent will be notified and the invited person will be added to your agent's contact list.
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
